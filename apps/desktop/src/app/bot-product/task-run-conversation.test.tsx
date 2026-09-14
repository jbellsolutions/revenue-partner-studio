import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerPluginLocales } from '@/i18n/plugin-i18n'
import { $boardSlug } from '@/plugins/kanban/api'
import { TaskDrawer } from '@/plugins/kanban/drawer'
import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'
import type { KanbanRun, KanbanTaskDetail } from '@/plugins/kanban/types'

import { $agentThreadOpener, registerAgentThreadOpener } from './agent-thread-navigation'
import { WorkerThreadLink } from './worker-thread-link'

vi.mock('@/plugins/kanban/api', async original => ({
  ...(await original<Record<string, unknown>>()),
  fetchTask: vi.fn(async () => detail()),
  fetchLog: vi.fn(async () => ({ exists: false, content: '', size_bytes: 0, truncated: false })),
  fetchOrchestration: vi.fn(async () => ({ default_assignee: '' })),
  fetchProfiles: vi.fn(async () => ({ profiles: [] }))
}))

let client: QueryClient
let dispose: () => void
let run: KanbanRun

const detail = (): KanbanTaskDetail => ({
  task: { id: 't_history', title: 'Retained task', status: 'cancelled', assignee: 'reviewer' },
  comments: [],
  events: [],
  attachments: [],
  links: { parents: [], children: [] },
  runs: [run]
})

beforeEach(() => {
  vi.clearAllMocks()
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  dispose = registerPluginLocales('kanban', KANBAN_LOCALES)
  $boardSlug.set('history-board')
  run = {
    id: 8,
    status: 'cancelled',
    profile: 'analyst',
    summary: 'Preserved worker result',
    metadata: { worker_session_id: 'worker-root-session' }
  }
})

afterEach(() => {
  cleanup()
  client.clear()
  dispose()
  $agentThreadOpener.set(null)
  $boardSlug.set('')
})

function mount() {
  return render(
    <QueryClientProvider client={client}>
      <TaskDrawer columns={['running', 'cancelled', 'done']} id="t_history" onClose={vi.fn()} onOpen={vi.fn()} />
    </QueryClientProvider>
  )
}

it.each(['cancelled', 'completed', 'crashed', 'running'])('opens the recorded %s attempt, not the current assignee', async status => {
  run.status = status
  const open = vi.fn().mockResolvedValue(undefined)
  registerAgentThreadOpener(open)
  mount()
  const action = await screen.findByRole('button', { name: 'Open worker thread: @analyst' })
  expect(screen.getByText('Preserved worker result')).toBeTruthy()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(action)
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('analyst', 'worker-root-session'))
})

it('accepts JSON-serialized metadata from older task APIs', async () => {
  run.metadata = JSON.stringify(run.metadata)
  const open = vi.fn().mockResolvedValue(undefined)
  registerAgentThreadOpener(open)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Open worker thread/ }))
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('analyst', 'worker-root-session'))
})

it('keeps a failed navigation visible and allows a deliberate retry', async () => {
  const open = vi.fn().mockRejectedValueOnce(new Error('Worker history unavailable')).mockResolvedValueOnce(undefined)
  registerAgentThreadOpener(open)
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Open worker thread/ }))
  expect((await screen.findByRole('alert')).textContent).toContain('Worker history unavailable')
  expect(screen.getByText('Preserved worker result')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /Open worker thread/ }))
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
})

it('prevents repeated clicks while the navigation is pending', async () => {
  let finish!: () => void
  const open = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  registerAgentThreadOpener(open)
  mount()
  const action = await screen.findByRole('button', { name: /Open worker thread/ })
  fireEvent.click(action)
  fireEvent.click(action)
  expect(open).toHaveBeenCalledTimes(1)
  expect(action.getAttribute('aria-busy')).toBe('true')
  finish()
  await waitFor(() => expect(action.getAttribute('aria-busy')).toBe('false'))
})

it.each([null, {}, '{invalid', 'null', '[]', { worker_session_id: '../other' },
  { worker_session_id: 'https://other-computer/thread' }, { worker_session_id: 42 }
])('does not invent a conversation for malformed or missing metadata %j', async metadata => {
  run.metadata = metadata
  registerAgentThreadOpener(vi.fn())
  mount()
  await screen.findByText('Preserved worker result')
  expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
})

it.each([null, '../other', 'analyst\n'])('does not infer a worker from the task assignee when the run profile is %j', async profile => {
  run.profile = profile
  registerAgentThreadOpener(vi.fn())
  mount()
  await screen.findByText('Preserved worker result')
  expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
})

it('keeps history readable when the Bot controller is not available', async () => {
  mount()
  await screen.findByText('Preserved worker result')
  expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
})

it('does not attach an older attempt navigation error to a newly selected attempt', async () => {
  let fail!: (reason: Error) => void
  registerAgentThreadOpener(vi.fn(() => new Promise((_resolve, reject) => { fail = reject })))
  const view = render(<WorkerThreadLink profile="analyst" sessionId="first-attempt" />)
  fireEvent.click(screen.getByRole('button', { name: /Open worker thread/ }))
  view.rerender(<WorkerThreadLink profile="reviewer" sessionId="second-attempt" />)
  await act(async () => fail(new Error('Old attempt failed')))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Open worker thread: @reviewer' }).getAttribute('aria-busy')).toBe('false')
})

it('removes the action when its navigation controller is disposed', async () => {
  const release = registerAgentThreadOpener(vi.fn())
  render(<WorkerThreadLink profile="analyst" sessionId="worker-session" />)
  expect(screen.getByRole('button', { name: /Open worker thread/ })).toBeTruthy()
  await act(async () => release())
  expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
})
