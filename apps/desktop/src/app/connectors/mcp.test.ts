import { describe, expect, it } from 'vitest'

import { COMPOSIO_MCP_SERVER_NAME, COMPOSIO_MCP_TRUST, mergeComposioMcpServers, rosterProfileNames } from './mcp'

describe('Composio MCP merge', () => {
  it('preserves unrelated servers and forces the untrusted boundary', () => {
    const merged = mergeComposioMcpServers(
      {
        filesystem: { command: 'npx' },
        composio: { url: 'https://stale.example', trust: 'full' }
      },
      {
        url: 'https://mcp.composio.dev/new',
        headers: { authorization: 'Bearer secret' },
        connect_timeout: 180,
        trust: COMPOSIO_MCP_TRUST
      }
    )

    expect(merged.filesystem).toEqual({ command: 'npx' })
    expect(merged[COMPOSIO_MCP_SERVER_NAME]).toMatchObject({
      url: 'https://mcp.composio.dev/new',
      trust: 'untrusted'
    })
  })

  it('removes only the reserved composio entry', () => {
    const merged = mergeComposioMcpServers({ filesystem: { command: 'npx' }, composio: { url: 'https://x' } }, null)

    expect(merged.filesystem).toEqual({ command: 'npx' })
    expect(merged.composio).toBeUndefined()
  })

  it('always includes default when collecting roster profiles', () => {
    expect(rosterProfileNames([{ name: 'inbox' }])).toEqual(['default', 'inbox'])
  })
})
