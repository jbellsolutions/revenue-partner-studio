import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { registerPluginLocales, translatePlugin } from '@/i18n/plugin-i18n'
import { $boardSlug, cancelTask, taskKey } from '@/plugins/kanban/api'
import { TaskCancellation } from '@/plugins/kanban/cancellation'
import { TaskDrawer } from '@/plugins/kanban/drawer'
import { KANBAN_LOCALES } from '@/plugins/kanban/i18n'
import type { KanbanTask, KanbanTaskDetail } from '@/plugins/kanban/types'

vi.mock('@/plugins/kanban/api', async original => ({
  ...(await original<Record<string, unknown>>()),
  cancelTask: vi.fn(),
  fetchTask: vi.fn(async () => detail()),
  fetchLog: vi.fn(async () => ({ exists: false, content: '', size_bytes: 0, truncated: false })),
  fetchOrchestration: vi.fn(async () => ({ default_assignee: '' })),
  fetchProfiles: vi.fn(async () => ({ profiles: [] }))
}))

let client: QueryClient
let dispose: () => void
let serverTask: KanbanTask

const detail = (): KanbanTaskDetail => ({
  task: serverTask,
  comments: [],
  events: [],
  attachments: [],
  links: { parents: [], children: [] },
  runs: []
})

beforeEach(() => {
  vi.clearAllMocks()
  dispose = registerPluginLocales('kanban', KANBAN_LOCALES)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  $boardSlug.set('verification')
  serverTask = { id: 't_cancel', title: 'Synthetic task', status: 'running', cancellation_supported: true }
})

afterEach(() => {
  cleanup()
  client.clear()
  dispose()
  $boardSlug.set('')
})

function Harness() {
  const query = useQuery({
    queryKey: taskKey('verification', 't_cancel'),
    queryFn: async () => detail(),
    initialData: detail()
  })

  return <TaskCancellation task={query.data.task} />
}

function mount() {
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>
  )
}

async function confirmStop() {
  fireEvent.click(screen.getByRole('button', { name: /Cancel task|Retry stopping/ }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel task' }))
}

it('requires confirmation and keeps the task when dismissed', async () => {
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('Synthetic task')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep task' }))
  expect(cancelTask).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('Escape dismisses only the confirmation, not the underlying task drawer', async () => {
  const onClose = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <TaskDrawer columns={['running', 'cancelled']} id="t_cancel" onClose={onClose} onOpen={vi.fn()} />
    </QueryClientProvider>
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel task' }))
  const dialog = await screen.findByRole('dialog')
  fireEvent.keyDown(dialog, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(onClose).not.toHaveBeenCalled()
  expect(cancelTask).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledTimes(1)
})

it('shows confirmed stop only after the API confirms cleanup', async () => {
  vi.mocked(cancelTask).mockImplementation(async () => {
    serverTask = { ...serverTask, status: 'cancelled', cancellation_pending: false }

    return { ok: true, status: 'cancelled', worker_stopped: true }
  })
  mount()
  await confirmStop()
  expect(cancelTask).toHaveBeenCalledWith('t_cancel', 'verification')
  expect(await screen.findByText('Cancelled; verified workers stopped.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Retry stopping' })).toBeNull()
})

it('retains pending state and offers an explicit cleanup retry', async () => {
  vi.mocked(cancelTask).mockImplementation(async () => {
    serverTask = { ...serverTask, status: 'cancelled', cancellation_pending: true }

    return { ok: false, status: 'cancelled', worker_stopped: false }
  })
  mount()
  await confirmStop()
  expect(await screen.findByText('Stop requested; worker cleanup is not yet confirmed.')).toBeTruthy()
  expect(screen.queryByText('Cancelled; verified workers stopped.')).toBeNull()
  await confirmStop()
  await waitFor(() => expect(cancelTask).toHaveBeenCalledTimes(2))
})

it('surfaces a request failure without claiming the worker stopped', async () => {
  vi.mocked(cancelTask).mockRejectedValue(new Error('Synthetic connection interrupted'))
  mount()
  await confirmStop()
  expect(await screen.findByText('Synthetic connection interrupted')).toBeTruthy()
  expect(screen.queryByText('Cancelled; verified workers stopped.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Cancel task' })).toBeTruthy()
})

it.each(['done', 'archived', 'unsupported'])('does not offer unsafe cancellation for %s', state => {
  serverTask = {
    ...serverTask,
    status: state === 'unsupported' ? 'running' : state,
    cancellation_supported: state !== 'unsupported'
  }
  mount()
  expect(screen.queryByRole('button')).toBeNull()
})

it.each(['en', 'ja', 'zh', 'zh-hant', 'ar'] as const)('resolves cancellation copy in %s', locale => {
  const bundle = KANBAN_LOCALES[locale]!.taskCancellation as Record<string, string>

  for (const key of ['action', 'title', 'body', 'dismiss', 'stopping', 'pending', 'stopped', 'retry']) {
    expect(translatePlugin('kanban', locale, `taskCancellation.${key}`, [])).toBe(bundle[key])
    expect(bundle[key].trim().length).toBeGreaterThan(0)
  }
})
