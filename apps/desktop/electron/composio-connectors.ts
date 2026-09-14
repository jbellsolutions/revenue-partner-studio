/**
 * Privileged Composio connector broker.
 *
 * Connect consumer keys (`ck_…`) use Composio Connect MCP
 * (`x-consumer-api-key` → connect.composio.dev), matching OpenMausBot.
 * Project keys (`ak_…`) still use the Sessions API. The key and MCP
 * credentials stay in this process. Renderer IPC returns catalog/status only.
 */

import { randomUUID } from 'node:crypto'

import {
  type ComposioConnectClientLike,
  consumerMcpEntry,
  createComposioConnectClient,
  isComposioConsumerKey
} from './composio-connect'
import {
  type ComposioStore,
  type ComposioStoredState,
  type ComposioStoreIo,
  createComposioStore
} from './composio-store'

export const COMPOSIO_MCP_SERVER_NAME = 'composio'
export const COMPOSIO_MCP_TRUST = 'untrusted'
export const COMPOSIO_MCP_TIMEOUT_SECONDS = 180
export const COMPOSIO_KEY_DOCS_URL = 'https://dashboard.composio.dev'

export const FEATURED_TOOLKIT_SLUGS = [
  'gmail',
  'googlecalendar',
  'googledrive',
  'slack',
  'github',
  'notion',
  'linear',
  'outlook',
  'jira',
  'asana',
  'figma',
  'dropbox',
  'twitter',
  'discord',
  'hubspot',
  'salesforce'
] as const

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/
const AUTHORIZE_TIMEOUT_MS = 40_000
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 180_000
const DELETE_TIMEOUT_MS = 40_000

export type ConnectorStatus = 'available' | 'pending' | 'connected' | 'error' | 'disconnected'

export interface ComposioMcpEntry {
  url: string
  headers: Record<string, string>
  connect_timeout: number
  trust: typeof COMPOSIO_MCP_TRUST
}

export interface ConnectorToolkit {
  slug: string
  name: string
  description: string
  logo: string | null
  category: string
  featured: boolean
  isNoAuth: boolean
}

export interface ConnectorAccountView {
  slug: string
  name: string
  description: string
  logo: string | null
  category: string
  status: ConnectorStatus
  accountId: string | null
  statusReason: string | null
}

export interface ConnectorCategory {
  id: string
  name: string
}

export interface ComposioKeyStatus {
  configured: boolean
  hint: string | null
}

export interface AuthorizeResult {
  slug: string
  status: ConnectorStatus
  accountId: string | null
  opened: boolean
}

export interface SyncProfilesResult {
  synced: number
  removed: number
  toolkits: string[]
}

export interface ComposioSessionLike {
  sessionId: string
  mcp?: { url?: string; headers?: Record<string, string> }
  authorize: (
    toolkit: string,
    options?: { callbackUrl?: string },
    requestOptions?: { timeout?: number; maxRetries?: number; signal?: AbortSignal }
  ) => Promise<{ id?: string; status?: string; redirectUrl?: string | null }>
  toolkits?: (options?: { toolkits?: string[] }) => Promise<{ items?: unknown[] }>
}

export interface ComposioConnectedAccountLike {
  id: string
  status?: string
  statusReason?: string | null
  isDisabled?: boolean
  toolkit?: { slug?: string; name?: string }
}

export interface ComposioClientLike {
  toolkits: {
    get: (query?: Record<string, unknown>) => Promise<{ items?: unknown[]; nextCursor?: string | null; next_cursor?: string | null }>
    listCategories: () => Promise<{ items?: unknown[] } | unknown[]>
  }
  sessions: {
    create: (
      userId: string,
      config: { toolkits?: string[]; mcp?: boolean },
      requestOptions?: Record<string, unknown>
    ) => Promise<ComposioSessionLike>
    use: (id: string, options?: Record<string, unknown>) => Promise<ComposioSessionLike>
  }
  connectedAccounts: {
    list: (query: {
      userIds?: string[]
      toolkitSlugs?: string[]
      statuses?: string[]
    }) => Promise<{ items?: ComposioConnectedAccountLike[] }>
    delete: (id: string, requestOptions?: Record<string, unknown>) => Promise<unknown>
    disable?: (id: string, requestOptions?: Record<string, unknown>) => Promise<unknown>
  }
}

