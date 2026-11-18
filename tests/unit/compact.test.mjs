import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCompactCommand } from '../../web/src/compact.ts'

test('compact command parses optional instructions', () => {
  assert.deepEqual(parseCompactCommand('/compact'), {})
  assert.deepEqual(parseCompactCommand('  /compact  '), {})
  assert.deepEqual(parseCompactCommand('/compact keep file paths'), { instructions: 'keep file paths' })
  assert.deepEqual(parseCompactCommand('/compact\nkeep decisions\nand links'), { instructions: 'keep decisions\nand links' })
})

test('other text is not a compact command', () => {
  for (const text of ['compact', '/compacted', 'please /compact', '/compactor x', '']) assert.equal(parseCompactCommand(text), undefined)
})
