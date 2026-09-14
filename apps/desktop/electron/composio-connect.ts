import type { ComposioMcpEntry, ConnectorAccountView, ConnectorToolkit } from './composio-connectors'

export const COMPOSIO_CONNECT_MCP_URL = 'https://connect.composio.dev/mcp'
export const COMPOSIO_BACKEND_URL = 'https://backend.composio.dev/api/v3'
export const COMPOSIO_CONSUMER_HEADER = 'x-consumer-api-key'
const MCP_PROTOCOL_VERSION = '2025-03-26'

export const CURATED_CONNECT_TOOLKITS: ConnectorToolkit[] = [
  { slug: 'slack', name: 'Slack', description: 'Post updates and read channels', logo: null, category: 'Chat', featured: true, isNoAuth: false },
  { slug: 'github', name: 'GitHub', description: 'Issues, pull requests, and code', logo: null, category: 'Dev', featured: true, isNoAuth: false },
  { slug: 'gmail', name: 'Gmail', description: 'Read and send email', logo: null, category: 'Email', featured: true, isNoAuth: false },
  { slug: 'googlecalendar', name: 'Google Calendar', description: 'Read and create events', logo: null, category: 'Calendar', featured: true, isNoAuth: false },
  { slug: 'googlesheets', name: 'Google Sheets', description: 'Read and update spreadsheets', logo: null, category: 'Docs', featured: false, isNoAuth: false },
  { slug: 'googledocs', name: 'Google Docs', description: 'Read and write documents', logo: null, category: 'Docs', featured: false, isNoAuth: false },
  { slug: 'googledrive', name: 'Google Drive', description: 'Browse and manage files', logo: null, category: 'Files', featured: true, isNoAuth: false },
  { slug: 'notion', name: 'Notion', description: 'Pages and databases', logo: null, category: 'Docs', featured: true, isNoAuth: false },
  { slug: 'linear', name: 'Linear', description: 'Issues and project tracking', logo: null, category: 'Work', featured: true, isNoAuth: false },
  { slug: 'sentry', name: 'Sentry', description: 'Errors and alerts', logo: null, category: 'Dev', featured: false, isNoAuth: false },
  { slug: 'posthog', name: 'PostHog', description: 'Analytics, feature flags, experiments', logo: null, category: 'Analytics', featured: false, isNoAuth: false },
  { slug: 'discord', name: 'Discord', description: 'Messages and channels', logo: null, category: 'Chat', featured: true, isNoAuth: false },
  { slug: 'twitter', name: 'X (Twitter)', description: 'Post and read on X', logo: null, category: 'Social', featured: true, isNoAuth: false },
  { slug: 'reddit', name: 'Reddit', description: 'Browse and post', logo: null, category: 'Social', featured: false, isNoAuth: false },
  { slug: 'hubspot', name: 'HubSpot', description: 'CRM search and updates', logo: null, category: 'CRM', featured: true, isNoAuth: false },
  { slug: 'salesforce', name: 'Salesforce', description: 'CRM records and reports', logo: null, category: 'CRM', featured: true, isNoAuth: false },
  { slug: 'jira', name: 'Jira', description: 'Issues and sprints', logo: null, category: 'Work', featured: true, isNoAuth: false },
  { slug: 'asana', name: 'Asana', description: 'Tasks and projects', logo: null, category: 'Work', featured: true, isNoAuth: false },
  { slug: 'trello', name: 'Trello', description: 'Boards and cards', logo: null, category: 'Work', featured: false, isNoAuth: false },
  { slug: 'dropbox', name: 'Dropbox', description: 'Files and folders', logo: null, category: 'Files', featured: true, isNoAuth: false },
  { slug: 'airtable', name: 'Airtable', description: 'Bases and records', logo: null, category: 'Docs', featured: false, isNoAuth: false },
  { slug: 'figma', name: 'Figma', description: 'Files and comments', logo: null, category: 'Design', featured: true, isNoAuth: false },
  { slug: 'stripe', name: 'Stripe', description: 'Payments and customers', logo: null, category: 'Finance', featured: false, isNoAuth: false },
  { slug: 'outlook', name: 'Outlook', description: 'Mail and calendar', logo: null, category: 'Email', featured: true, isNoAuth: false }
]

export function isComposioConsumerKey(key: string): boolean {
  return /^ck_[A-Za-z0-9._:-]{8,199}$/i.test(String(key || '').trim())
}

