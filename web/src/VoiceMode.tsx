import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Mic, Pencil, Send, Square, Volume2, X } from 'lucide-react';
import type { ChatMessage, UseChat } from './types';
import type { SessionWorkspaceState } from './SessionWorkspace';
import { Button } from './Button';
import { IconButton, ICON_STROKE } from './ui';
import { tokens } from './tokens.stylex';
import { extractSpeak, isFatalListenError, listenErrorMessage, matchOption, matchVerdict, parseVoiceIntent, setVoiceNoteOn, speakableText, splitHead, suspensionSpeech } from './speech';
import { ApiError } from './chat';
import { canListen, canSpeak, listen, speak, stopSpeaking, useSpeakingKey, type ListenResult } from './voice';

export const isVoiceSupported = canSpeak && canListen;
const COUNTDOWN_SECONDS = 3;
const VOICE_KEY = 'voice-mode';
export const SUSPENSION_RESOLVED_EVENT = 'aside:suspension-resolved';
const STORAGE_KEY = 'aside-relay:voice-mode';
const QUESTION_WAIT_MS = 8_000;

function loadVoicePreference() { try { return localStorage.getItem(STORAGE_KEY) === 'on'; } catch { return false; } }
function saveVoicePreference(isOn: boolean) { try { if (isOn) localStorage.setItem(STORAGE_KEY, 'on'); else localStorage.removeItem(STORAGE_KEY); } catch { /* storage unavailable */ } }

/** A short spoken name for a chat: the first few words of its title. */
export function spokenTitle(title: string) {
  const words = title.replace(/[\s.,:;!?…]+$/u, '').split(/\s+/).filter(Boolean);
  const short = words.slice(0, 7).join(' ');
  return (short.length > 60 ? short.slice(0, 60) : short) || 'A chat';
}

type Announcement = { sessionId: string; title: string; kind: 'finished' | 'question' | 'failed' };
type OpenMode = { sessionId?: string; mode: 'skip' | 'read' | 'question' };

type Suspension = NonNullable<SessionWorkspaceState['suspension']>;
type Phase = 'off' | 'paused' | 'idle' | 'speaking' | 'listening' | 'confirming' | 'sending';
type Pending = { label: string; detail: string; editText?: string; execute: () => Promise<boolean> };
type Reply = { key: string; text: string };

function messageText(message: ChatMessage) {
  return message.blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
}

/** The newest assistant text after the last user message. */
export function latestReply(chat: Pick<UseChat, 'messages' | 'liveAssistant'>): Reply | undefined {
  const { messages, liveAssistant } = chat;
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) if (messages[index].role === 'user') { lastUser = index; break; }
  for (let index = messages.length - 1; index > lastUser; index--) {
    const message = messages[index];
    const text = message.role === 'assistant' ? messageText(message).trim() : '';
    if (text) return { key: message.responseId ?? `seq:${message.seq}`, text };
  }
  if (liveAssistant?.done && liveAssistant.text.trim()) return { key: liveAssistant.responseId ?? `live:${liveAssistant.streamId}`, text: liveAssistant.text };
  return undefined;
}

