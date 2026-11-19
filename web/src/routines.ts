export type RoutineInfo = {
  id: string; name: string; prompt: string; rrule: string; status: string; parentSessionId?: string; projectId?: string;
  nextRunAt?: string; lastRunStatus?: string; model?: string; permissionMode?: string;
};
export type RoutineRun = { id: string; title: string; status: string; createdAt: string; unread: boolean };

const DAYS: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' };

function clock(hour: number, minute: number) {
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

/** "Every 15 minutes", "Daily at 9:00 AM", "Weekdays at 9:30 AM", "Monthly on the 27th" from an iCalendar rule. */
export function describeSchedule(rrule: string): string {
  const lines = rrule.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const start = lines.find(line => line.startsWith('DTSTART'))?.match(/T(\d{2})(\d{2})\d{2}/);
  const rule = Object.fromEntries((lines.find(line => line.startsWith('RRULE'))?.replace(/^RRULE:/, '') ?? '').split(';').filter(Boolean).map(part => part.split('=') as [string, string]));
  const interval = Number(rule.INTERVAL ?? 1);
  const hours = rule.BYHOUR?.split(',').map(Number);
  const minute = Number(rule.BYMINUTE ?? start?.[2] ?? 0);
  const times = hours ? hours.map(hour => clock(hour, minute)).join(', ') : start ? clock(Number(start[1]), Number(start[2])) : '';
  const at = times ? ` at ${times}` : '';
  const days = rule.BYDAY?.split(',');
  const isWeekdays = days?.join(',') === 'MO,TU,WE,TH,FR';
  let text: string;
  switch (rule.FREQ) {
    case 'MINUTELY': text = interval === 1 ? 'Every minute' : `Every ${interval} minutes`; break;
    case 'HOURLY': text = interval === 1 ? 'Every hour' : `Every ${interval} hours`; break;
    case 'DAILY': text = isWeekdays ? `Weekdays${at}` : days ? `${days.map(day => DAYS[day] ?? day).join(', ')}${at}` : interval === 1 ? `Daily${at}` : `Every ${interval} days${at}`; break;
    case 'WEEKLY': text = `${interval === 1 ? 'Weekly' : `Every ${interval} weeks`} on ${days ? days.map(day => DAYS[day] ?? day).join(', ') : 'the same day'}${at}`; break;
    case 'MONTHLY': { const day = Number(rule.BYMONTHDAY); text = day ? `Monthly on the ${day}${[, 'st', 'nd', 'rd'][day % 10 > 3 || Math.floor(day / 10) === 1 ? 0 : day % 10] ?? 'th'}${at}` : `Monthly${at}`; break; }
    case 'YEARLY': text = `Yearly${at}`; break;
    default: return rrule.replace(/\s+/g, ' ');
  }
  if (rule.COUNT === '1') return `Once${at}`;
  return text;
}

export function routineStatusLabel(status: string) {
  return status === 'paused' ? 'Paused' : status === 'completed' ? 'Finished' : status === 'active' ? 'Active' : status ? status[0].toUpperCase() + status.slice(1) : 'Unknown';
}

export function runStatusLabel(status: string | undefined) {
  return !status ? 'No runs yet' : status === 'idle' ? 'Completed' : status === 'errored' ? 'Failed' : status === 'running' ? 'Running' : status === 'interrupted' ? 'Interrupted' : status === 'suspended' ? 'Needs you' : status;
}

/** "Today 9:00 AM", "Tomorrow 9:00 AM", "Fri 9:00 AM" or a short date, in the viewer's time zone. */
export function formatWhen(iso: string | undefined, now = new Date()): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = clock(date.getHours(), date.getMinutes());
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(now)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${time}`;
}

const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export function parseRoutines(value: unknown): RoutineInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return [];
    const id = text(Reflect.get(item, 'id')); if (!id) return [];
    const config = Reflect.get(item, 'sessionConfig');
    const model = typeof config === 'object' && config !== null ? Reflect.get(config, 'model') : undefined;
    return [{
      id, name: text(Reflect.get(item, 'name')) ?? 'Untitled routine', prompt: text(Reflect.get(item, 'prompt')) ?? '', rrule: text(Reflect.get(item, 'rrule')) ?? '',
      status: text(Reflect.get(item, 'status')) ?? '', parentSessionId: text(Reflect.get(item, 'parentSessionId')), projectId: text(Reflect.get(item, 'projectId')),
      nextRunAt: text(Reflect.get(item, 'nextRunAt')), lastRunStatus: text(Reflect.get(item, 'lastRunStatus')),
      model: typeof model === 'object' && model !== null ? text(Reflect.get(model, 'modelId')) : undefined,
      permissionMode: typeof config === 'object' && config !== null ? text(Reflect.get(config, 'permissionMode')) : undefined,
    }];
  });
}

export function parseRuns(value: unknown): RoutineRun[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (typeof item !== 'object' || item === null) return [];
    const id = text(Reflect.get(item, 'id')); if (!id) return [];
    return [{ id, title: text(Reflect.get(item, 'title')) ?? 'Routine run', status: text(Reflect.get(item, 'status')) ?? 'idle', createdAt: text(Reflect.get(item, 'createdAt')) ?? '', unread: Boolean(Reflect.get(item, 'unread')) }];
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
