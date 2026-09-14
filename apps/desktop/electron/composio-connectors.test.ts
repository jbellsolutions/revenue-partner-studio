import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  COMPOSIO_MCP_SERVER_NAME,
  COMPOSIO_MCP_TRUST,
  type ComposioClientLike,
  type ComposioConnectedAccountLike,
  type ComposioMcpEntry,
  type ComposioSessionLike,
  createComposioBroker,
  isSecureHttpsRedirectUrl,
  keyHintFrom,
  mergeMcpServers,
  normalizeAccountStatus,
  publicError,
  redactComposioSecrets,
  UnsafeRedirectUrlError
} from './composio-connectors'
import { type ComposioStoredState, type ComposioStoreIo, createComposioStore } from './composio-store'

function createFakeDisk(initialText: string | null = null): { io: ComposioStoreIo; fileText: () => string | null; logs: string[] } {
  let text = initialText
  const logs: string[] = []

  return {
    logs,
    fileText: () => text,
    io: {
      encrypt: plaintext => ({ encoding: 'safeStorage', value: Buffer.from(plaintext, 'utf8').toString('base64') }),
      decrypt: secret =>
        secret && typeof secret === 'object' && (secret as { encoding?: string }).encoding === 'safeStorage'
          ? Buffer.from(String((secret as { value?: string }).value), 'base64').toString('utf8')
          : '',
      readStoreText: () => {
        if (text === null) {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
        }

        return text
      },
      writeStoreText: next => {
        text = next
      },
      rememberLog: message => logs.push(message)
    }
  }
}

function mcpEntry(url = 'https://mcp.composio.dev/session/abc'): ComposioMcpEntry {
  return {
    url,
    headers: { 'x-api-key': 'secret-header' },
    connect_timeout: 180,
    trust: COMPOSIO_MCP_TRUST
  }
}

function fakeSession(overrides: Partial<ComposioSessionLike> & { slug?: string } = {}): ComposioSessionLike {
  return {
    sessionId: overrides.sessionId || 'sess-1',
    mcp: overrides.mcp || { url: 'https://mcp.composio.dev/s1', headers: { authorization: 'Bearer sess' } },
    authorize: overrides.authorize || (async slug => ({ id: `req-${slug}`, status: 'INITIATED', redirectUrl: `https://connect.composio.dev/${slug}` })),
    toolkits: overrides.toolkits
  }
}

function fakeClient(options: {
  accounts?: ComposioConnectedAccountLike[]
  authorize?: ComposioSessionLike['authorize']
  categories?: unknown[]
  catalog?: unknown[]
  create?: (userId: string, config: { toolkits?: string[] }) => Promise<ComposioSessionLike>
  use?: (id: string) => Promise<ComposioSessionLike>
  deletes?: string[]
  disables?: string[]
  failValidate?: boolean
} = {}): ComposioClientLike {
  const accounts = options.accounts || []
  const deletes = options.deletes || []
  const disables = options.disables || []

  return {
    toolkits: {
      get: async () => ({ items: options.catalog || [], nextCursor: null }),
      listCategories: async () => {
        if (options.failValidate) {
          throw new Error('invalid api key ak_live_supersecret')
        }

        return { items: options.categories || [{ id: 'popular', name: 'Popular' }] }
      }
    },
    sessions: {
      create: async (userId, config) => {
        if (options.create) {
          return options.create(userId, config)
        }

        return fakeSession({ sessionId: `sess-${(config.toolkits || []).join(',') || 'none'}`, authorize: options.authorize })
      },
      use: async id => {
        if (options.use) {
          return options.use(id)
        }

        return fakeSession({ sessionId: id, authorize: options.authorize })
      }
    },
    connectedAccounts: {
      list: async query => ({
        items: accounts.filter(item => {
          if (query.toolkitSlugs?.length) {
            return query.toolkitSlugs.includes(String(item.toolkit?.slug || ''))
          }

          return true
        })
      }),
      delete: async id => {
        deletes.push(id)
        const index = accounts.findIndex(item => item.id === id)

        if (index >= 0) {
          accounts.splice(index, 1)
        }

        return {}
      },
      disable: async id => {
        disables.push(id)

        return {}
      }
    }
  }
}

