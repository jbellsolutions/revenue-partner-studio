import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/plugins/hermes-bots/legacy-plugin.js'), 'utf8')

describe('Orgo AI Guy Bot management shelf', () => {
  it('names the primary Bot profile after the product instead of hiding it as Hermes', () => {
    expect(source).toContain("return isBotProduct() ? BOT_APP_NAME : 'Hermes'")
  })

  it('links the Bot surface to the existing Hermes management pages', () => {
    for (const [label, route] of [
      ['Skills', '/skills?tab=skills'],
      ['Skills Hub', '/skills?tab=hub'],
      ['Capabilities', '/skills?tab=toolsets'],
      ['Plugins & MCP', '/skills?tab=mcp'],
      ['Artifacts', '/artifacts'],
      ['Profiles', '/profiles'],
      ['Settings', '/settings']
    ]) {
      expect(source).toContain(`label: '${label}'`)
      expect(source).toContain(`path: '${route}'`)
    }
  })

  it('labels Composio accurately and keeps its dedicated connector action', () => {
    expect(source).toContain("label: 'Connected Apps'")
    expect(source).toContain('host.connectors?.open?.()')
  })

  it('offers an explicit local or Obsidian skills import action', () => {
    expect(source).toContain("label: 'Import Local Skills'")
    expect(source).toContain('globalThis.hermesDesktop?.orgoDesktop?.syncSkills?.()')
    expect(source).toContain('Imported ${result.skillCount} skills')
  })

  it('reconciles live roster state after render rather than mutating stores during render', () => {
    const pane = source.slice(source.indexOf('function BotsPane()'), source.indexOf('const staleNotice ='))

    expect(pane).not.toMatch(/\n\s*if \(live\) \{[\s\S]*\$lastRoster\.set/)
    expect(source).toContain('useEffect(() => {\n    if (!Array.isArray(live)) return\n    const snapshot = filterDeletedRoster(live)')
  })

  it('keys the direct chat recipient header children', () => {
    expect(source).toContain("}, 'direct-bot-face')")
    expect(source).toContain("}, 'direct-bot-label')")
  })

  it('keys every fixed child assembled by BotsPane', () => {
    for (const key of [
      'pane-search',
      'search-icon',
      'search-input',
      'pane-stale',
      'pane-draft',
      'pane-body',
      'error-message',
      'error-retry',
      'pinned-strip',
      'roster-stack',
      'create-new',
      'roster-rows',
      'pane-footer',
      'pane-edit',
      'pane-delete-bot',
      'pane-delete-group'
    ]) {
      expect(source).toContain(`'${key}'`)
    }
  })

  it('does not tell Korgo users to run backend auth commands', () => {
    expect(source).not.toMatch(/run\s+`?hermes\s+auth/i)
    expect(source).not.toMatch(/operator\s+auth/i)
    expect(source).not.toMatch(/pacer\s+key/i)
    expect(source).toContain('Open Model & Provider Settings')
  })
})
