import assert from 'node:assert/strict'

import { test, beforeEach } from 'vitest'
import { configureStudioBinding } from './studio-policy'

import {
  enforceOrgoComputerBinding,
  fetchOrgoDesktopSession,
  normalizeOptionalOrgoComputerId,
  normalizeOrgoComputerId,
  parseOrgoCliApiKey,
  privateOrgoWebsocketUrl,
  resolveOrgoDesktopProfile,
  serializeOrgoDesktopError
} from './orgo-desktop'
import type { OrgoDesktopError } from './orgo-desktop'

const COMPUTER_ID = 'ef2f6e29-3864-494b-a82c-15280c5d9f9e'
beforeEach(() => configureStudioBinding(() => COMPUTER_ID))

test('reads only the active API key from the official Orgo CLI credential shape', () => {
  const raw = JSON.stringify({
    current: 'work',
    profiles: {
      default: { apiKey: 'wrong-key' },
      work: { apiKey: '  active-key  ', workspaceId: 'not-returned' }
    }
  })

  assert.equal(parseOrgoCliApiKey(raw), 'active-key')
  assert.equal(parseOrgoCliApiKey('{broken'), '')
  assert.equal(parseOrgoCliApiKey({ current: 'missing', profiles: {} }), '')
})

test('normalizes a valid Orgo computer id and rejects malformed input', () => {
  assert.equal(normalizeOrgoComputerId(` ${COMPUTER_ID} `), COMPUTER_ID)
  assert.throws(
    () => normalizeOrgoComputerId('dewey'),
    error => {
      assert.equal((error as OrgoDesktopError).code, 'invalid-config')

      return true
    }
  )
})

test('allows the key-only onboarding stage before a computer id exists', () => {
  assert.equal(normalizeOptionalOrgoComputerId(undefined), '')
  assert.equal(normalizeOptionalOrgoComputerId('   '), '')
  assert.equal(normalizeOptionalOrgoComputerId(` ${COMPUTER_ID} `), COMPUTER_ID)
  assert.throws(() => normalizeOptionalOrgoComputerId('dewey'))
})

test('locks an app instance to its first Orgo computer', () => {
  assert.equal(enforceOrgoComputerBinding('', COMPUTER_ID), COMPUTER_ID)
  assert.equal(enforceOrgoComputerBinding(COMPUTER_ID, ''), COMPUTER_ID)
  assert.equal(enforceOrgoComputerBinding(COMPUTER_ID, COMPUTER_ID.toUpperCase()), COMPUTER_ID)
  assert.throws(
    () => enforceOrgoComputerBinding(COMPUTER_ID, '7e776a93-27e2-44ff-b213-00664fbe5e23'),
    error => {
      assert.equal((error as OrgoDesktopError).code, 'invalid-config')
      assert.match((error as Error).message, /already locked/i)

      return true
    }
  )
})

test('builds a private VNC URL only for Tailscale hosts', () => {
  assert.equal(
    privateOrgoWebsocketUrl('100.108.144.54', 'a token'),
    'ws://100.108.144.54:6080/websockify?token=a%20token'
  )
  assert.equal(
    privateOrgoWebsocketUrl('orgo-desktop.tailce1618.ts.net', 'secret'),
    'ws://orgo-desktop.tailce1618.ts.net:6080/websockify?token=secret'
  )
  assert.equal(privateOrgoWebsocketUrl('185.209.179.145', 'secret'), null)
  assert.equal(privateOrgoWebsocketUrl('example.com', 'secret'), null)
})

test('inherits the default desktop binding unless an agent has an explicit override', () => {
  const profiles = {
    default: { computerId: 'default-computer' },
    researcher: { computerId: 'research-computer' }
  }

  assert.deepEqual(resolveOrgoDesktopProfile(profiles, 'default'), {
    entry: profiles.default,
    inheritedFromDefault: false
  })
  assert.deepEqual(resolveOrgoDesktopProfile(profiles, 'inbox-triage'), {
    entry: profiles.default,
    inheritedFromDefault: true
  })
  assert.deepEqual(resolveOrgoDesktopProfile(profiles, 'researcher'), {
    entry: profiles.researcher,
    inheritedFromDefault: false
  })
  assert.deepEqual(resolveOrgoDesktopProfile({}, 'inbox-triage'), {
    entry: undefined,
    inheritedFromDefault: false
  })
})

test('fetches fresh computer metadata and VNC credentials without exposing the API key in the result', async () => {
  const calls: Array<{ input: string; auth: string | null }> = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const headers = new Headers(init?.headers)
    calls.push({ input: url, auth: headers.get('Authorization') })

    return Response.json({
      id: COMPUTER_ID,
      name: 'Dewey',
      instance_id: '8b517302',
      status: 'running',
      vnc_password: 'vnc secret'
    })
  }) as typeof fetch

  const session = await fetchOrgoDesktopSession({ apiKey: 'orgo-secret', computerId: COMPUTER_ID }, fetchImpl)

  assert.deepEqual(session, {
    computerId: COMPUTER_ID,
    computerName: 'Dewey',
    instanceId: '8b517302',
    status: 'running',
    websocketUrl: 'wss://www.orgo.ai/desktops/8b517302/ws/websockify?token=vnc%20secret',
    password: 'vnc secret'
  })
  assert.equal(JSON.stringify(session).includes('orgo-secret'), false)
  assert.equal(calls.length, 1)
  assert.equal(
    calls.every(call => call.auth === 'Bearer orgo-secret'),
    true
  )
})

test('supports legacy computers that still return fly_instance_id', async () => {
  const fetchImpl = (async (input: string | URL | Request) =>
    String(input).endsWith('/vnc-password')
      ? Response.json({ password: 'vnc-secret' })
      : Response.json({ id: COMPUTER_ID, fly_instance_id: '8b517302' })) as typeof fetch

  const session = await fetchOrgoDesktopSession({ apiKey: 'orgo-secret', computerId: COMPUTER_ID }, fetchImpl)

  assert.equal(session.instanceId, '8b517302')
  assert.equal(session.websocketUrl, 'wss://www.orgo.ai/desktops/8b517302/ws/websockify?token=vnc-secret')
})

test('classifies authentication and malformed-response failures', async () => {
  const rejectedFetch = (async () => new Response('', { status: 401 })) as typeof fetch

  await assert.rejects(fetchOrgoDesktopSession({ apiKey: 'bad', computerId: COMPUTER_ID }, rejectedFetch), error => {
    assert.equal(serializeOrgoDesktopError(error).code, 'auth-failed')

    return true
  })

  const malformedFetch = (async (input: string | URL | Request) =>
    String(input).endsWith('/vnc-password')
      ? Response.json({ password: '' })
      : Response.json({ fly_instance_id: '' })) as typeof fetch

  await assert.rejects(fetchOrgoDesktopSession({ apiKey: 'key', computerId: COMPUTER_ID }, malformedFetch), error => {
    assert.equal(serializeOrgoDesktopError(error).code, 'invalid-response')

    return true
  })
})

test('an unbound recipient cannot send credentials to a computer request', async () => {
  configureStudioBinding(() => '')
  let fetched=false
  await assert.rejects(fetchOrgoDesktopSession({apiKey:'unit-test-placeholder',computerId:COMPUTER_ID}, (async()=>{fetched=true;return Response.json({})}) as typeof fetch), /configured for this installation/)
  assert.equal(fetched,false)
})
