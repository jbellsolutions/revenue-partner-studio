/**
 * Bot SKU shell coverage. These tests run against a Bot product build
 * (`VITE_HERMES_DESKTOP_PRODUCT=bot`). Generic Hermes builds skip them.
 */
import { type MockBackendFixture, setupMockBackend } from './fixtures'
import { expect, test } from './test'

const isBotSku = process.env.VITE_HERMES_DESKTOP_PRODUCT === 'bot' || process.env.HERMES_DESKTOP_PRODUCT === 'bot'

let fixture: MockBackendFixture | null = null

test.beforeAll(async () => {
  test.skip(!isBotSku, 'Set VITE_HERMES_DESKTOP_PRODUCT=bot to run Bot SKU e2e')
  fixture = await setupMockBackend()
})

test.afterAll(async () => {
  await fixture?.cleanup()
  fixture = null
})

test.describe('bot product shell', () => {
  test('lands in a bot-focused window', async () => {
    const page = fixture!.page
    await expect(page.getByRole('heading', { name: 'Your cloud computer' })).toBeVisible({ timeout: 120_000 })
    const title = await page.title()
    expect(title).toMatch(/Hermes|Bots/)
    await expect(page.locator('.bot-product-shell')).toBeVisible({
      timeout: 60_000
    })
  })

  test('does not expose generic Files/Review/Terminal chrome', async () => {
    const page = fixture!.page
    await expect(page.locator('[data-pane-id="files"]')).toHaveCount(0)
    await expect(page.locator('[data-pane-id="review"]')).toHaveCount(0)
    await expect(page.locator('[data-pane-id="terminal"]')).toHaveCount(0)
  })
})
