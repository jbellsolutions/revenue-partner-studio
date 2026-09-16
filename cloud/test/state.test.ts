import test from 'node:test'
import assert from 'node:assert/strict'
import { blankConversation, blankSpace, reduceEvent, runtimeHealth } from '../src/state.ts'
test('late replies cannot populate a different conversation with the same profile name', () => {
  const a = { ...blankSpace(), conversations: { 'default/one': { ...blankConversation(), runtimeId: 'a' } } }
  const b = { ...blankSpace(), conversations: { 'default/one': { ...blankConversation(), runtimeId: 'b' } } }
  const event = { seq: 1, agentId: 'default', runtimeId: 'a', kind: 'message.delta', payload: { text: 'Only A' } }
  assert.equal(reduceEvent(a, event).conversations['default/one'].stream, 'Only A')
  assert.equal(reduceEvent(b, event).conversations['default/one'].stream, '')
  assert.equal(a.conversations['default/one'].stream, '')
})
test('replayed event cannot duplicate assistant content', () => {
  let s: ReturnType<typeof blankSpace> = {
    ...blankSpace(),
    conversations: { 'default/one': { ...blankConversation(), runtimeId: 'r' } }
  }
  const e = { seq: 2, agentId: 'default', runtimeId: 'r', kind: 'message.complete', payload: { text: 'Done' } }
  s = reduceEvent(s, e)
  assert.equal(reduceEvent(s, e).conversations['default/one'].messages.length, 1)
})

test('agent history results become structured cards only in the requesting conversation', () => {
  const match = { profileId: 'default', title: 'Revenue notes', preview: 'pipeline', source: 'desktop',
    ref: { computerId: 'computer-a', profileId: 'default', storeId: 'store-a', sessionId: 'saved-a' } }
  const space = { ...blankSpace(), conversations: {
    'default/one': { ...blankConversation(), runtimeId: 'one' },
    'default/two': { ...blankConversation(), runtimeId: 'two' }
  } }
  const result = reduceEvent(space, { seq: 1, agentId: 'default', runtimeId: 'one',
    kind: 'history.matches', payload: { matches: [match] } })
  assert.deepEqual(result.conversations['default/one'].historyMatches, [match])
  assert.deepEqual(result.conversations['default/two'].historyMatches, [])
})

test('runtime loss preserves draft/history selection and requires a new runtime attachment', () => {
  const s = {
    ...blankSpace(),
    conversations: {
      'default/one': { ...blankConversation(), runtimeId: 'old', sessionId: 'saved', draft: 'Keep this' }
    }
  }
  const recovered = reduceEvent(s, { seq: 8, kind: 'runtime.disconnected' }).conversations['default/one']
  assert.equal(recovered.runtimeId, '')
  assert.equal(recovered.sessionId, 'saved')
  assert.equal(recovered.draft, 'Keep this')
})
test('history restored from a snapshot does not duplicate older replayed replies', () => {
  const s = {
    ...blankSpace(),
    conversations: {
      'default/one': {
        ...blankConversation(),
        runtimeId: 'r',
        afterSeq: 20,
        messages: [{ id: 1, role: 'assistant', content: 'Already saved' }]
      }
    }
  }
  assert.equal(
    reduceEvent(s, {
      seq: 15,
      kind: 'message.complete',
      runtimeId: 'r',
      agentId: 'default',
      payload: { text: 'Already saved' }
    }).conversations['default/one'].messages.length,
    1
  )
})

test('late task acknowledgment clears only the matching pending message', () => {
  const packet = { requestId: 'task-a', runtimeId: 'a', text: 'Please read', attachmentIds: ['file-a'] }
  const a = { ...blankConversation(), runtimeId: 'a', pendingSend: packet, draft: 'Please read' }
  const b = { ...blankConversation(), runtimeId: 'b', pendingSend: { ...packet, requestId: 'task-b' }, draft: 'Keep B' }
  const result = reduceEvent(
    { ...blankSpace(), conversations: { 'default/a': a, 'default/b': b } },
    { seq: 1, kind: 'studio.task', payload: { id: 'task-a', runtime_id: 'a', state: 'queued' } }
  )
  assert.equal(result.conversations['default/a'].pendingSend, undefined)
  assert.equal(result.conversations['default/b'].pendingSend?.requestId, 'task-b')
  assert.equal(result.conversations['default/b'].draft, 'Keep B')
})

test('historical disconnects cannot turn a healthy computer offline or discard its live session', () => {
  const s = { ...blankSpace(), online: true, healthCursor: 90,
    conversations: { 'default/one': { ...blankConversation(), runtimeId: 'live', draft: 'keep' } } }
  const old = reduceEvent(s, { seq: 80, kind: 'runtime.disconnected', replay: true })
  assert.equal(old.online, true)
  assert.equal(old.conversations['default/one'].runtimeId, 'live')
  const current = reduceEvent(old, { seq: 91, kind: 'runtime.disconnected' })
  assert.equal(current.online, false)
  assert.equal(current.conversations['default/one'].runtimeId, '')
  assert.equal(current.conversations['default/one'].draft, 'keep')
})

test('an expired session is detached without replacing its stored history or model', () => {
  const s = { ...blankSpace(), online: true, conversations: {
    'default/one': { ...blankConversation(), runtimeId: 'old', sessionId: 'stored', model: 'chosen', draft: 'keep' }
  } }
  const next = reduceEvent(s, { seq: 1, kind: 'session.reclaimed', runtimeId: 'old', agentId: 'default' })
  assert.equal(next.conversations['default/one'].runtimeId, '')
  assert.equal(next.conversations['default/one'].sessionId, 'stored')
  assert.equal(next.conversations['default/one'].model, 'chosen')
  assert.equal(next.online, true)
})

test('a stale health response cannot replace a newer runtime epoch', () => {
  const s = { ...blankSpace(), online: true, healthCursor: 100, runtimeEpoch: 'new', conversations: {
    'default/one': { ...blankConversation(), runtimeId: 'live', sessionId: 'saved', draft: 'keep' }
  } }
  assert.equal(runtimeHealth(s, { eventCursor: 90, epoch: 'old', runtimeConnected: false }), s)
  const fresh = reduceEvent(s, { seq: 101, kind: 'runtime.connected', payload: { epoch: 'next' } })
  assert.equal(fresh.conversations['default/one'].runtimeId, '')
  assert.equal(fresh.conversations['default/one'].draft, 'keep')
  assert.equal(fresh.conversations['default/one'].sessionId, 'saved')
})
