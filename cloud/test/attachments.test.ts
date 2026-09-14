import test from 'node:test'
import assert from 'node:assert/strict'
import { checkFiles, type Attachment } from '../src/attachments.ts'
import { blankConversation, blankSpace, saveSpaces, restoreSpaces } from '../src/state.ts'

test('file limits reject executables, oversized files and oversized groups', () => {
  assert.throws(() => checkFiles([{ name: 'run.sh', size: 100 }], []))
  assert.throws(() => checkFiles([{ name: 'large.pdf', size: 26 * 1024 * 1024 }], []))
  assert.throws(() =>
    checkFiles(
      Array.from({ length: 5 }, () => ({ name: 'doc.pdf', size: 25 * 1024 * 1024 })),
      []
    )
  )
  assert.doesNotThrow(() =>
    checkFiles(
      [
        { name: 'brief.PDF', size: 100 },
        { name: 'photo.png', size: 300 }
      ],
      []
    )
  )
})
test('browser reopening retains computer-bound ready files and resumable upload identities', () => {
  let value = ''
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => value,
      setItem: (_k: string, v: string) => {
        value = v
      }
    }
  })
  const file: Attachment = {
    id: 'client',
    name: 'brief.pdf',
    size: 100,
    progress: 100,
    status: 'ready',
    attachmentId: 'remote',
    sessionId: 'stored'
  }
  const one = {
    ...blankSpace(),
    conversations: { 'default/s': { ...blankConversation(), sessionId: 'stored', attachments: [file] } }
  }
  const two = {
    ...blankSpace(),
    conversations: {
      'default/s': {
        ...blankConversation(),
        sessionId: 'different',
        attachments: [{ ...file, id: 'unfinished', status: 'uploading' as const }]
      }
    }
  }
  saveSpaces({ one, two })
  const restored = restoreSpaces()
  assert.equal(restored.one.conversations['default/s'].attachments[0].attachmentId, 'remote')
  assert.equal(restored.two.conversations['default/s'].attachments[0].status, 'error')
  assert.equal(restored.two.conversations['default/s'].sessionId, 'different')
  assert.equal(restored.two.conversations['default/s'].attachments[0].id, 'unfinished')
})
