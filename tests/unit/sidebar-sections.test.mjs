import assert from 'node:assert/strict'
import test from 'node:test'
import { projectSections } from '../../web/src/sidebarSections.ts'

const projects = [{ id: 'soapbox', name: 'soapbox' }, { id: 'personal', name: 'personal' }, { id: 'tide-tech', name: 'TideTech' }]
const chat = (id, projectId, mtime, isPinned = false) => ({ id, projectId, mtime, isPinned })

test('sidebar sections: by project, pinned first, then newest first', () => {
  const sections = projectSections([
    chat('a', 'personal', 10), chat('b', 'soapbox', 50), chat('c', 'soapbox', 90, true), chat('d', undefined, 70),
    chat('e', 'tide-tech', 20), chat('f', 'soapbox', 10, true), chat('g', 'soapbox', 80),
  ], projects, 'newest', true)
  assert.deepEqual(sections.map(section => section.title), ['soapbox', 'personal', 'TideTech', 'No project'])
  assert.deepEqual(sections[0].sessions.map(session => session.id), ['c', 'f', 'g', 'b'])
})

test('sidebar sections: oldest-first sort, archive view ignores pins, unknown project shows its id', () => {
  const sections = projectSections([chat('x', 'gone', 5), chat('y', 'soapbox', 9, true), chat('z', 'soapbox', 3)], projects, 'oldest', false)
  assert.deepEqual(sections.map(section => section.title), ['soapbox', 'gone'])
  assert.deepEqual(sections[0].sessions.map(session => session.id), ['z', 'y'])
})
