// Pure helpers for the context meter and subscription usage. No browser APIs, so Node can test them.

export type ContextInfo = { usedTokens: number; totalTokens: number; provider?: string; modelId?: string };
export type UsageWindow = { kind: 'five_hour' | 'weekly' | 'monthly'; label: string; usedPercent: number; leftPercent: number; resetsAt?: number };
export type SubscriptionUsage = { providerId: string; usage: unknown; state?: string | null };

export const SUBSCRIPTION_PROVIDERS = new Set(['aside', 'claude-code', 'kimi-code', 'openai-codex', 'xai-grok-oauth']);
const PROVIDER_LABELS: Record<string, string> = { aside: 'Aside plan', 'claude-code': 'Claude subscription', 'kimi-code': 'Kimi subscription', 'openai-codex': 'ChatGPT subscription', 'xai-grok-oauth': 'Grok subscription' };
const WINDOW_LABELS: Record<UsageWindow['kind'], string> = { five_hour: '5-hour limit', weekly: 'Weekly limit', monthly: 'Monthly limit' };

export function providerLabel(provider: string) { return PROVIDER_LABELS[provider] ?? provider; }

export function formatTokens(value: number) {
  const units = [{ suffix: 'M', size: 1e6 }, { suffix: 'K', size: 1e3 }];
  const unit = units.find(({ size }) => value >= size);
  if (!unit) return String(Math.round(value));
  const scaled = value / unit.size;
  return `${scaled < 10 ? Math.round(scaled * 10) / 10 : Math.round(scaled)}${unit.suffix}`;
}

export function contextPercent(info?: Pick<ContextInfo, 'usedTokens' | 'totalTokens'>) {
  if (!info || info.totalTokens <= 0) return 0;
  return Math.max(0, Math.min(100, info.usedTokens / info.totalTokens * 100));
}

export function parseContext(session: unknown): ContextInfo | undefined {
  if (typeof session !== 'object' || session === null) return undefined;
  const window = Reflect.get(session, 'contextWindow');
  const model = Reflect.get(session, 'model');
  if (typeof window !== 'object' || window === null) return undefined;
  const used = Number(Reflect.get(window, 'usedTokens'));
  const total = Number(Reflect.get(window, 'totalTokens'));
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return undefined;
  const provider = typeof model === 'object' && model !== null ? Reflect.get(model, 'provider') : undefined;
  const modelId = typeof model === 'object' && model !== null ? Reflect.get(model, 'modelId') : undefined;
  return { usedTokens: Math.max(0, used), totalTokens: total, provider: typeof provider === 'string' ? provider : undefined, modelId: typeof modelId === 'string' ? modelId : undefined };
}

function windowKind(id: unknown, minutes?: unknown): UsageWindow['kind'] | undefined {
  if (id === 'five_hour') return 'five_hour';
  if (id === 'seven_day' || id === 'weekly') return 'weekly';
  if (id === 'monthly') return 'monthly';
  if (typeof minutes === 'number') return minutes <= 1440 ? 'five_hour' : minutes >= 28800 ? 'monthly' : minutes >= 8640 ? 'weekly' : undefined;
  return undefined;
}

/** Normalizes both usage shapes Aside returns: { windows: [...] } and { rateLimits: { primary, secondary } }. */
export function usageWindows(usage: unknown): UsageWindow[] {
  if (typeof usage !== 'object' || usage === null) return [];
  const raw: { kind?: UsageWindow['kind']; usedPercent: unknown; resetsAt: unknown }[] = [];
  const windows = Reflect.get(usage, 'windows');
  if (Array.isArray(windows)) for (const item of windows) if (typeof item === 'object' && item) raw.push({ kind: windowKind(Reflect.get(item, 'id')), usedPercent: Reflect.get(item, 'usedPercent'), resetsAt: Reflect.get(item, 'resetsAt') });
  const limits = Reflect.get(usage, 'rateLimits');
  if (typeof limits === 'object' && limits) for (const key of ['primary', 'secondary']) {
    const item = Reflect.get(limits, key);
    if (typeof item === 'object' && item) raw.push({ kind: windowKind(undefined, Reflect.get(item, 'windowDurationMins')), usedPercent: Reflect.get(item, 'usedPercent'), resetsAt: Reflect.get(item, 'resetsAt') });
  }
  const seen = new Map<UsageWindow['kind'], UsageWindow>();
  for (const item of raw) {
    const used = Number(item.usedPercent);
    if (!item.kind || seen.has(item.kind) || !Number.isFinite(used)) continue;
    const clamped = Math.max(0, Math.min(100, used));
    const resetsAt = Number(item.resetsAt);
    seen.set(item.kind, { kind: item.kind, label: WINDOW_LABELS[item.kind], usedPercent: clamped, leftPercent: Math.round(100 - clamped), resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : undefined });
  }
  return (['five_hour', 'weekly', 'monthly'] as const).flatMap(kind => seen.get(kind) ?? []);
}

/** "resets in 2h 10m" within a day, otherwise "resets Sat 11:00 AM". resetsAt is epoch seconds. */
export function formatReset(resetsAt: number | undefined, now = Date.now(), timeZone?: string) {
  if (!resetsAt) return '';
  const ms = resetsAt * 1000 - now;
  if (ms <= 0) return 'resets now';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 24 * 60) { const hours = Math.floor(minutes / 60); const rest = minutes % 60; return `resets in ${hours}h${rest ? ` ${rest}m` : ''}`; }
  return 'resets ' + new Date(resetsAt * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone });
}
