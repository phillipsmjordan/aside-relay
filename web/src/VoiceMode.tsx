import { useEffect, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Mic, Pencil, Send, Square, Volume2, X } from 'lucide-react';
import type { ChatMessage, UseChat } from './types';
import type { SessionWorkspaceState } from './SessionWorkspace';
import { Button } from './Button';
import { IconButton, ICON_STROKE } from './ui';
import { tokens } from './tokens.stylex';
import { matchOption, matchVerdict, parseVoiceIntent, speakableText, splitHead, suspensionSpeech } from './speech';
import { canListen, canSpeak, listen, speak, stopSpeaking, useSpeakingKey, type ListenResult } from './voice';

export const isVoiceSupported = canSpeak && canListen;
const COUNTDOWN_SECONDS = 3;
const VOICE_KEY = 'voice-mode';
export const SUSPENSION_RESOLVED_EVENT = 'aside:suspension-resolved';

type Suspension = NonNullable<SessionWorkspaceState['suspension']>;
type Phase = 'off' | 'idle' | 'speaking' | 'listening' | 'confirming' | 'sending';
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

export function useVoiceMode({ chat, suspension, notify, onEdit }: {
  chat: UseChat;
  suspension?: Suspension;
  notify: (text: string, kind?: 'success' | 'error') => void;
  onEdit: (text: string) => void;
}) {
  const [phase, setPhaseState] = useState<Phase>('off');
  const [heard, setHeard] = useState('');
  const [pending, setPending] = useState<Pending>();
  const [countdown, setCountdown] = useState(0);
  const phaseRef = useRef<Phase>('off');
  const runRef = useRef(0);
  const stopListeningRef = useRef<(() => void) | undefined>(undefined);
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
  chatRef.current = chat; suspensionRef.current = suspension; notifyRef.current = notify; onEditRef.current = onEdit;

  function setPhase(next: Phase) { phaseRef.current = next; setPhaseState(next); }
  function isCurrent(run: number) { return run === runRef.current && phaseRef.current !== 'off'; }

  function cancelAll() {
    runRef.current++;
    stopListeningRef.current?.(); stopListeningRef.current = undefined;
    stopSpeaking();
    pendingRef.current = undefined; setPending(undefined); setCountdown(0); setHeard('');
  }

  function turnOff(shouldAnnounce = false) {
    cancelAll(); setPhase('off');
    if (shouldAnnounce) void speak(VOICE_KEY, 'Voice mode off.', { isMarkdown: false });
  }

  function turnOn() {
    cancelAll();
    const run = runRef.current;
    const reply = latestReply(chatRef.current);
    if (reply) { spokenRef.current.add(reply.key); spokenRef.current.add(reply.text); lastReplyRef.current = reply.text; }
    setPhase('speaking');
    // This first utterance runs inside the tap, which unlocks speech on Android.
    void speak(VOICE_KEY, chatRef.current.isRunning ? 'Voice mode on. I will read the reply when it is ready.' : 'Voice mode on. Go ahead.', { isMarkdown: false })
      .then(() => { if (isCurrent(run)) proceed(run); });
  }

  /** Decide what to do next when nothing else is happening. */
  function proceed(run: number) {
    if (!isCurrent(run)) return;
    const current = suspensionRef.current;
    if (current && !handledRef.current.has(current.toolCallId) && !resolvedRef.current.has(current.toolCallId)) { void askSuspension(run, current); return; }
    if (chatRef.current.isRunning) { setPhase('idle'); return; }
    void listenForMessage(run);
  }

  async function listenOnce(run: number): Promise<ListenResult> {
    setPhase('listening'); setHeard('');
    const session = listen(setHeard);
    stopListeningRef.current = session.stop;
    const result = await session.result;
    if (stopListeningRef.current === session.stop) stopListeningRef.current = undefined;
    if (result.error && isCurrent(run)) {
      notifyRef.current(result.error === 'not-allowed' || result.error === 'service-not-allowed'
        ? 'Microphone access is blocked. Allow it for this site, then tap Talk.'
        : 'Could not listen. Tap Talk to try again.', 'error');
    }
    return result;
  }

  async function listenForMessage(run: number) {
    const result = await listenOnce(run);
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
    const { head, rest } = splitHead(speakableText(reply.text));
    setPhase('speaking');
    if (!await speak(VOICE_KEY, head, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
    if (rest) {
      if (!await speak(VOICE_KEY, 'Want the rest?', { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
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
      if (!await speak(VOICE_KEY, splitHead(speakableText(reply.text)).head, { isMarkdown: false }) || !isCurrent(run)) { if (isCurrent(run)) setPhase('idle'); return; }
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
    } catch {
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

  // Voice mode belongs to one conversation.
  useEffect(() => { if (phaseRef.current !== 'off') turnOff(); spokenRef.current.clear(); handledRef.current.clear(); resolvedRef.current.clear(); }, [chat.sessionId]);

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
    toggle: () => { if (phaseRef.current === 'off') turnOn(); else turnOff(true); },
    talk: () => {
      cancelAll();
      const run = runRef.current;
      const current = suspensionRef.current;
      if (current && !resolvedRef.current.has(current.toolCallId)) { handledRef.current.delete(current.toolCallId); void askSuspension(run, current); }
      else void listenForMessage(run);
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
  const status = phase === 'speaking' ? 'Reading aloud…'
    : phase === 'listening' ? 'Listening…'
    : phase === 'confirming' ? `${voice.pending?.label ?? 'Sending'} in ${voice.countdown}…`
    : phase === 'sending' ? 'Sending…'
    : voice.isRunning && !voice.hasQuestion ? 'Voice mode · waiting for the reply' : 'Voice mode · tap Talk to speak';
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
          : phase === 'idle' ? <Button size="compact" variant="primary" onClick={voice.talk}><Mic size={15} aria-hidden="true" />Talk</Button> : null}
        <IconButton label="Turn off voice mode" onClick={voice.toggle}><X size={18} strokeWidth={ICON_STROKE} /></IconButton>
      </div>
    </div>
  </div>;
}

export function ReadAloudButton({ id, text }: { id: string; text: string }) {
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
