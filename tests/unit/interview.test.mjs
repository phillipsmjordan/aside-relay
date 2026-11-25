import assert from 'node:assert/strict'
import test from 'node:test'
import { INTERVIEW_NOTE, INTERVIEW_REMINDER, adoptInterviewSession, isInterviewReminder, stripNoQuestions, hasInterviewNote, isInterviewOn, reminderTarget, resetNewInterview, setInterviewOn, stripInterviewNote, withInterviewNote } from '../../web/src/interview.ts'
import { setVoiceNoteOn, stripVoiceNote, withVoiceNote } from '../../web/src/speech.ts'

const user = (seq, text, ts = 1_000_000) => ({ seq, role: 'user', ts, blocks: [{ type: 'text', text }] })
const reply = (seq, text) => ({ seq, role: 'assistant', blocks: [{ type: 'text', text }] })
const question = seq => ({ seq, role: 'assistant', blocks: [{ type: 'toolCall', name: 'ask_user_question', args: {} }] })
const asked = text => `${text}\n\n${INTERVIEW_NOTE}`

test('the instruction is attached once and removed again for display', () => {
  const once = withInterviewNote('Plan my day')
  assert.ok(once.startsWith('Plan my day\n\n[Interview mode is on.'))
  assert.equal(withInterviewNote(once), once)
  assert.equal(withInterviewNote('   '), '   ')
  assert.equal(stripInterviewNote(once), 'Plan my day')
  assert.equal(hasInterviewNote('Plan my day'), false)
  assert.equal(hasInterviewNote(once), true)
  assert.match(INTERVIEW_NOTE, /ask_user_question/)
  assert.match(INTERVIEW_NOTE, /No questions needed\./)
})

test('interview and voice notes can ride on the same message and both are hidden', () => {
  setVoiceNoteOn(true)
  try {
    const wire = withVoiceNote(withInterviewNote('Plan my day'))
    assert.ok(hasInterviewNote(wire))
    assert.match(wire, /\[Voice mode is on\./)
    assert.equal(stripVoiceNote(wire), 'Plan my day')
  } finally { setVoiceNoteOn(false) }
})

test('a reply in plain text needs a reminder', () => {
  const now = 2_000_000
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(5, 'Sure. Do you want mornings or afternoons?')], now), 3)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(4, ''), reply(6, 'Here is the plan.')], now), 3)
})

test('no reminder when the agent asked through the question tool', () => {
  const now = 2_000_000
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), question(4)], now), -1)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(4, 'Let me start.'), question(6), reply(8, 'Here is the plan.')], now), -1)
})

test('no reminder when the reply says it had nothing to ask', () => {
  const now = 2_000_000
  assert.equal(reminderTarget([user(3, asked('Say OK'), now), reply(5, 'No questions needed. OK.')], now), -1)
  assert.equal(reminderTarget([user(3, asked('Say OK'), now), reply(5, '**No questions needed.**\n\nOK.')], now), -1)
  assert.equal(reminderTarget([user(3, asked('Say OK'), now), reply(5, 'Questions needed: none.')], now), 3)
})

test('no reminder when there is nothing to remind about', () => {
  const now = 2_000_000
  assert.equal(reminderTarget([], now), -1)
  assert.equal(reminderTarget([user(3, 'Plan my day', now), reply(5, 'Sure.')], now), -1)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(5, 'Working...'), user(7, 'never mind, just answer', now), reply(9, 'Sure.')], now), -1)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(5, 'Sure.')], now + 31 * 60_000), -1)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now)], now), -1)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), { seq: 4, role: 'toolResult', blocks: [{ type: 'text', text: 'x' }] }], now), -1)
})

test('the reminder text is a plain message that does not retrigger itself', () => {
  const now = 2_000_000
  assert.equal(hasInterviewNote(INTERVIEW_REMINDER), false)
  assert.equal(reminderTarget([user(3, asked('Plan my day'), now), reply(5, 'Sure.'), user(6, INTERVIEW_REMINDER, now), reply(8, 'Working...')], now), -1)
})

test('the switch moves from the New chat screen to the conversation it starts', () => {
  resetNewInterview()
  setInterviewOn('session-a', false)
  assert.equal(isInterviewOn('session-a'), false)
  assert.equal(isInterviewOn(undefined), false)
  setInterviewOn(undefined, true)
  assert.equal(isInterviewOn(undefined), true)
  adoptInterviewSession('session-a')
  assert.equal(isInterviewOn('session-a'), true)
  assert.equal(isInterviewOn(undefined), false)
  setInterviewOn('session-a', false)
  assert.equal(isInterviewOn('session-a'), false)
})

test('the "No questions needed." opener is hidden only when it opens the reply', () => {
  assert.equal(stripNoQuestions('No questions needed.\n\nThe capital of France is Paris.'), 'The capital of France is Paris.')
  assert.equal(stripNoQuestions('**No questions needed.**\n\nOK.'), 'OK.')
  assert.equal(stripNoQuestions('No questions needed. Paris is the capital.'), 'Paris is the capital.')
  assert.equal(stripNoQuestions('No questions needed here, so here is the plan.'), 'No questions needed here, so here is the plan.')
  assert.equal(stripNoQuestions('Paris.'), 'Paris.')
})

test('a reminder is recognised by its opening words, whatever version sent it', () => {
  assert.equal(isInterviewReminder(INTERVIEW_REMINDER), true)
  assert.equal(isInterviewReminder('Interview mode is on. Ask me with the question tool: one question with options, before you answer. If nothing needs asking, start your reply with "No questions needed."'), true)
  assert.equal(isInterviewReminder('Interview mode is on. Can you remind me how to turn this off?'), false)
  assert.equal(isInterviewReminder('Plan my day'), false)
})