export function consumerMcpEntry(apiKey: string, timeout = 180): ComposioMcpEntry {
  return {
    url: COMPOSIO_CONNECT_MCP_URL,
    headers: { [COMPOSIO_CONSUMER_HEADER]: apiKey },
    connect_timeout: timeout,
    trust: 'untrusted'
  }
}

export interface ComposioConnectClientLike {
  validate: () => Promise<void>
  listCatalog: (query?: { search?: string; cursor?: string }) => Promise<{ items: ConnectorToolkit[]; nextCursor: string | null }>
  connections: (slugs?: string[]) => Promise<ConnectorAccountView[]>
  authorize: (slug: string) => Promise<{ redirectUrl: string | null; connected: boolean; status: string }>
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function errorFromBody(status: number, text: string): Error {
  try {
    const json = JSON.parse(text) as { error?: { message?: string }; message?: string }
    const message = json.error?.message || json.message

    if (message) {
      return new Error(message)
    }
  } catch {
    // Fall through to the HTTP status.
  }

  if (status === 401) {
    return new Error('Invalid API key')
  }

  return new Error(`Composio MCP: HTTP ${status}`)
}

function parseMcpMessages(text: string): unknown[] {
  const trimmed = text.trim()

  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith('{')) {
    return [JSON.parse(trimmed)]
  }

  return trimmed
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)))
}

function parseToolResult(payload: unknown): Record<string, unknown> {
  const message = asRecord(payload)

  if (!message) {
    return {}
  }

  if (message.error) {
    const error = asRecord(message.error)
    throw new Error(String(error?.message || 'Composio MCP error'))
  }

  const result = asRecord(message.result) || message
  const content = result.content

  if (Array.isArray(content)) {
    const text = content.find(item => asRecord(item)?.type === 'text')
    const raw = asRecord(text)?.text

    if (typeof raw === 'string') {
      try {
        return asRecord(JSON.parse(raw)) || { text: raw }
      } catch {
        return { text: raw }
      }
    }
  }

  return result
}

function isConnectedPayload(value: unknown): boolean {
  const serialized = JSON.stringify(value ?? {})

  return (
    /"(?:connected|active)"\s*:\s*true/i.test(serialized) ||
    /"status"\s*:\s*"(?:active|connected)"/i.test(serialized)
  )
}

async function mcpRpc(
  apiKey: string,
  message: Record<string, unknown>,
  fetchImpl: FetchLike,
  sessionId?: string | null,
  protocolVersion?: string
): Promise<{ messages: unknown[]; sessionId: string | null }> {
  const response = await fetchImpl(COMPOSIO_CONNECT_MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      [COMPOSIO_CONSUMER_HEADER]: apiKey,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(40_000)
  })

  const text = await response.text()

  if (!response.ok) {
    throw errorFromBody(response.status, text)
  }

  return {
    messages: parseMcpMessages(text),
    sessionId: response.headers.get('mcp-session-id') || sessionId || null
  }
}

async function callMetaTool(apiKey: string, name: string, args: Record<string, unknown>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const initialized = await mcpRpc(
    apiKey,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'hermes-desktop', version: '0.17.0' }
      }
    },
    fetchImpl
  )

  const initializeResponse = asRecord(initialized.messages.find(item => asRecord(item)?.id === 1) || initialized.messages[0])

  if (!initializeResponse) {
    throw new Error('Composio MCP returned no initialize response')
  }

  if (initializeResponse.error) {
    const error = asRecord(initializeResponse.error)
    throw new Error(String(error?.message || 'Composio MCP initialize failed'))
  }

  const protocolVersion = String(asRecord(initializeResponse.result)?.protocolVersion || MCP_PROTOCOL_VERSION)
  await mcpRpc(apiKey, { jsonrpc: '2.0', method: 'notifications/initialized' }, fetchImpl, initialized.sessionId, protocolVersion)

  const rpc = await mcpRpc(
    apiKey,
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
    fetchImpl,
    initialized.sessionId,
    protocolVersion
  )

  const response = rpc.messages.find(item => asRecord(item)?.id === 2) || rpc.messages[0]

  return parseToolResult(response)
}

