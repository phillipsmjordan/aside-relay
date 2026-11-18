import type { UseChat } from './types';

export const COMPACT_COMMAND = /^\/compact(?:\s+([\s\S]*))?$/;

/** Parses "/compact [instructions]". Returns undefined when the text is not a compact command. */
export function parseCompactCommand(text: string): { instructions?: string } | undefined {
  const match = COMPACT_COMMAND.exec(text.trim());
  if (!match) return undefined;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}

/** Runs Aside's context compaction for a conversation, like /compact in the desktop app. */
export async function compactSession(chat: UseChat, sessionId: string, instructions: string | undefined, notify: (text: string, kind?: 'error' | 'success') => void) {
  notify('Compacting context…');
  try {
    await chat.request('/api/sessions/' + encodeURIComponent(sessionId) + '/compact', {
      method: 'POST', body: JSON.stringify(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    });
    if (sessionId === chat.sessionId) await chat.refreshMessages();
    notify('Context compacted.', 'success');
    return true;
  } catch (error) {
    notify(error instanceof Error && error.message ? error.message : 'Could not compact this conversation.', 'error');
    return false;
  }
}
