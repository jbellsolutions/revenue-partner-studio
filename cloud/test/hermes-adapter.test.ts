import assert from 'node:assert/strict'
import test from 'node:test'
import { hermesAdapter } from '../src/hermes-adapter'

test('save and check validates the entered key only after saving to its computer/profile; never submits chat', async () => {
  const previous = globalThis.fetch, calls: any[] = []
  globalThis.fetch = (async (url, init) => {
    const body = JSON.parse(String(init?.body)); calls.push({url, ...body})
    return new Response(JSON.stringify({saved: true, status: 'verified'}), {status: 200})
  }) as typeof fetch
  try {
    let cleared = false
    await hermesAdapter('computer-A','same-name','session-A').saveAndCheck('openrouter', ' typed-key ', () => { cleared = true; assert.equal(calls.length, 1) })
    assert(cleared)
    assert.deepEqual(calls.map(c => c.method), ['providers.configure','providers.check'])
    assert.equal(calls[0].params.apiKey, 'typed-key')
    assert.equal(calls[1].params.apiKey, undefined)
    assert(calls.every(c => c.url.includes('/computer-A/') && c.params.agentId === 'same-name'))
    assert.notEqual(hermesAdapter('computer-A','same-name').key, hermesAdapter('computer-B','same-name').key)
  } finally { globalThis.fetch = previous }
})

test('failed save retains entered key and does not validate a different saved credential', async () => {
  const previous = globalThis.fetch; let count = 0, cleared = false
  globalThis.fetch = (async () => {count++;return new Response(JSON.stringify({error:'Profile busy'}), {status:409})}) as typeof fetch
  try {
    await assert.rejects(hermesAdapter('A','email').saveAndCheck('openrouter','new-key',()=>{cleared=true}), /Profile busy/)
    assert.equal(count,1); assert.equal(cleared,false)
  } finally { globalThis.fetch = previous }
})
