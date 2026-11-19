import { useCallback, useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { History, Pause, Play } from 'lucide-react';
import type { UseChat } from './types';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { tokens } from './tokens.stylex';
import { ICON_STROKE, styles as ui } from './ui';
import { describeSchedule, formatWhen, parseRoutines, parseRuns, routineStatusLabel, runStatusLabel, type RoutineInfo, type RoutineRun } from './routines';

const BASE = '/api/native/workspace/routines';

/** Scheduled routines that belong to this chat (or all of them), with their schedule, next and last run. */
export function RoutinesDialog({ sessionId, chat, notify, onClose, onOpenSession }: {
  sessionId: string; chat: UseChat; notify: (text: string, kind?: 'error' | 'success') => void; onClose: () => void; onOpenSession: (id: string) => void;
}) {
  const [routines, setRoutines] = useState<RoutineInfo[]>();
  const [isShowingAll, setShowingAll] = useState(false);
  const [runs, setRuns] = useState<Record<string, RoutineRun[]>>({});
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await chat.request(BASE, { cache: 'no-store', signal });
      const items = parseRoutines(await response.json());
      if (!signal?.aborted) { setRoutines(items); setError(false); }
    } catch { if (!signal?.aborted) setError(true); }
  }, [chat.request]);

  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, [load]);

  const mine = routines?.filter(routine => routine.parentSessionId === sessionId) ?? [];
  const shown = (isShowingAll || (routines && mine.length === 0) ? routines : mine) ?? [];
  const hasOnlyOthers = !!routines && mine.length === 0 && routines.length > 0;

  async function act(routine: RoutineInfo, action: 'run' | 'pause' | 'resume') {
    setBusyId(routine.id);
    try {
      await chat.request(`${BASE}/${encodeURIComponent(routine.id)}/${action}`, { method: 'POST' });
      notify(action === 'run' ? 'Routine started.' : action === 'pause' ? 'Routine paused.' : 'Routine resumed.', 'success');
      await load();
    } catch { notify('Could not do that. Try again.', 'error'); }
    finally { setBusyId(undefined); }
  }

  async function showRuns(routine: RoutineInfo) {
    if (runs[routine.id]) { setRuns(current => { const { [routine.id]: _removed, ...rest } = current; return rest; }); return; }
    try {
      const response = await chat.request(`${BASE}/${encodeURIComponent(routine.id)}/history`, { cache: 'no-store' });
      const items = parseRuns(await response.json());
      setRuns(current => ({ ...current, [routine.id]: items }));
    } catch { notify('Could not load the run history.', 'error'); }
  }

  return <Dialog title="Routines" onClose={onClose}>
    <DialogDescription>{isShowingAll || hasOnlyOthers ? 'All scheduled routines.' : 'Scheduled routines started from this chat.'}</DialogDescription>
    {error && <p role="alert" {...stylex.props(ui.muted)}>Could not load routines.</p>}
    {!routines && !error && <p {...stylex.props(ui.muted)}>Loading…</p>}
    {routines && hasOnlyOthers && <p {...stylex.props(ui.muted)}>This chat has no routines. Showing all {routines.length}.</p>}
    {routines && routines.length === 0 && <p {...stylex.props(ui.muted)}>No routines yet.</p>}
    <div {...stylex.props(styles.list)}>{shown.map(routine => {
      const isPaused = routine.status === 'paused';
      const isActive = routine.status === 'active';
      return <section key={routine.id} {...stylex.props(styles.card)} aria-label={routine.name}>
        <div {...stylex.props(styles.head)}><strong {...stylex.props(styles.name)}>{routine.name}</strong><span {...stylex.props(styles.badge, isActive && styles.active)}>{routineStatusLabel(routine.status)}</span></div>
        <p {...stylex.props(styles.detail)}>{describeSchedule(routine.rrule)}</p>
        <p {...stylex.props(styles.detail)}>{isActive && routine.nextRunAt ? `Next: ${formatWhen(routine.nextRunAt)}` : 'No upcoming run'} · Last: <span {...stylex.props(routine.lastRunStatus === 'errored' && styles.failed)}>{runStatusLabel(routine.lastRunStatus)}</span></p>
        <p {...stylex.props(styles.detail)}>{[routine.projectId, routine.model, routine.permissionMode].filter(Boolean).join(' · ')}</p>
        <div {...stylex.props(styles.actions)}>
          <Button size="compact" disabled={busyId === routine.id} onClick={() => void act(routine, 'run')}><Play size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />Run now</Button>
          {(isActive || isPaused) && <Button size="compact" disabled={busyId === routine.id} onClick={() => void act(routine, isPaused ? 'resume' : 'pause')}>{isPaused ? <Play size={15} strokeWidth={ICON_STROKE} aria-hidden="true" /> : <Pause size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />}{isPaused ? 'Resume' : 'Pause'}</Button>}
          <Button size="compact" aria-expanded={!!runs[routine.id]} onClick={() => void showRuns(routine)}><History size={15} strokeWidth={ICON_STROKE} aria-hidden="true" />Runs</Button>
        </div>
        {runs[routine.id] && (runs[routine.id].length ? <ul {...stylex.props(styles.runs)}>{runs[routine.id].slice(0, 8).map(run => <li key={run.id}><button type="button" {...stylex.props(styles.run)} onClick={() => { onClose(); onOpenSession(run.id); }}><span>{formatWhen(run.createdAt)}</span><span {...stylex.props(run.status === 'errored' && styles.failed)}>{runStatusLabel(run.status)}{run.unread ? ' · unread' : ''}</span></button></li>)}</ul> : <p {...stylex.props(styles.detail)}>No runs yet.</p>)}
      </section>;
    })}</div>
    <DialogActions>{routines && !hasOnlyOthers && routines.length > mine.length && <Button onClick={() => setShowingAll(current => !current)}>{isShowingAll ? 'Only this chat' : `All routines (${routines.length})`}</Button>}<Button variant="primary" onClick={onClose}>Done</Button></DialogActions>
  </Dialog>;
}

const styles = stylex.create({
  list: { display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 'min(440px, 60dvh)', overflowY: 'auto' },
  card: { display: 'flex', flexDirection: 'column', gap: 4, padding: '12px 14px', borderWidth: 1, borderStyle: 'solid', borderColor: tokens.border, borderRadius: 14 },
  head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  name: { fontSize: '0.9375rem', lineHeight: 1.35, overflowWrap: 'anywhere' },
  badge: { flexShrink: 0, padding: '2px 9px', borderRadius: 999, fontSize: '0.75rem', color: tokens.muted, backgroundColor: tokens.hover },
  active: { color: tokens.primary },
  detail: { margin: 0, fontSize: '0.8125rem', lineHeight: 1.45, color: tokens.muted },
  failed: { color: tokens.danger },
  actions: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  runs: { listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  run: { display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 38, padding: '8px 10px', borderWidth: 0, borderRadius: 10, backgroundColor: 'transparent', color: tokens.text, fontSize: '0.8125rem', textAlign: 'left', cursor: 'pointer' },
});