export function useVoiceMode({ chat, suspension, notify, onEdit, onOpenSession }: {
  chat: UseChat;
  suspension?: Suspension;
  notify: (text: string, kind?: 'success' | 'error') => void;
  onEdit: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  // Voice mode survives reloads, but Android only lets a page talk after a tap, so a reload resumes as "paused".
  const [phase, setPhaseState] = useState<Phase>(() => isVoiceSupported && loadVoicePreference() ? 'paused' : 'off');
  const [heard, setHeard] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [countdown, setCountdown] = useState(0);
  const phaseRef = useRef<Phase>(phase);
  const statusesRef = useRef(new Map<string, { status: string; kind?: string; unread: boolean }>());
  const announcementsRef = useRef<Announcement[]>([]);
  const isAnnouncingRef = useRef(false);
  const openModeRef = useRef<OpenMode | undefined>(undefined);
  const requestedOpenRef = useRef<OpenMode | undefined>(undefined);
  const onOpenSessionRef = useRef(onOpenSession);
  const runRef = useRef(0);
  const stopListeningRef = useRef<(() => void) | undefined>(undefined);
  // Set after a listening error that will repeat (no speech service, mic blocked). Replies are still read aloud.
  const listenBrokenRef = useRef<string | undefined>(undefined);
  const [isListenBroken, setListenBroken] = useState(false);
  const spokenRef = useRef(new Set<string>());
  const handledRef = useRef(new Set<string>());
  const resolvedRef = useRef(new Set<string>());
  const lastReplyRef = useRef('');
  const pendingRef = useRef<Pending | undefined>(undefined);
  const chatRef = useRef(chat);
  const suspensionRef = useRef(suspension);
  const notifyRef = useRef(notify);
  const onEditRef = useRef(onEdit);
  const wasRunningRef = useRef(chat.isRunning);
  chatRef.current = chat; suspensionRef.current = suspension; notifyRef.current = notify; onEditRef.current = onEdit; onOpenSessionRef.current = onOpenSession;

  function setPhase(next: Phase) { phaseRef.current = next; setPhaseState(next); setVoiceNoteOn(next !== 'off' && next !== 'paused'); }
  function isCurrent(run: number) { return run === runRef.current && phaseRef.current !== 'off' && phaseRef.current !== 'paused'; }

  function cancelAll() {
    runRef.current++;
    stopListeningRef.current?.(); stopListeningRef.current = undefined;
    stopSpeaking();
    pendingRef.current = undefined; setPending(undefined); setCountdown(0); setHeard('');
  }

  function turnOff(shouldAnnounce = false) {
    cancelAll(); setPhase('off'); saveVoicePreference(false);
    announcementsRef.current = []; openModeRef.current = undefined; requestedOpenRef.current = undefined;
    if (shouldAnnounce) void speak(VOICE_KEY, 'Voice mode off.', { isMarkdown: false });
  }

  function turnOn(isResume = false) {
    cancelAll();
    saveVoicePreference(true);
    const run = runRef.current;
    const reply = latestReply(chatRef.current);
    if (reply) { spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); lastReplyRef.current = reply.text; }
    setPhase('speaking');
    const greeting = isResume ? 'Voice mode resumed.' : 'Voice mode on.';
    const next = !chatRef.current.sessionId ? ' Open a chat to talk.' : chatRef.current.isRunning ? ' I will read the reply when it is ready.' : ' Go ahead.';
    // This first utterance runs inside the tap, which unlocks speech on Android.
    void speak(VOICE_KEY, greeting + next, { isMarkdown: false })
      .then(() => { if (isCurrent(run)) proceed(run); });
  }

  /** Decide what to do next when nothing else is happening. */
  function proceed(run: number) {
    if (!isCurrent(run)) return;
    const current = suspensionRef.current;
    if (current && !handledRef.current.has(current.toolCallId) && !resolvedRef.current.has(current.toolCallId)) { void askSuspension(run, current); return; }
    if (announcementsRef.current.length) { void announceNext(run); return; }
    if (chatRef.current.isRunning || !chatRef.current.sessionId) { setPhase('idle'); return; }
    void listenForMessage(run);
  }

  function hasUnspokenReply() {
    if (chatRef.current.isRunning) return false;
    const reply = latestReply(chatRef.current);
    return !!reply && !spokenRef.current.has(reply.key) && !spokenRef.current.has(reply.text);
  }

  /** Announce the next chat that finished or needs an answer, when nothing in this chat is waiting. */
  function maybeAnnounce() {
    if (phaseRef.current !== 'idle' || isAnnouncingRef.current || !announcementsRef.current.length || openModeRef.current) return;
    const current = suspensionRef.current;
    if (current && !handledRef.current.has(current.toolCallId) && !resolvedRef.current.has(current.toolCallId)) return;
    if (hasUnspokenReply()) return;
    void announceNext(runRef.current);
  }

  async function announceNext(run: number) {
    if (isAnnouncingRef.current) return;
    const next = announcementsRef.current.shift();
    if (!next) { proceed(run); return; }
    isAnnouncingRef.current = true;
    try {
      const title = spokenTitle(next.title);
      const prompt = next.kind === 'question' ? `${title} needs your answer. Answer it?` : next.kind === 'failed' ? `${title} failed. Open it?` : `${title} finished. Hear it?`;
      setPhase('speaking');
      if (!await speak(VOICE_KEY, prompt, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
      const answer = await listenOnce(run);
      if (!isCurrent(run)) return;
      const intent = parseVoiceIntent(answer.transcript);
      if (intent === 'voice-off') { turnOff(true); return; }
      if (intent === 'yes') {
        requestedOpenRef.current = { sessionId: next.sessionId, mode: next.kind === 'question' ? 'question' : next.kind === 'failed' ? 'skip' : 'read' };
        setPhase('idle');
        onOpenSessionRef.current(next.sessionId);
        return;
      }
      setPhase('idle');
    } finally { isAnnouncingRef.current = false; }
    if (isCurrent(run)) { if (announcementsRef.current.length) void announceNext(run); else proceed(run); }
  }

  async function listenOnce(run: number, isManual = false): Promise<ListenResult> {
    if (isManual) { listenBrokenRef.current = undefined; setListenBroken(false); }
    // Don't retry (and don't repeat the error) on every chat change once listening is known to fail.
    if (listenBrokenRef.current) { setPhase('idle'); return { transcript: '', error: listenBrokenRef.current }; }
    setPhase('listening'); setHeard('');
    const session = listen(setHeard);
    stopListeningRef.current = session.stop;
    const result = await session.result;
    if (stopListeningRef.current === session.stop) stopListeningRef.current = undefined;
    if (result.error && isCurrent(run)) {
      const isFatal = isFatalListenError(result.error);
      if (isFatal) { listenBrokenRef.current = result.error; setListenBroken(true); }
      notifyRef.current(listenErrorMessage(result.error, window.isSecureContext) + (isFatal ? ' Replies will still be read aloud; tap Talk to try again.' : ''), 'error');
    }
    return result;
  }

  async function listenForMessage(run: number, isManual = false) {
    if (!chatRef.current.sessionId) { setPhase('idle'); return; }
    const result = await listenOnce(run, isManual);
    if (!isCurrent(run)) return;
    if (!result.transcript) { setPhase('idle'); return; }
    handleMessage(run, result.transcript);
  }

  function handleMessage(run: number, transcript: string) {
    const intent = parseVoiceIntent(transcript);
    if (intent === 'voice-off') { turnOff(true); return; }
    if (intent === 'cancel') { setHeard(''); setPhase('idle'); return; }
    if (intent === 'repeat' && lastReplyRef.current) { void speakReply(run, { key: 'repeat', text: lastReplyRef.current }, true); return; }
    startConfirm({ label: 'Sending', detail: transcript, editText: transcript, execute: () => sendMessage(transcript) });
  }

  async function sendMessage(text: string) {
    const current = chatRef.current;
    const accepted = current.isRunning || current.queuedMessages.length ? await current.queue(text) : await current.send(text);
    if (!accepted) notifyRef.current('Could not send that message. It is in the message box.', 'error');
    if (!accepted) onEditRef.current(text);
    return accepted;
  }

  async function speakReply(run: number, reply: Reply, isRepeat = false) {
    if (!isRepeat) { spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); lastReplyRef.current = reply.text; }
    const { display, spoken } = extractSpeak(reply.text);
    const full = speakableText(display);
    // A <speak> summary is read first; the full reply is offered afterwards. Without one, read the opening and offer the rest.
    const { head, rest } = spoken ? { head: spoken, rest: full.length > spoken.length * 1.5 ? full : '' } : splitHead(full);
    setPhase('speaking');
    if (!await speak(VOICE_KEY, head, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
    if (rest) {
      if (!await speak(VOICE_KEY, spoken ? 'Want the full reply?' : 'Want the rest?', { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
      const answer = await listenOnce(run);
      if (!isCurrent(run)) return;
      const intent = parseVoiceIntent(answer.transcript);
      if (intent === 'yes') {
        setPhase('speaking');
        if (!await speak(VOICE_KEY, rest, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
      } else if (intent === 'voice-off') { turnOff(true); return; }
      else if (answer.transcript && intent !== 'no' && intent !== 'cancel') { handleMessage(run, answer.transcript); return; }
    }
    proceed(run);
  }

  async function onReplyFinished(run: number) {
    let reply: Reply | undefined;
    for (const delay of [700, 1500]) {
      await new Promise(resolve => setTimeout(resolve, delay));
      if (!isCurrent(run) || phaseRef.current !== 'idle') return;
      reply = latestReply(chatRef.current);
      if (reply) break;
    }
    if (!isCurrent(run) || chatRef.current.isRunning) return;
    if (reply && !spokenRef.current.has(reply.key) && !spokenRef.current.has(reply.text)) { void speakReply(run, reply); return; }
    proceed(run);
  }

  async function askSuspension(run: number, current: Suspension) {
    handledRef.current.add(current.toolCallId);
    const reply = latestReply(chatRef.current);
    if (reply && !spokenRef.current.has(reply.key) && !spokenRef.current.has(reply.text)) {
      spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); lastReplyRef.current = reply.text;
      setPhase('speaking');
      if (!await speak(VOICE_KEY, extractSpeak(reply.text).spoken || splitHead(speakableText(extractSpeak(reply.text).display)).head, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
    }
    if (current.kind === 'ask-user-question') {
      const answers: { header: string; answer: string }[] = [];
      for (let index = 0; index < current.questions.length; index++) {
        const question = current.questions[index];
        const answer = await askOnce(run, suspensionSpeech(current, index), transcript => {
          const option = matchOption(transcript, question.options.map(item => item.label));
          return option === undefined ? `custom: ${transcript}` : question.options[option].label;
        });
        if (answer === undefined) return;
        answers.push({ header: question.title, answer });
      }
      const detail = answers.map(item => item.answer.replace(/^custom: /, '')).join('; ');
      startConfirm({ label: 'Answering', detail, execute: () => resolveSuspension(current, { answers }) });
      return;
    }
    const verdict = await askOnce(run, suspensionSpeech(current), transcript => matchVerdict(transcript, current.kind), 'Sorry. ' + (current.kind === 'approval' ? 'Say allow or deny.' : 'Say confirm or cancel.'));
    if (verdict === undefined) return;
    startConfirm({ label: verdict === 'allow' ? 'Allowing' : verdict === 'deny' ? 'Denying' : verdict === 'confirm' ? 'Confirming' : 'Canceling action', detail: current.title, execute: () => resolveSuspension(current, current.kind === 'approval' ? { verdict, always: false } : { verdict }) });
  }

  /** Speaks a prompt and listens for an answer. Returns undefined when the user cancels or stays silent. */
  async function askOnce(run: number, prompt: string, parse: (transcript: string) => string | undefined, retryPrompt?: string): Promise<string | undefined> {
    let text = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      setPhase('speaking');
      if (!await speak(VOICE_KEY, text, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return undefined; }
      const result = await listenOnce(run);
      if (!isCurrent(run)) return undefined;
      const intent = parseVoiceIntent(result.transcript);
      if (intent === 'voice-off') { turnOff(true); return undefined; }
      if (!result.transcript || intent === 'cancel') { setPhase('idle'); return undefined; }
      if (intent === 'repeat') { text = prompt; continue; }
      const parsed = parse(result.transcript);
      if (parsed !== undefined) return parsed;
      if (!retryPrompt) break;
      text = retryPrompt;
    }
    setPhase('idle');
    return undefined;
  }

  async function resolveSuspension(current: Suspension, response: Record<string, unknown>) {
    const sessionId = chatRef.current.sessionId;
    if (!sessionId) return false;
    try {
      await chatRef.current.request(`/api/native/sessions/${encodeURIComponent(sessionId)}/command`, { method: 'POST', body: JSON.stringify({ command: 'resolve-suspension', response }) });
      handledRef.current.add(current.toolCallId); resolvedRef.current.add(current.toolCallId);
      window.dispatchEvent(new CustomEvent(SUSPENSION_RESOLVED_EVENT, { detail: { sessionId, toolCallId: current.toolCallId } }));
      notifyRef.current('Answer sent - the agent is resuming.', 'success');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        handledRef.current.add(current.toolCallId); resolvedRef.current.add(current.toolCallId);
        window.dispatchEvent(new CustomEvent(SUSPENSION_RESOLVED_EVENT, { detail: { sessionId, toolCallId: current.toolCallId } }));
        notifyRef.current('That question was already answered.', 'success');
        return true;
      }
      notifyRef.current('Could not send the answer. Use Respond on screen.', 'error');
      return false;
    }
  }

  function startConfirm(next: Pending) {
    pendingRef.current = next; setPending(next); setHeard('');
    setCountdown(COUNTDOWN_SECONDS); setPhase('confirming');
  }

  async function executePending() {
    const current = pendingRef.current;
    if (!current) return;
    pendingRef.current = undefined; setPending(undefined); setCountdown(0);
    const run = runRef.current;
    setPhase('sending');
    await current.execute();
    if (isCurrent(run)) setPhase('idle');
  }

  useEffect(() => {
    if (phase !== 'confirming' || !pending) return;
    if (countdown <= 0) { void executePending(); return; }
    const timer = setTimeout(() => setCountdown(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [phase, countdown, pending]);

  // Read the reply once a run finishes.
  useEffect(() => {
    const wasRunning = wasRunningRef.current;
    wasRunningRef.current = chat.isRunning;
    if (wasRunning && !chat.isRunning && (phaseRef.current === 'idle' || phaseRef.current === 'sending')) {
      setPhase('idle');
      void onReplyFinished(runRef.current);
    }
  }, [chat.isRunning]);

  // Ask a pending question out loud as soon as voice mode is free.
  useEffect(() => {
    if (phase !== 'idle' || !suspension || handledRef.current.has(suspension.toolCallId)) return;
    void askSuspension(runRef.current, suspension);
  }, [phase, suspension?.toolCallId]);

  // Voice mode follows you between chats. Opening a chat from an announcement reads it; opening one yourself just listens.
  const isFirstSessionRef = useRef(true);
  useEffect(() => {
    spokenRef.current.clear(); handledRef.current.clear(); resolvedRef.current.clear();
    announcementsRef.current = announcementsRef.current.filter(item => item.sessionId !== chat.sessionId);
    const requested = requestedOpenRef.current;
    requestedOpenRef.current = undefined;
    if (isFirstSessionRef.current) { isFirstSessionRef.current = false; return; }
    if (phaseRef.current === 'off' || phaseRef.current === 'paused') return;
    cancelAll();
    openModeRef.current = { sessionId: chat.sessionId, mode: requested && requested.sessionId === chat.sessionId ? requested.mode : 'skip' };
    setPhase('idle');
  }, [chat.sessionId]);

  useEffect(() => {
    const open = openModeRef.current;
    if (!open || open.sessionId !== chat.sessionId || chat.isOpening || !chat.isReady || phaseRef.current !== 'idle') return;
    openModeRef.current = undefined;
    const run = runRef.current;
    const reply = latestReply(chat);
    const title = spokenTitle(chat.sessions.find(item => item.id === chat.sessionId)?.title ?? 'this chat');
    const cueThenProceed = (cue: string) => { setPhase('speaking'); void speak(VOICE_KEY, cue, { isMarkdown: false }).then(completed => { if (isCurrent(run)) { if (completed) proceed(run); else setPhase('idle'); } }); };
    if (open.mode === 'skip') { if (reply) { spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); lastReplyRef.current = reply.text; } proceed(run); return; }
    if (open.mode === 'read' && reply && !chat.isRunning) { void speakReply(run, { ...reply, text: `From ${title}. ${reply.text}` }); spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); return; }
    if (open.mode === 'question') {
      // The question arrives with the next workspace poll; the suspension effect asks it.
      setTimeout(() => {
        if (!isCurrent(run) || phaseRef.current !== 'idle') return;
        const current = suspensionRef.current;
        if (current && !resolvedRef.current.has(current.toolCallId)) return;
        cueThenProceed(`Nothing is waiting in ${title} now.${chatRef.current.isRunning ? '' : ' Go ahead.'}`);
      }, QUESTION_WAIT_MS);
      return;
    }
    // Always say which chat you are now talking to before the mic opens.
    cueThenProceed(`Opened ${title}.${chat.isRunning ? '' : ' Go ahead.'}`);
  }, [chat.isOpening, chat.isReady, chat.messages, chat.sessionId]);

  // Watch the other chats and queue announcements for ones that finish, fail or need an answer.
  useEffect(() => {
    const statuses = statusesRef.current;
    const isActive = phaseRef.current !== 'off' && phaseRef.current !== 'paused';
    for (const session of chat.sessions) {
      const state = { status: session.status, kind: session.suspensionKind, unread: session.unread };
      const previous = statuses.get(session.id);
      statuses.set(session.id, state);
      if (!isActive || !previous || session.id === chat.sessionId || session.archived) continue;
      // Short runs can start and finish between two list refreshes, so a new unread reply also counts as finished.
      const kind: Announcement['kind'] | undefined = state.kind && !previous.kind ? 'question'
        : previous.status === 'running' && state.status === 'errored' ? 'failed'
        : !state.kind && state.status === 'idle' && (previous.status === 'running' || (state.unread && !previous.unread)) ? 'finished' : undefined;
      if (!kind) continue;
      announcementsRef.current = [...announcementsRef.current.filter(item => item.sessionId !== session.id), { sessionId: session.id, title: session.title, kind }];
    }
    maybeAnnounce();
  }, [chat.sessions]);

  useEffect(() => { if (phase === 'idle') maybeAnnounce(); }, [phase]);

  // Android suspends the page in the background: stop listening there, and catch up on return.
  useEffect(() => {
    const onVisibility = () => {
      if (phaseRef.current === 'off') return;
      if (document.visibilityState === 'hidden') { stopListeningRef.current?.(); return; }
      if (phaseRef.current === 'idle' && !chatRef.current.isRunning) void onReplyFinished(runRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => () => { runRef.current++; stopListeningRef.current?.(); stopSpeaking(); }, []);

  return {
    phase, heard, pending, countdown, isOn: phase !== 'off', isRunning: chat.isRunning, hasQuestion: !!suspension && !resolvedRef.current.has(suspension.toolCallId),
    hasChat: !!chat.sessionId, isListenBroken,
    toggle: () => { if (phaseRef.current === 'off') turnOn(); else turnOff(true); },
    resume: () => turnOn(true),
    talk: () => {
      cancelAll();
      const run = runRef.current;
      const current = suspensionRef.current;
      if (current && !resolvedRef.current.has(current.toolCallId)) { handledRef.current.delete(current.toolCallId); void askSuspension(run, current); }
      else void listenForMessage(run, true);
    },
    stop: () => { cancelAll(); setPhase('idle'); },
    sendNow: () => { void executePending(); },
    cancelPending: () => { cancelAll(); setPhase('idle'); },
    edit: () => { const text = pendingRef.current?.editText; cancelAll(); setPhase('idle'); if (text) onEditRef.current(text); },
  };
}

export type VoiceMode = ReturnType<typeof useVoiceMode>;

export function VoiceBar({ voice }: { voice: VoiceMode }) {
  if (!voice.isOn) return null;
  const { phase } = voice;
  const status = phase === 'paused' ? 'Voice mode is on · tap Resume'
    : phase === 'speaking' ? 'Reading aloud…'
    : phase === 'listening' ? 'Listening…'
    : phase === 'confirming' ? `${voice.pending?.label ?? 'Sending'} in ${voice.countdown}…`
    : phase === 'sending' ? 'Sending…'
    : !voice.hasChat ? 'Voice mode · open a chat to talk'
    : voice.isRunning && !voice.hasQuestion ? 'Voice mode · waiting for the reply' : voice.isListenBroken ? 'Voice mode · reading aloud only (mic unavailable) · tap Talk to retry' : 'Voice mode · tap Talk to speak';
  const detail = phase === 'listening' ? voice.heard : phase === 'confirming' ? voice.pending?.detail : '';
  return <div role="region" aria-label="Voice mode" {...stylex.props(styles.wrap)}>
    <div {...stylex.props(styles.bar)}>
      <div {...stylex.props(styles.text)}>
        <span role="status" aria-live="polite" {...stylex.props(styles.status, (phase === 'listening' || phase === 'speaking') && styles.active)}>{status}</span>
        {detail ? <span {...stylex.props(styles.detail)}>“{detail}”</span> : null}
      </div>
      <div {...stylex.props(styles.actions)}>
        {phase === 'confirming' ? <>
          {voice.pending?.editText !== undefined && <IconButton label="Edit before sending" onClick={voice.edit}><Pencil size={18} strokeWidth={ICON_STROKE} /></IconButton>}
          <Button size="compact" onClick={voice.cancelPending}>Cancel</Button>
          <Button size="compact" variant="primary" onClick={voice.sendNow}><Send size={15} aria-hidden="true" />Now</Button>
        </> : phase === 'speaking' || phase === 'listening' ? <Button size="compact" onClick={voice.stop}><Square size={14} aria-hidden="true" />Stop</Button>
          : phase === 'paused' ? <Button size="compact" variant="primary" onClick={voice.resume}><Volume2 size={15} aria-hidden="true" />Resume</Button>
          : phase === 'idle' && voice.hasChat ? <Button size="compact" variant="primary" onClick={voice.talk}><Mic size={15} aria-hidden="true" />Talk</Button> : null}
        <IconButton label="Turn off voice mode" onClick={voice.toggle}><X size={18} strokeWidth={ICON_STROKE} /></IconButton>
      </div>
    </div>
  </div>;
}

export function ReadAloudButton({ id, text: rawText }: { id: string; text: string }) {
  const text = extractSpeak(rawText).display;
  const speakingKey = useSpeakingKey();
  const key = `message:${id}`;
  if (!canSpeak || !text.trim()) return null;
  const isSpeaking = speakingKey === key;
  return <IconButton label={isSpeaking ? 'Stop reading' : 'Read aloud'} aria-pressed={isSpeaking} onClick={() => { if (isSpeaking) stopSpeaking(); else void speak(key, text); }}>
    {isSpeaking ? <Square size={16} strokeWidth={ICON_STROKE} /> : <Volume2 size={18} strokeWidth={ICON_STROKE} />}
  </IconButton>;
}

const styles = stylex.create({
  wrap: { position: 'absolute', zIndex: 8, left: 'max(16px, env(safe-area-inset-left))', right: 'max(16px, env(safe-area-inset-right))', bottom: 'calc(var(--composer-height, 76px) + var(--workspace-height, 0px) + 8px)', display: 'flex', justifyContent: 'center', pointerEvents: 'none' },
  bar: { display: 'flex', alignItems: 'center', gap: 8, width: 'min(100%, 520px)', minHeight: 48, padding: '6px 6px 6px 14px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.primary, borderRadius: 16, backgroundColor: tokens.surface, color: tokens.text, boxShadow: tokens.glassShadow, pointerEvents: 'auto' },
  text: { display: 'flex', flexDirection: 'column', minWidth: 0, flexGrow: 1, gap: 2 },
  status: { fontSize: '0.8125rem', fontWeight: 600, color: tokens.muted },
  active: { color: tokens.primary },
  detail: { fontSize: '0.875rem', lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflowWrap: 'anywhere' },
  actions: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 },
});