test('encrypted key round trip survives a fresh load', () => {
  const disk = createFakeDisk()
  const store = createComposioStore(disk.io)

  const state: ComposioStoredState = {
    apiKey: 'ak_live_project_secret',
    userId: '11111111-1111-4111-8111-111111111111',
    keyHint: 'cret',
    sessions: { inbox: { sessionId: 'sess-1', toolkitKey: 'gmail' } }
  }

  store.save(state)

  const file = disk.fileText()
  assert.ok(file)
  assert.doesNotMatch(file, /ak_live_project_secret/)
  assert.doesNotMatch(file, /sess-1/)

  const restarted = createComposioStore(createFakeDisk(file).io)
  const loaded = restarted.load()

  assert.deepEqual(loaded, state)
})

test('failed key validation does not persist the candidate key', async () => {
  const disk = createFakeDisk()
  const mcp = { upsert: async () => undefined, remove: async () => undefined }

  const broker = createComposioBroker({
    store: createComposioStore(disk.io),
    createClient: async () => fakeClient({ failValidate: true }),
    openExternal: async () => undefined,
    mcp,
    randomUuid: () => '22222222-2222-4222-8222-222222222222'
  })

  await assert.rejects(() => broker.saveKey('ak_live_supersecret'), /invalid api key ak_\*\*\*/)
  assert.equal(broker.keyStatus().configured, false)
  assert.equal(disk.fileText(), null)
})

test('redaction strips keys, bearer tokens, and query strings', () => {
  const redacted = redactComposioSecrets('invalid ak_live_supersecret Bearer abc.def https://mcp.composio.dev/x?token=1')

  assert.doesNotMatch(redacted, /ak_live_supersecret/)
  assert.doesNotMatch(redacted, /Bearer abc/)
  assert.doesNotMatch(redacted, /token=1/)
  assert.equal(keyHintFrom('ak_live_supersecret'), '••••cret')
  assert.match(publicError(new Error('failed ak_live_supersecret')).message, /ak_\*\*\*/)
  assert.match(publicError(new Error('Invalid API key: ck_secretkeyxyz')).message, /ck_\*\*\*/)
  assert.doesNotMatch(redactComposioSecrets('Invalid API key: ck_secretkeyxyz'), /ck_secretkeyxyz/)
})

test('safe redirect enforcement rejects credential-bearing and non-HTTPS URLs', () => {
  assert.equal(isSecureHttpsRedirectUrl('https://connect.composio.dev/gmail'), true)
  assert.equal(isSecureHttpsRedirectUrl('http://connect.composio.dev/gmail'), false)
  assert.equal(isSecureHttpsRedirectUrl('https://user:pass@connect.composio.dev/gmail'), false)
  assert.equal(isSecureHttpsRedirectUrl('javascript:alert(1)'), false)
  assert.equal(isSecureHttpsRedirectUrl('not a url'), false)
})

test('authorize refuses an unsafe redirect before opening a browser', async () => {
  const opened: string[] = []

  const broker = createComposioBroker({
    store: createComposioStore(createFakeDisk().io),
    createClient: async () =>
      fakeClient({
        authorize: async () => ({ id: 'req-1', status: 'INITIATED', redirectUrl: 'http://evil.example/gmail' })
      }),
    openExternal: async url => {
      opened.push(url)
    },
    mcp: { upsert: async () => undefined, remove: async () => undefined },
    randomUuid: () => '33333333-3333-4333-8333-333333333333'
  })

  await broker.saveKey('ak_live_validkey')
  await assert.rejects(() => broker.authorize('gmail'), UnsafeRedirectUrlError)
  assert.deepEqual(opened, [])
})

