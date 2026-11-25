import { useEffect, useRef, useState } from 'react';
import type { UseChat } from './types';
import { INTERVIEW_REMINDER, isInterviewOn, reminderTarget } from './interview.ts';

// The running flag clears just before the last messages of a reply arrive, so wait before judging.
const SETTLE_MS = 2500;
const MAX_ATTEMPTS = 2;

/**
 * Sends one reminder when the newest reply in the open conversation ended
 * without a question. Nothing happens unless interview mode is on there.
 */
export function useInterviewEnforcer(chat: UseChat) {
  const [, setTick] = useState(0);
  const stageRef = useRef<{ seq: number; state: 'settling' | 'ready' } | undefined>(undefined);
  const attemptsRef = useRef<{ seq: number; count: number } | undefined>(undefined);
  const remindedRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const sessionId = chat.sessionId;
    if (!sessionId || !chat.isReady || chat.authError || chat.isOpening) return;
    if (chat.isRunning || chat.isSending || chat.isStopping || chat.queuedMessages.length) return;
    const target = isInterviewOn(sessionId) ? reminderTarget(chat.messages) : -1;
    if (target < 0) { stageRef.current = undefined; return; }
    if (remindedRef.current === target) return;
    if (stageRef.current?.seq === target && stageRef.current.state === 'ready') {
      stageRef.current = undefined;
      attemptsRef.current = { seq: target, count: attemptsRef.current?.seq === target ? attemptsRef.current.count + 1 : 1 };
      void chat.send(INTERVIEW_REMINDER, [], undefined, undefined, true).then(accepted => { if (accepted) remindedRef.current = target; });
      return;
    }
    if (stageRef.current?.seq === target || (attemptsRef.current?.seq === target && attemptsRef.current.count >= MAX_ATTEMPTS)) return;
    stageRef.current = { seq: target, state: 'settling' };
    window.setTimeout(async () => {
      // False means the conversation was closed or switched away from meanwhile.
      if (!await chat.refreshMessages()) return;
      let status: unknown;
      try {
        const payload: unknown = await (await chat.request(`/api/native/sessions/${encodeURIComponent(sessionId)}`)).json();
        const session: unknown = Reflect.get(payload as object, 'session');
        status = session && typeof session === 'object' ? Reflect.get(session, 'status') : undefined;
      } catch { status = undefined; }
      // A reply that was stopped or failed is left alone.
      stageRef.current = status === 'idle' ? { seq: target, state: 'ready' } : undefined;
      setTick(value => value + 1);
    }, SETTLE_MS);
  }, [chat]);
}
