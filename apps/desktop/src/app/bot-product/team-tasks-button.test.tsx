import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $pluginRecords, dropPlugin, publishPlugin } from '@/contrib/plugins-store'

import { TeamTasksButton } from './team-tasks-button'

afterEach(() => {
  cleanup()
  dropPlugin('kanban')
})

it('opens the registered board without creating or dispatching a task', () => {
  const navigate = vi.fn()
  publishPlugin({ id: 'kanban', name: 'Kanban', kind: 'bundled', status: 'loaded' })
  render(<TeamTasksButton onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Team tasks' }))
  expect(navigate).toHaveBeenCalledWith('/kanban')
})

it('waits for explicit activation before navigating to the board', async () => {
  const navigate = vi.fn()
  let finish!: () => void
  publishPlugin(
    { id: 'kanban', name: 'Kanban', kind: 'bundled', status: 'disabled' },
    {
      deactivate: vi.fn(),
      activate: () =>
        new Promise<void>(resolve => {
          finish = () => {
            publishPlugin({ ...$pluginRecords.get().kanban, status: 'loaded' })
            resolve()
          }
        })
    }
  )
  render(<TeamTasksButton onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Team tasks' }))
  expect(navigate).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Team tasks' }).hasAttribute('disabled')).toBe(true)
  finish()
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/kanban'))
})

it('shows an error instead of treating an unavailable board as a session', async () => {
  const navigate = vi.fn()
  render(<TeamTasksButton onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Team tasks' }))
  expect((await screen.findByRole('alert')).textContent).toContain('unavailable')
  expect(navigate).not.toHaveBeenCalled()
})

it('recovers from an activation failure on an explicit retry', async () => {
  const navigate = vi.fn()

  const activate = vi
    .fn()
    .mockRejectedValueOnce(new Error('Board failed to load'))
    .mockImplementationOnce(() =>
      publishPlugin({
        id: 'kanban',
        name: 'Kanban',
        kind: 'bundled',
        status: 'loaded'
      })
    )

  publishPlugin(
    { id: 'kanban', name: 'Kanban', kind: 'bundled', status: 'error' },
    {
      activate,
      deactivate: vi.fn()
    }
  )
  render(<TeamTasksButton onNavigate={navigate} />)
  fireEvent.click(screen.getByRole('button', { name: 'Team tasks' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Board failed to load')
  expect(navigate).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Team tasks' }))
  await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
  expect(screen.queryByRole('alert')).toBeNull()
})