function extractRedirectUrl(payload: unknown): string | null {
  const urls = JSON.stringify(payload).match(/https:\/\/[^"\\\s]+/g) || []

  return urls.find(url => /composio|connect|auth/i.test(url)) || urls[0] || null
}

export async function validateConsumerKey(apiKey: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const result = await mcpRpc(
    apiKey,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'hermes-desktop', version: '0.17.0' }
      }
    },
    fetchImpl
  )

  const message = asRecord(result.messages.find(item => asRecord(item)?.id === 1) || result.messages[0])

  if (!message) {
    throw new Error('Composio MCP returned no initialize response')
  }

  if (message.error) {
    const error = asRecord(message.error)
    throw new Error(String(error?.message || 'That Composio Connect key could not be verified.'))
  }
}

async function listBackendCatalog(
  apiKey: string,
  query: { search?: string; cursor?: string },
  fetchImpl: FetchLike
): Promise<{ items: ConnectorToolkit[]; nextCursor: string | null } | null> {
  const url = new URL(`${COMPOSIO_BACKEND_URL}/toolkits`)
  url.searchParams.set('limit', '100')
  url.searchParams.set('sort_by', 'usage')

  if (query.search) {
    url.searchParams.set('search', query.search)
  }

  if (query.cursor) {
    url.searchParams.set('cursor', query.cursor)
  }

  for (const headerName of [COMPOSIO_CONSUMER_HEADER, 'x-api-key']) {
    try {
      const response = await fetchImpl(url.toString(), {
        headers: { [headerName]: apiKey },
        signal: AbortSignal.timeout(15_000)
      })

      if (!response.ok) {
        continue
      }

      const json = asRecord(await response.json())
      const items = json?.items || json?.data

      if (!Array.isArray(items) || items.length === 0) {
        continue
      }

      return {
        items: items.flatMap(item => {
          const row = asRecord(item) || {}
          const meta = asRecord(row.meta) || {}

          const slug = String(row.slug || row.key || row.name || '')
            .trim()
            .toLowerCase()

          if (!slug) {
            return []
          }

          const toolkit: ConnectorToolkit = {
            slug,
            name: String(row.name || slug),
            description: String(meta.description || row.description || '').slice(0, 140),
            logo: typeof meta.logo === 'string' ? meta.logo : typeof row.logo === 'string' ? row.logo : null,
            category: 'Other',
            featured: false,
            isNoAuth: false
          }

          return [toolkit]
        }),
        nextCursor: typeof json?.next_cursor === 'string' ? json.next_cursor : typeof json?.nextCursor === 'string' ? json.nextCursor : null
      }
    } catch {
      // Consumer keys often cannot read the project catalog; fall through.
    }
  }

  return null
}

export function createComposioConnectClient(apiKey: string, fetchImpl: FetchLike = fetch): ComposioConnectClientLike {
  return {
    async validate() {
      await validateConsumerKey(apiKey, fetchImpl)
    },

    async listCatalog(query = {}) {
      const remote = await listBackendCatalog(apiKey, query, fetchImpl)

      if (remote) {
        return remote
      }

      const search = String(query.search || '')
        .trim()
        .toLowerCase()

      const items = search
        ? CURATED_CONNECT_TOOLKITS.filter(item => `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(search))
        : CURATED_CONNECT_TOOLKITS

      return { items, nextCursor: null }
    },

    async connections(slugs = CURATED_CONNECT_TOOLKITS.map(item => item.slug).slice(0, 24)) {
      if (slugs.length === 0) {
        return []
      }

      const out = await callMetaTool(apiKey, 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits: slugs }, fetchImpl)
      const data = asRecord(out.data) || out
      const results = asRecord(data.results) || data
      const views: ConnectorAccountView[] = []

      for (const slug of slugs) {
        const row = results[slug] ?? data[slug]
        const connected = isConnectedPayload(row)

        if (!connected) {
          continue
        }

        views.push({
          slug,
          name: CURATED_CONNECT_TOOLKITS.find(item => item.slug === slug)?.name || slug,
          description: '',
          logo: null,
          category: 'Connected',
          status: 'connected',
          accountId: typeof asRecord(row)?.id === 'string' ? String(asRecord(row)?.id) : null,
          statusReason: null
        })
      }

      return views
    },

    async authorize(slug: string) {
      const out = await callMetaTool(apiKey, 'COMPOSIO_MANAGE_CONNECTIONS', { toolkits: [slug] }, fetchImpl)
      const data = asRecord(out.data) || out
      const row = asRecord(data.results)?.[slug] ?? data[slug] ?? out
      const connected = isConnectedPayload(row) || isConnectedPayload(out)

      return {
        redirectUrl: extractRedirectUrl(out),
        connected,
        status: connected ? 'connected' : 'pending'
      }
    }
  }
}
