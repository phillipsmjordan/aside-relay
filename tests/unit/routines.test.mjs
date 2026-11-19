import assert from 'node:assert/strict'
import test from 'node:test'
import { describeSchedule, formatWhen, parseRoutines, parseRuns, routineStatusLabel, runStatusLabel } from '../../web/src/routines.ts'

test('schedules are described in plain words', () => {
  assert.equal(describeSchedule('DTSTART;TZID=America/New_York:20261120T090000\nRRULE:FREQ=DAILY'), 'Daily at 9:00 AM')
  assert.equal(describeSchedule('DTSTART:20261118T111947\nRRULE:FREQ=MINUTELY;INTERVAL=30'), 'Every 30 minutes')
  assert.equal(describeSchedule('DTSTART:20261027T160355\nRRULE:FREQ=MONTHLY;BYMONTHDAY=27'), 'Monthly on the 27th at 4:03 PM')
  assert.equal(describeSchedule('DTSTART;TZID=America/New_York:20261111T093000\nRRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9,11,13;BYMINUTE=30'), 'Weekdays at 9:30 AM, 11:30 AM, 1:30 PM')
  assert.equal(describeSchedule('DTSTART;TZID=America/New_York:20261118T142100\nRRULE:FREQ=DAILY;COUNT=1'), 'Once at 2:21 PM')
  assert.equal(describeSchedule('DTSTART:20261101T080000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE'), 'Weekly on Mon, Wed at 8:00 AM')
  assert.equal(describeSchedule('DTSTART:20261101T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1'), 'Monthly on the 1st at 8:00 AM')
  assert.equal(describeSchedule('DTSTART:20261101T080000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=12'), 'Monthly on the 12th at 8:00 AM')
})

test('times are relative to now and labels read plainly', () => {
  const now = new Date(2026, 10, 19, 16, 0)
  assert.equal(formatWhen(new Date(2026, 10, 19, 21, 15).toISOString(), now), 'Today 9:15 PM')
  assert.equal(formatWhen(new Date(2026, 10, 20, 9, 0).toISOString(), now), 'Tomorrow 9:00 AM')
  assert.equal(formatWhen(undefined, now), '')
  assert.equal(routineStatusLabel('paused'), 'Paused')
  assert.equal(runStatusLabel('errored'), 'Failed')
  assert.equal(runStatusLabel(undefined), 'No runs yet')
})

test('routine and run payloads are parsed defensively', () => {
  const routines = parseRoutines([{ id: 'r1', name: 'Daily', rrule: 'x', status: 'active', parentSessionId: 's1', sessionConfig: { model: { modelId: 'haiku' }, permissionMode: 'read-only' } }, null, { name: 'no id' }])
  assert.equal(routines.length, 1)
  assert.equal(routines[0].model, 'haiku')
  assert.deepEqual(parseRuns([{ id: 'a', createdAt: '2026-11-18T10:00:00Z', status: 'idle' }, { id: 'b', createdAt: '2026-11-19T10:00:00Z', status: 'errored', unread: true }]).map(run => run.id), ['b', 'a'])
  assert.deepEqual(parseRoutines('nope'), [])
})
