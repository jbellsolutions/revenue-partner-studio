import { describe, expect, it } from 'vitest'

import {
  allowsGenericHermesUpdates,
  BOT_APP_ICON_ASSET,
  BOT_APP_NAME,
  BOT_PROVIDER_IDS,
  BOT_SOURCE_REPO_URL,
  BOT_UPDATE_POLICY,
  BOT_UPSTREAM_REPO_URL,
  filterBotProviders,
  isBotProduct,
  isBotProviderId
} from './product'

describe('bot product providers', () => {
  it('uses the independent Revenue Partner Studio identity', () => {
    expect(BOT_APP_NAME).toBe('Revenue Partner Studio')
    expect(BOT_SOURCE_REPO_URL).toBe('https://github.com/jbellsolutions/revenue-partner-studio.git')
    expect(BOT_UPSTREAM_REPO_URL).toBe('https://github.com/nickvasilescu/korgo-bot.git')
    expect(BOT_APP_ICON_ASSET).toBe('studio-icon.png')
  })

  it('recognizes all supported provider choices', () => {
    expect(isBotProviderId('openai-codex')).toBe(true)
    expect(isBotProviderId('xai-oauth')).toBe(true)
    expect(isBotProviderId('openrouter')).toBe(true)
    expect(isBotProviderId('ollama-cloud')).toBe(true)
    expect(isBotProviderId('anthropic')).toBe(true)
    expect(isBotProviderId('nous')).toBe(false)
    expect(BOT_PROVIDER_IDS).toHaveLength(5)
  })

  it('filters to recognized providers in the Bot SKU', () => {
    const providers = [{ id: 'nous' }, { id: 'openai-codex' }, { id: 'xai-oauth' }, { id: 'openrouter' }]
    const filtered = isBotProduct() ? filterBotProviders(providers) : providers.filter(p => isBotProviderId(p.id))
    expect(filtered.map(p => p.id)).toEqual(['openai-codex', 'xai-oauth', 'openrouter'])
  })

  it('uses release-level updates for the Bot SKU', () => {
    expect(BOT_UPDATE_POLICY).toBe('source-release')
    expect(allowsGenericHermesUpdates()).toBe(!isBotProduct())
  })
})
