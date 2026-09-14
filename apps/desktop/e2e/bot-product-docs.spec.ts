import fs from 'node:fs'
import path from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { setupMockBackend, setupNoProvider } from './fixtures'
import { expect, test } from './test'

const screenshotDirectory = path.resolve(import.meta.dirname, '../../../docs/images/onboarding')

const botReply =
  'I’m Researcher. I gather evidence, compare options, and turn findings into concise recommendations.'

async function showSetupStep(page: Page, step: 'bot' | 'composio' | 'orgo' | 'provider' | 'ready' | 'tailscale') {
  await page.evaluate(nextStep => {
    window.localStorage.setItem(
      'hermes-bot-setup-v2',
      JSON.stringify({ complete: false, skipped: false, step: nextStep })
    )
  }, step)
  await page.reload()
}

async function capture(app: ElectronApplication, page: Page, filename: string) {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.show()
  })
  await page.bringToFront()
  await page.setViewportSize({ width: 1220, height: 800 })
  await page.getByText('CONNECTING', { exact: true }).waitFor({ state: 'hidden', timeout: 10_000 })
  await page.waitForTimeout(300)
  await page.screenshot({ path: path.join(screenshotDirectory, filename) })
}

async function prepareBotWorkspace(page: Page) {
  await page.evaluate(async () => {
    const bridge = (
      window as typeof window & {
        hermesDesktop: {
          api: (request: { path: string; method: string; body: unknown }) => Promise<unknown>
        }
      }
    ).hermesDesktop

    const profiles = [
      { name: 'researcher', description: 'Finds evidence, compares sources, and briefs the team.' },
      { name: 'builder', description: 'Turns decisions into working product changes.' },
      { name: 'operations', description: 'Keeps launches, support, and recurring work on track.' }
    ]

    for (const profile of profiles) {
      await bridge.api({
        path: '/api/profiles',
        method: 'POST',
        body: {
          ...profile,
          clone_from_default: true
        }
      })
    }

    window.localStorage.setItem(
      'hermes.plugin.hermes-bots.bot-meta',
      JSON.stringify({
        researcher: { title: 'Researcher', color: '#4f86f7', shape: 'circle' },
        builder: { title: 'Builder', color: '#f97316', shape: 'rounded' },
        operations: { title: 'Operations', color: '#22c55e', shape: 'square' }
      })
    )
    window.localStorage.setItem(
      'hermes.plugin.hermes-bots.bot-pins-v1',
      JSON.stringify(['researcher', 'builder'])
    )
    window.localStorage.setItem(
      'hermes.plugin.hermes-bots.bot-groups-v1',
      JSON.stringify({
        'launch-team': {
          id: 'launch-team',
          participantIds: ['researcher', 'builder', 'operations'],
          profile: 'researcher',
          sessionId: null,
          title: 'Launch Team',
          createdAt: Date.now(),
          lastActive: Date.now(),
          preview: 'Coordinate the next Revenue Partner Studio release.'
        }
      })
    )
    window.localStorage.setItem(
      'hermes-bot-setup-v2',
      JSON.stringify({ complete: true, skipped: false, step: 'ready' })
    )
  })
}

test.describe('Revenue Partner Studio onboarding documentation', () => {
  test('captures the complete setup journey', async () => {
    fs.mkdirSync(screenshotDirectory, { recursive: true })

    const configured = await setupMockBackend({ mockServer: { reply: botReply } })

    try {
      await expect(configured.page.getByRole('heading', { name: 'Your cloud computer' })).toBeVisible({
        timeout: 120_000
      })
      await capture(configured.app, configured.page, '01-cloud-computer.png')

      await showSetupStep(configured.page, 'tailscale')
      await expect(configured.page.getByRole('heading', { name: 'Private cloud connection' })).toBeVisible({
        timeout: 120_000
      })
      await capture(configured.app, configured.page, '02-private-connection.png')

      await showSetupStep(configured.page, 'bot')
      await expect(configured.page.getByRole('heading', { name: 'Name your first bot' })).toBeVisible({
        timeout: 120_000
      })
      await capture(configured.app, configured.page, '04-first-bot.png')

      await showSetupStep(configured.page, 'composio')
      await expect(configured.page.getByRole('heading', { name: 'Connect apps' })).toBeVisible({
        timeout: 120_000
      })
      await capture(configured.app, configured.page, '05-connect-apps.png')

      await showSetupStep(configured.page, 'ready')
      await expect(configured.page.getByRole('heading', { name: 'Ready' })).toBeVisible({ timeout: 120_000 })
      await capture(configured.app, configured.page, '06-ready.png')

      await prepareBotWorkspace(configured.page)
      await configured.page.reload()
      await expect(configured.page.locator('.bot-product-shell')).toBeVisible({ timeout: 120_000 })
      const botsPane = configured.page.locator('[data-hermes-bots-pane]:visible')

      await expect(botsPane).toBeVisible({ timeout: 120_000 })
      await expect(botsPane.getByText('Researcher', { exact: true }).first()).toBeVisible({ timeout: 120_000 })
      await configured.page.getByRole('button', { name: 'Dismiss' }).first().click().catch(() => undefined)
      await capture(configured.app, configured.page, '07-bot-workspace.png')

      await botsPane.getByText('Researcher', { exact: true }).first().click()
      await expect(configured.page.locator('[data-hermes-bot-chat-header]')).toBeVisible({ timeout: 120_000 })
      await expect(configured.page.getByText(botReply, { exact: true })).toBeVisible({ timeout: 120_000 })
      await capture(configured.app, configured.page, '08-bot-chat.png')
    } finally {
      await configured.cleanup()
    }

    const noProvider = await setupNoProvider()

    try {
      await showSetupStep(noProvider.page, 'provider')
      await expect(noProvider.page.getByText(/Codex/i).first()).toBeVisible({ timeout: 120_000 })
      await capture(noProvider.app, noProvider.page, '03-provider.png')
    } finally {
      await noProvider.cleanup()
    }
  })
})