export interface ComposioBrokerDeps {
  store: ComposioStore
  createClient: (apiKey: string) => Promise<ComposioClientLike>
  createConnectClient?: (apiKey: string) => ComposioConnectClientLike
  openExternal: (url: string) => Promise<void>
  mcp: {
    upsert: (profile: string, entry: ComposioMcpEntry) => Promise<void>
    remove: (profile: string) => Promise<void>
  }
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  randomUuid?: () => string
}

export class UnsafeRedirectUrlError extends Error {
  constructor() {
    super('the connector consent redirect URL was not plain HTTPS — refusing to hand it to the browser')
    this.name = 'UnsafeRedirectUrlError'
  }
}

export function isSecureHttpsRedirectUrl(value: string): boolean {
  try {
    const url = new URL(value)

    return url.protocol === 'https:' && url.username === '' && url.password === ''
  } catch {
    return false
  }
}

export function redactComposioSecrets(text: string): string {
  return String(text || '')
    .replace(/\bak_[A-Za-z0-9._:-]+/g, 'ak_***')
    .replace(/\bck_[A-Za-z0-9._:-]+/g, 'ck_***')
    .replace(/Bearer\s+\S+/gi, 'Bearer ***')
    .replace(/https:\/\/[^\s"']+/gi, match => {
      try {
        const url = new URL(match)

        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''

        return `${url.origin}${url.pathname}`
      } catch {
        return '[redacted-url]'
      }
    })
}

export function keyHintFrom(apiKey: string): string {
  const trimmed = apiKey.trim()

  if (trimmed.length < 8) {
    return '••••'
  }

  return `••••${trimmed.slice(-4)}`
}

export function toolkitKeyOf(slugs: string[]): string {
  return [...new Set(slugs.map(normalizeToolkitSlug).filter(Boolean))].sort().join(',')
}

export function normalizeToolkitSlug(slug: string): string {
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
}

export function normalizeAccountStatus(raw: string | undefined, disabled?: boolean): ConnectorStatus {
  if (disabled) {
    return 'disconnected'
  }

  const value = String(raw || '').trim().toUpperCase()

  if (value === 'ACTIVE' || value === 'CONNECTED' || value === 'SUCCESS') {
    return 'connected'
  }

  if (value === 'INITIATED' || value === 'PENDING' || value === 'INITIALIZING') {
    return 'pending'
  }

  if (value === 'EXPIRED' || value === 'FAILED' || value === 'ERROR') {
    return 'error'
  }

  if (!value) {
    return 'available'
  }

  return 'disconnected'
}

export function mergeMcpServers(
  existing: Record<string, Record<string, unknown>>,
  composio: ComposioMcpEntry | null
): Record<string, Record<string, unknown>> {
  const next: Record<string, Record<string, unknown>> = {}

  for (const [name, config] of Object.entries(existing || {})) {
    if (name === COMPOSIO_MCP_SERVER_NAME) {
      continue
    }

    next[name] = config
  }

  if (composio) {
    next[COMPOSIO_MCP_SERVER_NAME] = {
      url: composio.url,
      headers: { ...composio.headers },
      connect_timeout: composio.connect_timeout,
      trust: COMPOSIO_MCP_TRUST
    }
  }

  return next
}

