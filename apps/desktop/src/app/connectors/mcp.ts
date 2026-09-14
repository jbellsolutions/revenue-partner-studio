export const COMPOSIO_MCP_SERVER_NAME = 'composio'
export const COMPOSIO_MCP_TRUST = 'untrusted'

export interface ComposioMcpEntry {
  url: string
  headers: Record<string, string>
  connect_timeout: number
  trust: typeof COMPOSIO_MCP_TRUST
}

/** Merge a reserved `composio` MCP entry into an existing map without
 *  clobbering unrelated servers. Passing null removes only that reserved key. */
export function mergeComposioMcpServers(
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

export function rosterProfileNames(profiles: Array<{ name?: string }> | null | undefined): string[] {
  const names = new Set<string>(['default'])

  for (const profile of profiles || []) {
    const name = String(profile?.name || '').trim()

    if (name) {
      names.add(name)
    }
  }

  return [...names]
}
