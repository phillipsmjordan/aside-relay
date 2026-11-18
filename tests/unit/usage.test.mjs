import assert from 'node:assert/strict'
import test from 'node:test'
import { contextPercent, formatReset, formatTokens, parseContext, usageWindows } from '../../web/src/usage.ts'

test('formats token counts like the desktop app', () => {
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(242103), '242K')
  assert.equal(formatTokens(1_000_000), '1M')
  assert.equal(formatTokens(1_500_000), '1.5M')
  assert.equal(formatTokens(9_400), '9.4K')
})

test('parses context window from a session', () => {
  const info = parseContext({ contextWindow: { usedTokens: 242103, totalTokens: 1000000 }, model: { provider: 'claude-code', modelId: 'claude-opus-5-5' } })
  assert.deepEqual(info, { usedTokens: 242103, totalTokens: 1000000, provider: 'claude-code', modelId: 'claude-opus-5-5' })
  assert.equal(Math.round(contextPercent(info)), 24)
  assert.equal(parseContext({ contextWindow: { usedTokens: 1, totalTokens: 0 } }), undefined)
  assert.equal(parseContext({}), undefined)
  assert.equal(contextPercent({ usedTokens: 5, totalTokens: 4 }), 100)
})

test('normalizes both subscription usage shapes', () => {
  assert.deepEqual(usageWindows({ windows: [{ id: 'seven_day', usedPercent: 23, resetsAt: 1795118400 }, { id: 'five_hour', usedPercent: 16, resetsAt: 1795023600 }] }).map(w => [w.kind, w.leftPercent]), [['five_hour', 84], ['weekly', 77]])
  assert.deepEqual(usageWindows({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 5 }, secondary: { usedPercent: 10, windowDurationMins: 10080 } } }).map(w => [w.kind, w.usedPercent]), [['five_hour', 40], ['weekly', 10]])
  assert.deepEqual(usageWindows({ windows: [{ id: 'monthly', usedPercent: 100 }] })[0].leftPercent, 0)
  assert.deepEqual(usageWindows(null), [])
})

test('reset times read naturally', () => {
  const now = Date.UTC(2026, 10, 18, 15, 0, 0)
  assert.equal(formatReset(now / 1000 + 45 * 60, now), 'resets in 45m')
  assert.equal(formatReset(now / 1000 + 130 * 60, now), 'resets in 2h 10m')
  assert.equal(formatReset(now / 1000 + 3 * 86400, now, 'America/New_York'), 'resets Sat 10:00 AM')
  assert.equal(formatReset(undefined, now), '')
})
