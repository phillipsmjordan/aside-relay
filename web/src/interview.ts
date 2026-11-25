// Interview mode: the agent asks what it needs to know through the question
// tool, one question at a time, instead of writing questions in plain text.
//
// Three parts, all in the browser:
// 1. A per-conversation switch (header button next to voice mode).
// 2. A standing instruction attached to every message sent while it is on.
//    The relay hides it from the conversation view.
// 3. One automatic reminder when a reply ends without a question.

const STORAGE_KEY = 'aside-relay:interview';
// A reply that ended longer ago than this is left alone: the person has moved on.
const MAX_AGE_MS = 30 * 60_000;

let storedSessions: string[] | undefined;
let newConversation = false;
const listeners = new Set<() => void>();

function storage(): Storage | undefined { return typeof localStorage === 'undefined' ? undefined : localStorage; }

function stored(): string[] {
  if (!storedSessions) {
    let value: unknown;
    try { value = JSON.parse(storage()?.getItem(STORAGE_KEY) || '[]'); } catch { value = []; }
    storedSessions = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  }
  return storedSessions;
}

function publish() {
  try { storage()?.setItem(STORAGE_KEY, JSON.stringify(stored())); } catch { /* storage unavailable */ }
  listeners.forEach(listener => listener());
}

/** Without an id this refers to the New chat screen, where the switch lasts until the conversation starts. */
export function isInterviewOn(sessionId?: string): boolean {
  return sessionId ? stored().includes(sessionId) : newConversation;
}

export function setInterviewOn(sessionId: string | undefined, isOn: boolean): void {
  if (!sessionId) {
    if (newConversation === isOn) return;
    newConversation = isOn;
    publish();
    return;
  }
  const current = stored();
  const next = isOn ? current.includes(sessionId) ? current : [...current, sessionId] : current.filter(id => id !== sessionId);
  if (next === current) return;
  storedSessions = next;
  publish();
}

/** The first message of a new conversation created its id: carry the switch over to it. */
export function adoptInterviewSession(sessionId: string): void {
  if (!newConversation) return;
  newConversation = false;
  setInterviewOn(sessionId, true);
}

export function resetNewInterview(): void { setInterviewOn(undefined, false); }

export function subscribeInterview(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export const INTERVIEW_NOTE_START = '[Interview mode is on.';
export const INTERVIEW_NOTE_END = 'End of interview note.]';
export const INTERVIEW_NOTE = `${INTERVIEW_NOTE_START} It overrides the default follow-through policy. Before any research or work, ask me what you need to know, one question per ask_user_question call, with 2 to 4 self-contained options when there is a real choice, recommended first and labelled "(Recommended)". Keep any lead-in to one short sentence. Never put a question in plain text, including a closing offer at the end of the final answer. After each answer, ask the next question the same way until you have what you need, then do the work and give the final answer. If nothing needs asking, start your reply with "No questions needed." and answer normally. ${INTERVIEW_NOTE_END}`;
// Not anchored: the voice summary request can follow the instruction on the same message.
const INTERVIEW_NOTE_RE = /\n*\[Interview mode is on\.[\s\S]*?End of interview note\.\]/;
const INTERVIEW_NOTE_ALL_RE = /\n*\[Interview mode is on\.[\s\S]*?End of interview note\.\]/g;

export function withInterviewNote(prompt: string): string {
  return prompt.trim() && !hasInterviewNote(prompt) ? `${prompt}\n\n${INTERVIEW_NOTE}` : prompt;
}
export function hasInterviewNote(text: string): boolean { return INTERVIEW_NOTE_RE.test(text); }
export function stripInterviewNote(text: string): string { return text.replace(INTERVIEW_NOTE_ALL_RE, '').trimEnd(); }

/** Sent once, as a plain message without the standing instruction, when a reply ends without a question. */
/** Hides the "No questions needed." opener on a reply that had nothing to ask: it is a marker for the relay, not for reading. */
const NO_QUESTIONS_LINE = /^\s*(?:\*\*)?no questions needed(?:\.|(?=\r?\n))(?:\*\*)?[ \t]*\r?\n?/i;
export function stripNoQuestions(text: string): string {
  return NO_QUESTIONS_LINE.test(text) ? text.replace(NO_QUESTIONS_LINE, '').replace(/^\s+/, '') : text;
}

export const INTERVIEW_REMINDER = 'Interview mode is on. Ask me with the question tool: one question with options, before you answer.';
/** Recognises a reminder even if its wording changed between versions. */
export function isInterviewReminder(text: string): boolean { return /^\s*Interview mode is on\. Ask me with the question tool\b/.test(text); }
const NO_QUESTIONS = /^\s*(?:[*_#>\s])*no questions needed\b/i;

export type InterviewMessage = { seq: number; role: string; ts?: number; blocks: ReadonlyArray<{ type: string; text?: string; name?: string }> };

function textOf(message: InterviewMessage): string {
  return message.blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n');
}

/**
 * Returns the sequence number of the message that needs a reminder, or -1.
 * A reminder is due when the newest message from the person carries the standing
 * instruction, it is recent, and the reply after it ended without a question.
 */
export function reminderTarget(messages: readonly InterviewMessage[], now = Date.now()): number {
  let trigger = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user') { trigger = index; break; }
  }
  if (trigger < 0) return -1;
  const first = messages[trigger];
  if (!hasInterviewNote(textOf(first))) return -1;
  if (typeof first.ts === 'number' && now - first.ts > MAX_AGE_MS) return -1;
  let lastText = '';
  for (let index = trigger + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    if (message.blocks.some(block => block.type === 'toolCall' && block.name === 'ask_user_question')) return -1;
    const text = textOf(message).trim();
    if (text) lastText = text;
  }
  if (!lastText || NO_QUESTIONS.test(lastText)) return -1;
  return first.seq;
}
