import BRAND from '../../../../brand/product.json'
/** Build-time product SKU. Generic Hermes Desktop stays the default so
 *  existing packs keep working; Bot builds set `VITE_HERMES_DESKTOP_PRODUCT=bot`. */
export const BOT_PROVIDER_IDS = ['openai-codex', 'xai-oauth', 'openrouter', 'ollama-cloud', 'anthropic'] as const
export const BOT_APP_ICON_ASSET = 'studio-icon.png'
export const BOT_APP_NAME = BRAND.name
export const BOT_SOURCE_REPO_URL = BRAND.repository + '.git'
export const BOT_UPSTREAM_REPO_URL = 'https://github.com/nickvasilescu/korgo-bot.git'
export const BOT_UPDATE_POLICY = 'source-release' as const

export type BotProviderId = (typeof BOT_PROVIDER_IDS)[number]

export function isBotProduct(): boolean {
  return import.meta.env.VITE_HERMES_DESKTOP_PRODUCT === 'bot'
}

/** Bot releases test the desktop against a pinned compatible remote backend.
 * Never route this SKU through generic Hermes update endpoints. */
export function allowsGenericHermesUpdates(): boolean {
  return !isBotProduct()
}

export function isBotProviderId(id: string): boolean {
  return (BOT_PROVIDER_IDS as readonly string[]).includes(id)
}

export function filterBotProviders<T extends { id: string }>(providers: T[]): T[] {
  if (!isBotProduct()) {
    return providers
  }

  return providers.filter(provider => isBotProviderId(provider.id))
}
