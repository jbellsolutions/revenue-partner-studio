import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerPluginLocales } from '@/i18n/plugin-i18n'
import { $boardSlug } from '@/plugins/kanban/api'
import { KanbanBoardPage } from '@/plugins/kanban/board'
import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'

vi.mock('@/plugins/kanban/api', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchBoard: vi.fn(async () => ({ columns: [], tenants: [], assignees: [], latest_event_id: 0, now: 0 })),
  fetchBoards: vi.fn(async () => ({
    current: 'default',
    boards: [
      { slug: 'default', name: 'Main team' },
      { slug: 'verification', name: 'Verification team' }
    ]
  })),
  fetchProfiles: vi.fn(async () => []),
  fetchProjects: vi.fn(async () => ({ projects: [] })),
  fetchOrchestration: vi.fn(async () => ({ default_assignee: '' }))
}))

let disposeLocales: () => void
let client: QueryClient

beforeEach(() => {
  vi.stubEnv('VITE_HERMES_DESKTOP_PRODUCT', 'bot')
  Element.prototype.scrollIntoView = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.releasePointerCapture = vi.fn()
  disposeLocales = registerPluginLocales('kanban', KANBAN_LOCALES)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  $boardSlug.set('')
})

afterEach(() => {
  cleanup()
  client.clear()
  disposeLocales()
  $boardSlug.set('')
  vi.unstubAllEnvs()
})

it('keeps the Bot board selector inside the visible page toolbar and switches boards', async () => {
  const { container } = render(
    <QueryClientProvider client={client}>
      <KanbanBoardPage />
    </QueryClientProvider>
  )

  const toolbar = container.querySelector('header')!
  const selector = await within(toolbar).findByRole('button', { name: 'Main team' })
  fireEvent.keyDown(selector, { key: 'Enter' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Verification team' }))
  expect($boardSlug.get()).toBe('verification')
  expect(await within(toolbar).findByRole('button', { name: 'Verification team' })).toBeTruthy()
})