export function publicError(error: unknown): Error {
  if (error instanceof UnsafeRedirectUrlError) {
    return error
  }

  const message = error instanceof Error ? error.message : String(error)

  return new Error(redactComposioSecrets(message) || 'Composio request failed')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeToolkit(raw: unknown, featuredSlugs = new Set<string>(FEATURED_TOOLKIT_SLUGS)): ConnectorToolkit | null {
  const item = asRecord(raw)

  if (!item) {
    return null
  }

  const toolkit = asRecord(item.toolkit) || item
  const meta = asRecord(item.meta) || asRecord(toolkit.meta) || {}
  const slug = normalizeToolkitSlug(asString(item.slug) || asString(toolkit.slug))

  if (!slug) {
    return null
  }

  const categories = item.categories || toolkit.categories || meta.categories

  const categoryName = Array.isArray(categories)
    ? asString((asRecord(categories[0])?.name || categories[0]) as string)
    : asString(item.category) || asString(toolkit.category) || asString(meta.category)

  return {
    slug,
    name: asString(item.name) || asString(toolkit.name) || slug,
    description:
      asString(item.description) || asString(toolkit.description) || asString(meta.description) || `Connect ${slug} through Composio.`,
    logo: asString(item.logo) || asString(toolkit.logo) || asString(meta.logo) || null,
    category: categoryName || 'Other',
    featured: featuredSlugs.has(slug),
    isNoAuth: Boolean(item.noAuth || item.isNoAuth || toolkit.noAuth || toolkit.isNoAuth)
  }
}

export function normalizeCategory(raw: unknown): ConnectorCategory | null {
  if (typeof raw === 'string' && raw.trim()) {
    return { id: raw.trim(), name: raw.trim() }
  }

  const item = asRecord(raw)

  if (!item) {
    return null
  }

  const id = asString(item.id) || asString(item.slug) || asString(item.name)

  if (!id) {
    return null
  }

  return { id, name: asString(item.name) || id }
}

function ownedAccounts(items: ComposioConnectedAccountLike[] | undefined, slug?: string): ComposioConnectedAccountLike[] {
  const wanted = slug ? normalizeToolkitSlug(slug) : ''

  return (items || []).filter(item => {
    if (!item?.id) {
      return false
    }

    if (!wanted) {
      return true
    }

    return normalizeToolkitSlug(asString(item.toolkit?.slug)) === wanted
  })
}

function bestAccount(items: ComposioConnectedAccountLike[]): ComposioConnectedAccountLike | null {
  const order: ConnectorStatus[] = ['connected', 'pending', 'error', 'disconnected', 'available']
  let best: ComposioConnectedAccountLike | null = null
  let bestRank = order.length

  for (const item of items) {
    const rank = order.indexOf(normalizeAccountStatus(item.status, item.isDisabled))
    const resolved = rank < 0 ? order.length : rank

    if (resolved < bestRank) {
      best = item
      bestRank = resolved
    }
  }

  return best
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Composio request timed out')), ms)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export function createComposioBroker(deps: ComposioBrokerDeps) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const randomUuid = deps.randomUuid ?? randomUUID

  function readState(): ComposioStoredState | null {
    return deps.store.load()
  }

  function requireState(): ComposioStoredState {
    const state = readState()

    if (!state?.apiKey) {
      throw new Error('Add a Composio API key to connect apps.')
    }

    return state
  }

  async function clientFor(state: ComposioStoredState): Promise<ComposioClientLike> {
    return deps.createClient(state.apiKey)
  }

  function connectClientFor(state: ComposioStoredState): ComposioConnectClientLike {
    return (deps.createConnectClient || createComposioConnectClient)(state.apiKey)
  }

  function consumerKey(state: ComposioStoredState): boolean {
    return isComposioConsumerKey(state.apiKey)
  }

  async function ensureUserId(state: ComposioStoredState): Promise<ComposioStoredState> {
    if (state.userId && state.userId !== 'default' && !state.userId.includes('@')) {
      return state
    }

    const next = { ...state, userId: randomUuid() }
    deps.store.save(next)

    return next
  }

  async function listOwnedAccounts(client: ComposioClientLike, userId: string, slug?: string): Promise<ComposioConnectedAccountLike[]> {
    const result = await client.connectedAccounts.list({
      userIds: [userId],
      toolkitSlugs: slug ? [slug] : undefined
    })

    return ownedAccounts(result.items, slug)
  }

  async function connectedToolkitSlugs(client: ComposioClientLike, userId: string): Promise<string[]> {
    const accounts = await listOwnedAccounts(client, userId)
    const slugs = new Set<string>()

    for (const account of accounts) {
      if (normalizeAccountStatus(account.status, account.isDisabled) !== 'connected') {
        continue
      }

      const slug = normalizeToolkitSlug(asString(account.toolkit?.slug))

      if (slug) {
        slugs.add(slug)
      }
    }

    return [...slugs].sort()
  }

  async function ensureSession(
    client: ComposioClientLike,
    state: ComposioStoredState,
    profile: string,
    toolkits: string[]
  ): Promise<{ state: ComposioStoredState; session: ComposioSessionLike }> {
    const toolkitKey = toolkitKeyOf(toolkits)
    const existing = state.sessions[profile]

    if (existing && existing.toolkitKey === toolkitKey) {
      try {
        const session = await withTimeout(client.sessions.use(existing.sessionId, { mcp: true }), AUTHORIZE_TIMEOUT_MS)

        return { state, session }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const missing = /not found|404|unknown session/i.test(message)

        if (!missing) {
          throw error
        }
      }
    }

    const session = await withTimeout(
      client.sessions.create(state.userId, { toolkits, mcp: true }, { timeout: AUTHORIZE_TIMEOUT_MS, maxRetries: 0 }),
      AUTHORIZE_TIMEOUT_MS
    )

    const next: ComposioStoredState = {
      ...state,
      sessions: {
        ...state.sessions,
        [profile]: { sessionId: session.sessionId, toolkitKey }
      }
    }

    deps.store.save(next)

    return { state: next, session }
  }

  function mcpEntryFrom(session: ComposioSessionLike): ComposioMcpEntry {
    const url = asString(session.mcp?.url)
    const headers = session.mcp?.headers && typeof session.mcp.headers === 'object' ? session.mcp.headers : {}

    if (!url || !isSecureHttpsRedirectUrl(url)) {
      throw new Error('Composio did not return a hosted MCP endpoint for this session.')
    }

    const safeHeaders: Record<string, string> = {}

    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === 'string' && value) {
        safeHeaders[name] = value
      }
    }

    return {
      url,
      headers: safeHeaders,
      connect_timeout: COMPOSIO_MCP_TIMEOUT_SECONDS,
      trust: COMPOSIO_MCP_TRUST
    }
  }

  return {
    keyStatus(): ComposioKeyStatus {
      const state = readState()

      return {
        configured: Boolean(state?.apiKey),
        hint: state?.apiKey ? state.keyHint || keyHintFrom(state.apiKey) : null
      }
    },

    async saveKey(rawKey: string): Promise<ComposioKeyStatus> {
      const apiKey = String(rawKey || '').trim()

      if (!KEY_PATTERN.test(apiKey)) {
        throw new Error('That does not look like a Composio API key.')
      }

      try {
        if (isComposioConsumerKey(apiKey)) {
          await withTimeout(connectClientFor({ apiKey, userId: '', keyHint: '', sessions: {} }).validate(), AUTHORIZE_TIMEOUT_MS)
        } else {
          const client = await deps.createClient(apiKey)
          await withTimeout(client.toolkits.listCategories(), AUTHORIZE_TIMEOUT_MS)
        }
      } catch (error) {
        throw publicError(error)
      }

      const previous = readState()

      const next: ComposioStoredState = {
        apiKey,
        userId: previous?.apiKey === apiKey ? previous.userId : randomUuid(),
        keyHint: keyHintFrom(apiKey),
        sessions: previous?.apiKey === apiKey ? previous.sessions : {}
      }

      if (!next.userId || next.userId === 'default') {
        next.userId = randomUuid()
      }

      deps.store.save(next)

      return { configured: true, hint: next.keyHint }
    },

    async removeKey(): Promise<ComposioKeyStatus> {
      const state = readState()

      if (state) {
        for (const profile of Object.keys(state.sessions)) {
          try {
            await deps.mcp.remove(profile)
          } catch {
            // Best-effort: the key is still dropped even if a profile write fails.
          }
        }
      }

      deps.store.clear()

      return { configured: false, hint: null }
    },

    async listCategories(): Promise<ConnectorCategory[]> {
      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        return []
      }

      const client = await clientFor(state)
      const result = await client.toolkits.listCategories()
      const items = Array.isArray(result) ? result : result.items || []
      const categories: ConnectorCategory[] = []

      for (const item of items) {
        const category = normalizeCategory(item)

        if (category) {
          categories.push(category)
        }
      }

      return categories
    },

    async listCatalog(query: { search?: string; category?: string; cursor?: string } = {}): Promise<{
      items: ConnectorToolkit[]
      nextCursor: string | null
    }> {
      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        return connectClientFor(state).listCatalog({ search: query.search, cursor: query.cursor })
      }

      const client = await clientFor(state)
      const search = String(query.search || '').trim()
      const category = String(query.category || '').trim()
      const featured = new Set<string>(FEATURED_TOOLKIT_SLUGS)
      const request: Record<string, unknown> = { limit: 100 }

      if (search) {
        request.search = search
      }

      if (category) {
        request.category = category
      }

      if (query.cursor) {
        request.cursor = query.cursor
      }

      const result = await client.toolkits.get(request)
      const items: ConnectorToolkit[] = []

      for (const raw of result.items || []) {
        const toolkit = normalizeToolkit(raw, featured)

        if (toolkit) {
          items.push(toolkit)
        }
      }

      if (!search && !category && !query.cursor) {
        items.sort((a, b) => Number(b.featured) - Number(a.featured) || a.name.localeCompare(b.name))
      }

      return {
        items,
        nextCursor: result.nextCursor || result.next_cursor || null
      }
    },

    async listConnections(): Promise<ConnectorAccountView[]> {
      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        return connectClientFor(state).connections()
      }

      const client = await clientFor(state)
      const accounts = await listOwnedAccounts(client, state.userId)
      const bySlug = new Map<string, ComposioConnectedAccountLike[]>()

      for (const account of accounts) {
        const slug = normalizeToolkitSlug(asString(account.toolkit?.slug))

        if (!slug) {
          continue
        }

        const bucket = bySlug.get(slug) || []
        bucket.push(account)
        bySlug.set(slug, bucket)
      }

      const views: ConnectorAccountView[] = []

      for (const [slug, group] of bySlug) {
        const best = bestAccount(group)
        const status = best ? normalizeAccountStatus(best.status, best.isDisabled) : 'available'

        if (status === 'available' || status === 'disconnected') {
          continue
        }

        views.push({
          slug,
          name: asString(best?.toolkit?.name) || slug,
          description: '',
          logo: null,
          category: 'Connected',
          status,
          accountId: best?.id || null,
          statusReason: best?.statusReason || null
        })
      }

      views.sort((a, b) => a.name.localeCompare(b.name))

      return views
    },

    async authorize(slugInput: string): Promise<AuthorizeResult> {
      const slug = normalizeToolkitSlug(slugInput)

      if (!slug) {
        throw new Error('Choose an app to connect.')
      }

      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        const request = await withTimeout(connectClientFor(state).authorize(slug), AUTHORIZE_TIMEOUT_MS)
        const redirectUrl = request.redirectUrl

        if (redirectUrl != null && !isSecureHttpsRedirectUrl(redirectUrl)) {
          throw new UnsafeRedirectUrlError()
        }

        if (redirectUrl) {
          await deps.openExternal(redirectUrl)
        }

        return {
          slug,
          status: request.connected ? 'connected' : 'pending',
          accountId: null,
          opened: Boolean(redirectUrl)
        }
      }

      const client = await clientFor(state)
      const already = bestAccount(await listOwnedAccounts(client, state.userId, slug))

      if (already && normalizeAccountStatus(already.status, already.isDisabled) === 'connected') {
        return { slug, status: 'connected', accountId: already.id, opened: false }
      }

      const { session } = await ensureSession(client, state, '__connect__', [slug])

      const request = await withTimeout(
        session.authorize(slug, undefined, { timeout: AUTHORIZE_TIMEOUT_MS, maxRetries: 0 }),
        AUTHORIZE_TIMEOUT_MS
      )

      const redirectUrl = request.redirectUrl ?? null

      if (redirectUrl != null && !isSecureHttpsRedirectUrl(redirectUrl)) {
        throw new UnsafeRedirectUrlError()
      }

      if (redirectUrl) {
        await deps.openExternal(redirectUrl)
      }

      const status = normalizeAccountStatus(request.status)

      return {
        slug,
        status: status === 'available' ? (redirectUrl ? 'pending' : 'pending') : status,
        accountId: request.id || already?.id || null,
        opened: Boolean(redirectUrl)
      }
    },

    async poll(slugInput: string): Promise<AuthorizeResult> {
      const slug = normalizeToolkitSlug(slugInput)
      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        const deadline = now() + POLL_TIMEOUT_MS

        while (now() <= deadline) {
          const rows = await connectClientFor(state).connections([slug])
          const row = rows.find(item => item.slug === slug)

          if (row?.status === 'connected' || row?.status === 'error') {
            return { slug, status: row.status, accountId: row.accountId, opened: false }
          }

          await sleep(POLL_INTERVAL_MS)
        }

        const rows = await connectClientFor(state).connections([slug])
        const row = rows.find(item => item.slug === slug)

        return { slug, status: row?.status || 'pending', accountId: row?.accountId || null, opened: false }
      }

      const client = await clientFor(state)
      const deadline = now() + POLL_TIMEOUT_MS

      while (now() <= deadline) {
        const best = bestAccount(await listOwnedAccounts(client, state.userId, slug))
        const status = best ? normalizeAccountStatus(best.status, best.isDisabled) : 'pending'

        if (status === 'connected' || status === 'error') {
          return { slug, status, accountId: best?.id || null, opened: false }
        }

        await sleep(POLL_INTERVAL_MS)
      }

      const best = bestAccount(await listOwnedAccounts(client, state.userId, slug))

      return {
        slug,
        status: best ? normalizeAccountStatus(best.status, best.isDisabled) : 'pending',
        accountId: best?.id || null,
        opened: false
      }
    },

    async disconnect(slugInput: string): Promise<{ slug: string; status: ConnectorStatus }> {
      const slug = normalizeToolkitSlug(slugInput)
      const state = await ensureUserId(requireState())

      if (consumerKey(state)) {
        await deps.openExternal('https://dashboard.composio.dev')
        throw new Error('Disconnect that app from Composio → Install. Hermes will keep using the shared Connect MCP until you do.')
      }

      const client = await clientFor(state)
      const accounts = await listOwnedAccounts(client, state.userId, slug)

      if (accounts.length === 0) {
        throw new Error('That connected app was not found on this Composio user.')
      }

      for (const account of accounts) {
        try {
          if (typeof client.connectedAccounts.disable === 'function') {
            await withTimeout(client.connectedAccounts.disable(account.id, { timeout: DELETE_TIMEOUT_MS, maxRetries: 0 }), DELETE_TIMEOUT_MS)
          }
        } catch {
          // Revoke is best-effort; deletion still has to run.
        }

        await withTimeout(client.connectedAccounts.delete(account.id, { timeout: DELETE_TIMEOUT_MS, maxRetries: 0 }), DELETE_TIMEOUT_MS)
      }

      return { slug, status: 'disconnected' }
    },

    async syncProfiles(profileNames: string[]): Promise<SyncProfilesResult> {
      const names = [...new Set(profileNames.map(name => String(name || '').trim()).filter(Boolean))]
      const state = readState()

      if (!state?.apiKey) {
        return { synced: 0, removed: 0, toolkits: [] }
      }

      const live = await ensureUserId(state)

      if (consumerKey(live)) {
        const entry = consumerMcpEntry(live.apiKey, COMPOSIO_MCP_TIMEOUT_SECONDS)
        let synced = 0
        const sessions: ComposioStoredState['sessions'] = {}

        for (const profile of names) {
          await deps.mcp.upsert(profile, entry)
          sessions[profile] = { sessionId: 'connect', toolkitKey: 'connect' }
          synced += 1
        }

        deps.store.save({ ...live, sessions })

        return { synced, removed: 0, toolkits: ['connect'] }
      }

      const client = await clientFor(live)
      const toolkits = await connectedToolkitSlugs(client, live.userId)
      let working = live
      let synced = 0
      let removed = 0

      if (toolkits.length === 0) {
        for (const profile of names) {
          await deps.mcp.remove(profile)
          removed += 1
        }

        working = { ...working, sessions: {} }
        deps.store.save(working)

        return { synced: 0, removed, toolkits: [] }
      }

      const keep = new Set(names)

      for (const profile of names) {
        const ensured = await ensureSession(client, working, profile, toolkits)
        working = ensured.state
        await deps.mcp.upsert(profile, mcpEntryFrom(ensured.session))
        synced += 1
      }

      const sessions = { ...working.sessions }

      for (const profile of Object.keys(sessions)) {
        if (keep.has(profile) || profile === '__connect__') {
          continue
        }

        await deps.mcp.remove(profile).catch(() => undefined)
        delete sessions[profile]
        removed += 1
      }

      deps.store.save({ ...working, sessions })

      return { synced, removed, toolkits }
    }

  }
}