test('authorize opens a hosted HTTPS Connect Link and poll waits until ACTIVE', async () => {
  const opened: string[] = []
  const accounts: ComposioConnectedAccountLike[] = []
  let ticks = 0

  const broker = createComposioBroker({
    store: createComposioStore(createFakeDisk().io),
    createClient: async () => fakeClient({ accounts }),
    openExternal: async url => {
      opened.push(url)
    },
    mcp: { upsert: async () => undefined, remove: async () => undefined },
    now: () => {
      ticks += 1

      return ticks * 1_000
    },
    sleep: async () => {
      accounts.splice(0, accounts.length, {
        id: 'acc-gmail',
        status: 'ACTIVE',
        toolkit: { slug: 'gmail', name: 'Gmail' }
      })
    },
    randomUuid: () => '44444444-4444-4444-8444-444444444444'
  })

  await broker.saveKey('ak_live_validkey')
  const pending = await broker.authorize('gmail')

  assert.equal(pending.status, 'pending')
  assert.equal(pending.opened, true)
  assert.deepEqual(opened, ['https://connect.composio.dev/gmail'])

  const done = await broker.poll('gmail')
  assert.equal(done.status, 'connected')
  assert.equal(done.accountId, 'acc-gmail')
})

test('session reuse keeps the same id until the toolkit set changes', async () => {
  const created: string[] = []
  const used: string[] = []

  const broker = createComposioBroker({
    store: createComposioStore(createFakeDisk().io),
    createClient: async () =>
      fakeClient({
        accounts: [{ id: 'acc-1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }],
        create: async (_userId, config) => {
          created.push(toolkitKey(config.toolkits))

          return fakeSession({ sessionId: `sess-${created.length}` })
        },
        use: async id => {
          used.push(id)

          return fakeSession({ sessionId: id })
        }
      }),
    openExternal: async () => undefined,
    mcp: { upsert: async () => undefined, remove: async () => undefined },
    randomUuid: () => '55555555-5555-4555-8555-555555555555'
  })

  await broker.saveKey('ak_live_validkey')
  await broker.syncProfiles(['alpha'])
  await broker.syncProfiles(['alpha'])

  assert.deepEqual(created, ['gmail'])
  assert.deepEqual(used, ['sess-1'])
})

test('disconnect revokes then deletes only owned accounts', async () => {
  const deletes: string[] = []
  const disables: string[] = []

  const broker = createComposioBroker({
    store: createComposioStore(createFakeDisk().io),
    createClient: async () =>
      fakeClient({
        accounts: [
          { id: 'mine', status: 'ACTIVE', toolkit: { slug: 'slack' } },
          { id: 'other', status: 'ACTIVE', toolkit: { slug: 'gmail' } }
        ],
        deletes,
        disables
      }),
    openExternal: async () => undefined,
    mcp: { upsert: async () => undefined, remove: async () => undefined },
    randomUuid: () => '66666666-6666-4666-8666-666666666666'
  })

  await broker.saveKey('ak_live_validkey')
  await broker.disconnect('slack')

  assert.deepEqual(disables, ['mine'])
  assert.deepEqual(deletes, ['mine'])
})

test('key replacement clears cached session identifiers', async () => {
  const disk = createFakeDisk()
  const store = createComposioStore(disk.io)

  const broker = createComposioBroker({
    store,
    createClient: async () => fakeClient(),
    openExternal: async () => undefined,
    mcp: { upsert: async () => undefined, remove: async () => undefined },
    randomUuid: () => '77777777-7777-4777-8777-777777777777'
  })

  await broker.saveKey('ak_live_firstkeyxx')
  store.save({
    ...(store.load() as ComposioStoredState),
    sessions: { alpha: { sessionId: 'old-session', toolkitKey: 'gmail' } }
  })

  await broker.saveKey('ak_live_secondkeyx')
  const next = store.load()

  assert.equal(next?.apiKey, 'ak_live_secondkeyx')
  assert.deepEqual(next?.sessions, {})
  assert.equal(next?.userId, '77777777-7777-4777-8777-777777777777')
})

test('MCP merge preserves unrelated servers and stays untrusted', () => {
  const existing = {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    composio: { url: 'https://stale.example', trust: 'full' }
  }

  const merged = mergeMcpServers(existing, mcpEntry())

  assert.deepEqual(merged.filesystem, existing.filesystem)
  assert.equal(merged[COMPOSIO_MCP_SERVER_NAME].trust, 'untrusted')
  assert.equal(merged[COMPOSIO_MCP_SERVER_NAME].url, 'https://mcp.composio.dev/session/abc')
  assert.equal(mergeMcpServers(existing, null).composio, undefined)
})

test('profile sync writes every bot and removes stale mappings', async () => {
  const upserts: string[] = []
  const removes: string[] = []

  const broker = createComposioBroker({
    store: createComposioStore(createFakeDisk().io),
    createClient: async () =>
      fakeClient({
        accounts: [{ id: 'acc-1', status: 'ACTIVE', toolkit: { slug: 'gmail' } }]
      }),
    openExternal: async () => undefined,
    mcp: {
      upsert: async profile => {
        upserts.push(profile)
      },
      remove: async profile => {
        removes.push(profile)
      }
    },
    randomUuid: () => '88888888-8888-4888-8888-888888888888'
  })

  await broker.saveKey('ak_live_validkey')
  await broker.syncProfiles(['default', 'inbox'])
  await broker.syncProfiles(['default'])

  assert.deepEqual(upserts, ['default', 'inbox', 'default'])
  assert.ok(removes.includes('inbox'))
})

test('consumer ck_ keys validate against Connect MCP and skip the project SDK', async () => {
  const disk = createFakeDisk()
  const sdkCalls: string[] = []
  const upserts: Array<{ profile: string; url: string; header: string }> = []

  const broker = createComposioBroker({
    store: createComposioStore(disk.io),
    createClient: async () => {
      sdkCalls.push('create')

      return fakeClient({ failValidate: true })
    },
    createConnectClient: () => ({
      validate: async () => undefined,
      listCatalog: async () => ({ items: [], nextCursor: null }),
      connections: async () => [],
      authorize: async () => ({ redirectUrl: null, connected: false, status: 'pending' })
    }),
    openExternal: async () => undefined,
    mcp: {
      upsert: async (profile, entry) => {
        upserts.push({ profile, url: entry.url, header: entry.headers['x-consumer-api-key'] || '' })
      },
      remove: async () => undefined
    },
    randomUuid: () => '99999999-9999-4999-8999-999999999999'
  })

  await broker.saveKey('ck_connectconsumerkey')
  assert.equal(broker.keyStatus().configured, true)
  assert.deepEqual(sdkCalls, [])

  await broker.syncProfiles(['default', 'inbox'])
  assert.equal(upserts.length, 2)
  assert.equal(upserts[0]?.url, 'https://connect.composio.dev/mcp')
  assert.equal(upserts[0]?.header, 'ck_connectconsumerkey')
})

test('invalid consumer keys are not persisted', async () => {
  const disk = createFakeDisk()

  const broker = createComposioBroker({
    store: createComposioStore(disk.io),
    createClient: async () => fakeClient(),
    createConnectClient: () => ({
      validate: async () => {
        throw new Error('Invalid API key: ck_badkeyxxxxx')
      },
      listCatalog: async () => ({ items: [], nextCursor: null }),
      connections: async () => [],
      authorize: async () => ({ redirectUrl: null, connected: false, status: 'pending' })
    }),
    openExternal: async () => undefined,
    mcp: { upsert: async () => undefined, remove: async () => undefined }
  })

  await assert.rejects(() => broker.saveKey('ck_badkeyxxxxx'), /ck_\*\*\*/)
  assert.equal(broker.keyStatus().configured, false)
  assert.equal(disk.fileText(), null)
})

test('normalizeAccountStatus fails closed for unknown values', () => {
  assert.equal(normalizeAccountStatus('ACTIVE'), 'connected')
  assert.equal(normalizeAccountStatus('INITIATED'), 'pending')
  assert.equal(normalizeAccountStatus('EXPIRED'), 'error')
  assert.equal(normalizeAccountStatus('WAT'), 'disconnected')
  assert.equal(normalizeAccountStatus('ACTIVE', true), 'disconnected')
})

function toolkitKey(slugs: string[] | undefined): string {
  return [...(slugs || [])].sort().join(',')
}
