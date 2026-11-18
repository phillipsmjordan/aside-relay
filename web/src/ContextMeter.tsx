import { useEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { AnimatePresence } from 'motion/react';
import type { UseChat } from './types';
import { Button } from './Button';
import { Dialog, DialogActions, DialogDescription } from './Dialog';
import { tokens } from './tokens.stylex';
import { compactSession } from './compact';
import { SUBSCRIPTION_PROVIDERS, contextPercent, formatReset, formatTokens, providerLabel, usageWindows, type ContextInfo, type SubscriptionUsage } from './usage';

const SIZE = 26;
const STROKE = 3;

function Ring({ percent }: { percent: number }) {
  const radius = (SIZE - STROKE) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = percent >= 90 ? styles.danger : percent >= 75 ? styles.warning : styles.normal;
  return <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true" {...stylex.props(tone)}>
    <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={STROKE} />
    <circle cx={SIZE / 2} cy={SIZE / 2} r={radius} fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round"
      strokeDasharray={`${circumference} ${circumference}`} strokeDashoffset={circumference * (1 - percent / 100)}
      style={{ transform: 'rotate(-90deg)', transformOrigin: 'center', transition: 'stroke-dashoffset .4s ease' }} />
  </svg>;
}

export function ContextMeter({ chat, context, notify }: { chat: UseChat; context?: ContextInfo; notify: (text: string, kind?: 'success' | 'error') => void }) {
  const [isOpen, setOpen] = useState(false);
  if (!chat.sessionId || !context) return null;
  const percent = contextPercent(context);
  const rounded = Math.round(percent);
  return <>
    <button type="button" aria-label={`Context ${rounded}% full. Show context and usage`} aria-haspopup="dialog" title={`${rounded}% of context used`} {...stylex.props(styles.button)} onClick={() => setOpen(true)}><Ring percent={percent} /></button>
    <AnimatePresence>{isOpen && <ContextDialog key="context" chat={chat} context={context} notify={notify} onClose={() => setOpen(false)} />}</AnimatePresence>
  </>;
}

function ContextDialog({ chat, context, notify, onClose }: { chat: UseChat; context: ContextInfo; notify: (text: string, kind?: 'success' | 'error') => void; onClose: () => void }) {
  const percent = Math.round(contextPercent(context));
  const remaining = Math.max(0, context.totalTokens - context.usedTokens);
  const provider = context.provider;
  const isSubscription = !!provider && SUBSCRIPTION_PROVIDERS.has(provider);
  const [usage, setUsage] = useState<SubscriptionUsage>();
  const [usageError, setUsageError] = useState('');
  useEffect(() => {
    if (!isSubscription || !provider) return;
    const controller = new AbortController();
    void chat.request(`/api/subscription-usage?provider=${encodeURIComponent(provider)}`, { signal: controller.signal })
      .then(response => response.json() as Promise<SubscriptionUsage>).then(setUsage)
      .catch(error => { if (!(error instanceof DOMException && error.name === 'AbortError')) setUsageError('Could not load usage.'); });
    return () => controller.abort();
  }, [chat.request, provider, isSubscription]);
  const windows = usageWindows(usage?.usage);
  return <Dialog title="Context and usage" onClose={onClose}>
    <section aria-label="Context" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.row)}><span {...stylex.props(styles.label)}>Context</span><strong>{percent}% full</strong></div>
      <Bar percent={percent} />
      <div {...stylex.props(styles.row, styles.muted)}><span>{formatTokens(context.usedTokens)} / {formatTokens(context.totalTokens)} tokens</span><span>{formatTokens(remaining)} left</span></div>
      {context.modelId && <div {...stylex.props(styles.muted)}>{context.modelId}</div>}
    </section>
    {provider && <section aria-label="Subscription usage" {...stylex.props(styles.section)}>
      <div {...stylex.props(styles.row)}><span {...stylex.props(styles.label)}>{isSubscription ? providerLabel(provider) : 'Usage'}</span></div>
      {!isSubscription ? <DialogDescription>Plan usage isn't available for this model's provider.</DialogDescription>
        : usageError ? <DialogDescription>{usageError}</DialogDescription>
        : !usage ? <DialogDescription>Loading usage…</DialogDescription>
        : usage.state === 'auth-expired' ? <DialogDescription>Sign-in expired. Reconnect this provider in Aside on your Mac.</DialogDescription>
        : !windows.length ? <DialogDescription>No usage limits reported for this plan.</DialogDescription>
        : windows.map(window => <div key={window.kind} {...stylex.props(styles.window)}>
          <div {...stylex.props(styles.row)}><span>{window.label}</span><strong {...stylex.props(window.leftPercent < 20 && styles.dangerText)}>{window.leftPercent}% left</strong></div>
          <Bar percent={window.usedPercent} />
          {window.resetsAt && <div {...stylex.props(styles.muted)}>{formatReset(window.resetsAt)}</div>}
        </div>)}
    </section>}
    <DialogActions>
      <Button disabled={chat.isRunning || !chat.sessionId} onClick={() => { const id = chat.sessionId; onClose(); if (id) void compactSession(chat, id, undefined, notify); }}>Compact context</Button>
      <Button variant="primary" onClick={onClose}>Done</Button>
    </DialogActions>
  </Dialog>;
}

function Bar({ percent }: { percent: number }) {
  const tone = percent >= 90 ? styles.dangerFill : percent >= 75 ? styles.warningFill : styles.fill;
  return <div role="presentation" {...stylex.props(styles.track)}><div {...stylex.props(styles.fillBase, tone)} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>;
}

const styles = stylex.create({
  button: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 38, padding: 0, borderWidth: 0, backgroundColor: 'transparent', cursor: 'pointer', flexShrink: 0, borderRadius: 19 },
  normal: { color: tokens.muted },
  warning: { color: '#d97706' },
  danger: { color: '#dc2626' },
  section: { display: 'flex', flexDirection: 'column', gap: 6, paddingBottom: 14, marginBottom: 14, borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: tokens.border },
  row: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, fontSize: '0.9375rem' },
  label: { fontWeight: 600 },
  muted: { color: tokens.muted, fontSize: '0.8125rem' },
  window: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 },
  track: { height: 6, borderRadius: 3, backgroundColor: tokens.border, overflow: 'hidden' },
  fillBase: { height: '100%', borderRadius: 3 },
  fill: { backgroundColor: tokens.primary },
  warningFill: { backgroundColor: '#d97706' },
  dangerFill: { backgroundColor: '#dc2626' },
  dangerText: { color: '#dc2626' },
});