export type ComposioBroker = ReturnType<typeof createComposioBroker>

export function createBrokerFromStoreIo(
  io: ComposioStoreIo,
  deps: Omit<ComposioBrokerDeps, 'store'>
): ComposioBroker {
  return createComposioBroker({ ...deps, store: createComposioStore(io) })
}

export async function createSdkClient(apiKey: string): Promise<ComposioClientLike> {
  const mod = (await import('@composio/core')) as unknown as {
    Composio?: new (opts: { apiKey: string }) => Record<string, unknown>
  }

  const Composio = mod.Composio

  if (!Composio) {
    throw new Error('Composio SDK is unavailable.')
  }

  const sdk = new Composio({ apiKey }) as Record<string, unknown> & {
    create?: ComposioClientLike['sessions']['create']
    use?: ComposioClientLike['sessions']['use']
    sessions?: ComposioClientLike['sessions']
    toolkits?: ComposioClientLike['toolkits']
    connectedAccounts?: ComposioClientLike['connectedAccounts']
  }

  return {
    toolkits: {
      get: query => {
        const toolkits = sdk.toolkits as ComposioClientLike['toolkits'] | undefined

        if (!toolkits?.get) {
          throw new Error('Composio toolkit catalog is unavailable.')
        }

        return toolkits.get(query)
      },
      listCategories: () => {
        const toolkits = sdk.toolkits as ComposioClientLike['toolkits'] | undefined

        if (!toolkits?.listCategories) {
          throw new Error('Composio toolkit categories are unavailable.')
        }

        return toolkits.listCategories()
      }
    },
    sessions: {
      create: (userId, config, requestOptions) => {
        if (typeof sdk.create === 'function') {
          return sdk.create(userId, config, requestOptions)
        }

        if (!sdk.sessions?.create) {
          throw new Error('Composio sessions.create is unavailable.')
        }

        return sdk.sessions.create(userId, config, requestOptions)
      },
      use: (id, options) => {
        if (typeof sdk.use === 'function') {
          return sdk.use(id, options)
        }

        if (!sdk.sessions?.use) {
          throw new Error('Composio sessions.use is unavailable.')
        }

        return sdk.sessions.use(id, options)
      }
    },
    connectedAccounts: sdk.connectedAccounts as ComposioClientLike['connectedAccounts']
  }
}
