import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  allowsGenericHermesUpdates,
  applyDesktopProductIdentity,
  BOT_APP_ID,
  BOT_APP_NAME,
  BOT_INSTANCE_ARG,
  BOT_SOURCE_REPO_URL,
  BOT_TEMPLATE_REF,
  BOT_UPDATE_POLICY,
  BOT_UPSTREAM_REPO_URL,
  BOT_USER_DATA_DIRNAME,
  currentBotInstanceName,
  desktopAppId,
  desktopAppName,
  isBotProduct,
  parseBotInstanceName
} from './product'

function withProduct(product: 'bot' | 'hermes', run: () => void) {
  const previous = process.env.HERMES_DESKTOP_PRODUCT
  process.env.HERMES_DESKTOP_PRODUCT = product

  try {
    run()
  } finally {
    if (previous === undefined) {
      delete process.env.HERMES_DESKTOP_PRODUCT
    } else {
      process.env.HERMES_DESKTOP_PRODUCT = previous
    }
  }
}

test('generic desktop stays Hermes unless HERMES_DESKTOP_PRODUCT=bot', () => {
  assert.equal(BOT_APP_NAME, 'Revenue Partner Studio')
  assert.equal(BOT_INSTANCE_ARG, '--studio-instance')
  assert.equal(BOT_SOURCE_REPO_URL, 'https://github.com/jbellsolutions/revenue-partner-studio.git')
  assert.equal(BOT_UPSTREAM_REPO_URL, 'https://github.com/nickvasilescu/korgo-bot.git')
  assert.equal(BOT_USER_DATA_DIRNAME, 'Hermes Orgo Studio')
  assert.equal(BOT_TEMPLATE_REF, 'system/hermes-agent@1.0.0')
  assert.equal(BOT_UPDATE_POLICY, 'source-release')
  assert.equal(allowsGenericHermesUpdates(), !isBotProduct())

  if (process.env.HERMES_DESKTOP_PRODUCT === 'bot') {
    assert.equal(isBotProduct(), true)
    assert.equal(desktopAppName(), process.env.HERMES_DESKTOP_APP_NAME || BOT_APP_NAME)
    assert.equal(desktopAppId(), BOT_APP_ID)

    return
  }

  assert.equal(isBotProduct(), false)
  assert.equal(desktopAppId(), 'com.nousresearch.hermes')
})

test('named Orgo instances accept one safe normalized identifier', () => {
  assert.equal(parseBotInstanceName(['app']), '')
  assert.equal(parseBotInstanceName(['app', '--studio-instance', 'Research-1']), 'research-1')
  assert.equal(parseBotInstanceName(['app', '--studio-instance=sales_team']), 'sales_team')
  assert.equal(parseBotInstanceName(['app', '--studio-instance=a', '--studio-instance=A']), 'a')
  assert.throws(() => parseBotInstanceName(['app', '--studio-instance']), /requires a name/)
  assert.throws(() => parseBotInstanceName(['app', '--studio-instance=../escape']), /1-64 lowercase/)
  assert.throws(() => parseBotInstanceName(['app', '--studio-instance=a', '--studio-instance=b']), /Only one Orgo instance/)
})

test('only the Bot product consumes the Orgo instance argument', () => {
  withProduct('bot', () => {
    assert.equal(currentBotInstanceName(['app', '--studio-instance=research']), 'research')
    assert.equal(desktopAppName('research'), 'Revenue Partner Studio — research')
  })
  withProduct('hermes', () => {
    assert.equal(currentBotInstanceName(['app', '--studio-instance=research']), '')
    assert.equal(desktopAppName('research'), 'Hermes')
  })
})

test('named Bot instances isolate Electron state without moving the legacy default', () => {
  withProduct('bot', () => {
    const paths = new Map<string, string>([
      ['appData', '/Users/example/Library/Application Support'],
      ['userData', '/Users/example/Library/Application Support/Hermes Orgo Studio']
    ])

    const names: string[] = []

    const app = {
      getPath: (name: 'appData' | 'userData') => paths.get(name) || '',
      setName: (name: string) => names.push(name),
      setPath: (name: 'userData', value: string) => paths.set(name, value)
    }

    applyDesktopProductIdentity(app)
    assert.equal(paths.get('userData'), '/Users/example/Library/Application Support/Hermes Orgo Studio')
    assert.equal(names.at(-1), 'Revenue Partner Studio')

    paths.set('userData', '/Users/example/Library/Application Support/Hermes Orgo Studio')
    applyDesktopProductIdentity(app, 'research')
    assert.equal(paths.get('userData'), '/Users/example/Library/Application Support/Hermes Orgo Studio/instances/research')
    assert.equal(names.at(-1), 'Revenue Partner Studio — research')
  })
})
