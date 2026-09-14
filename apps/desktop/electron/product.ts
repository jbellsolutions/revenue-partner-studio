import BRAND from '../../../brand/product.json'
import path from 'node:path'

export const HERMES_APP_NAME = 'Hermes'
export const HERMES_APP_ID = 'com.nousresearch.hermes'

export const BOT_APP_NAME = BRAND.name
export const BOT_SOURCE_REPO_URL = BRAND.repository + '.git'
export const BOT_UPSTREAM_REPO_URL = 'https://github.com/nickvasilescu/korgo-bot.git'
// This independent trial must never adopt the baseline app identity or state.
export const BOT_APP_ID = 'com.usingaitoscale.hermes-orgo-studio'
export const BOT_USER_DATA_DIRNAME = 'Hermes Orgo Studio'
export const BOT_INSTANCE_ARG = '--studio-instance'
export const BOT_TEMPLATE_REF = 'system/hermes-agent@1.0.0'
export const BOT_UPDATE_POLICY = 'source-release' as const

const BOT_INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export type DesktopProduct = 'bot' | 'hermes'

export function desktopProduct(): DesktopProduct {
  return process.env.HERMES_DESKTOP_PRODUCT === 'bot' ? 'bot' : 'hermes'
}

export function isBotProduct(): boolean {
  return desktopProduct() === 'bot'
}

/** Bot releases pin their remote template and move client/backend together.
 * Generic Hermes update flows would bypass that compatibility guarantee. */
export function allowsGenericHermesUpdates(): boolean {
  return !isBotProduct()
}

export function parseBotInstanceName(argv: string[] = process.argv): string {
  const values: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || '')

    if (argument === BOT_INSTANCE_ARG) {
      const value = String(argv[index + 1] || '').trim()

      if (!value || value.startsWith('--')) {
        throw new Error(`${BOT_INSTANCE_ARG} requires a name.`)
      }

      values.push(value)
      index += 1
    } else if (argument.startsWith(`${BOT_INSTANCE_ARG}=`)) {
      values.push(argument.slice(BOT_INSTANCE_ARG.length + 1).trim())
    }
  }

  if (values.length === 0) {
    return ''
  }

  const normalized = values.map(value => value.toLowerCase())

  if (normalized.some(value => !BOT_INSTANCE_RE.test(value))) {
    throw new Error('Orgo instance names must use 1-64 lowercase letters, numbers, dashes, or underscores.')
  }

  if (new Set(normalized).size !== 1) {
    throw new Error('Only one Orgo instance name can be used per launch.')
  }

  return normalized[0]
}

export function currentBotInstanceName(argv: string[] = process.argv): string {
  return isBotProduct() ? parseBotInstanceName(argv) : ''
}

export function desktopAppName(instanceName = ''): string {
  const base = process.env.HERMES_DESKTOP_APP_NAME || (isBotProduct() ? BOT_APP_NAME : HERMES_APP_NAME)

  return instanceName && isBotProduct() ? `${base} — ${instanceName}` : base
}

export function desktopAppId(): string {
  return isBotProduct() ? BOT_APP_ID : HERMES_APP_ID
}

/** Pin the app name (and therefore the default userData folder) before any
 *  `app.getPath('userData')` call. Must run at module load. */
export function applyDesktopProductIdentity(
  app: {
    setName: (name: string) => void
    setPath: (name: 'userData', value: string) => void
    getPath: (name: 'appData' | 'userData') => string
  },
  instanceName = ''
): void {
  if (!isBotProduct()) {
    return
  }

  app.setName(desktopAppName(instanceName))

  if (process.env.HERMES_DESKTOP_USER_DATA_DIR) {
    return
  }

  const target = instanceName
    ? path.join(app.getPath('appData'), BOT_USER_DATA_DIRNAME, 'instances', instanceName)
    : path.join(app.getPath('appData'), BOT_USER_DATA_DIRNAME)

  if (app.getPath('userData') !== target) {
    app.setPath('userData', target)
  }
}
