import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $agentThreadOpener, registerAgentThreadOpener } from '@/app/bot-product/agent-thread-navigation'
import { toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import type { TaskUpdate } from '@/types/hermes'

import { TaskDeliveryNote } from './task-delivery-note'

afterEach(() => {
  cleanup()
  $agentThreadOpener.set(null)
})

describe('attributed task delivery', () => {
  it('keeps the result readable when the Bot navigation controller is unavailable', () => {
    render(
      <TaskDeliveryNote
        text="Saved"
        updates={[
          { board: 'team', task_id: 't1', text: 'Saved result', worker: 'analyst', worker_session_id: 'worker-thread' }
        ]}
      />
    )
    expect(screen.getByText('Saved result')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
  })

  it('opens the recorded worker thread only after a click, including after transcript reload', async () => {
    const open = vi.fn().mockResolvedValue(undefined)
    registerAgentThreadOpener(open)

    const [message] = toChatMessages([
      {
        role: 'user',
        content: 'Saved result',
        display_kind: 'kanban_notification',
        display_metadata: JSON.stringify({
          delivery_ids: ['d1'],
          task_updates: [
            {
              board: 'team',
              task_id: 't1',
              text: 'Computed 161',
              worker: 'analyst',
              assignee: 'reviewer',
              worker_session_id: '20260908_worker_run'
            }
          ]
        })
      }
    ])

    const runtime = toRuntimeMessage(message)
    render(<TaskDeliveryNote text="Saved result" updates={runtime.metadata.custom.taskUpdates as TaskUpdate[]} />)
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /Open worker thread/ }))
    await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith('analyst', '20260908_worker_run'))
  })

  it('shows a failed open without losing the result and allows an explicit retry', async () => {
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('Profile temporarily unavailable'))
      .mockResolvedValueOnce(undefined)

    registerAgentThreadOpener(open)
    render(
      <TaskDeliveryNote
        text="Result"
        updates={[
          {
            board: 'team',
            task_id: 't1',
            text: 'Result retained',
            worker: 'analyst',
            worker_session_id: 'worker-thread'
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Open worker thread/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('Profile temporarily unavailable')
    expect(screen.getByText('Result retained')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Open worker thread/ }))
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it.each([
    { assignee: 'analyst', worker_session_id: 'worker-thread' },
    { worker: 'analyst' },
    { worker: '../other', worker_session_id: 'worker-thread' },
    { worker: 'analyst\n', worker_session_id: 'worker-thread' },
    { worker: 'analyst', worker_session_id: 'worker-thread\n' },
    { worker: 'analyst', worker_session_id: 'https://other-computer/thread' },
    { worker: 'analyst', worker_session_id: '../private-thread' }
  ])('does not guess a destination from missing or malformed worker identity %j', fields => {
    registerAgentThreadOpener(vi.fn())
    render(<TaskDeliveryNote text="Saved" updates={[{ board: 'team', task_id: 't1', text: 'Saved', ...fields }]} />)
    expect(screen.queryByRole('button', { name: /Open worker thread/ })).toBeNull()
  })

  it('carries persisted attribution through the runtime bridge into the notice', () => {
    const [message] = toChatMessages([
      {
        role: 'user',
        content: 'Saved result',
        display_kind: 'kanban_notification',
        display_metadata: {
          delivery_ids: ['d1'],
          task_updates: [
            { board: 'team', task_id: 't1', text: 'Computed 161', worker: 'analyst', assignee: 'reviewer' },
            { board: 'team', task_id: 't2', text: 'Waiting for review', assignee: 'reviewer' }
          ]
        }
      }
    ])

    const runtime = toRuntimeMessage(message)
    expect(runtime.role).toBe('system')
    render(<TaskDeliveryNote text="Saved result" updates={runtime.metadata.custom.taskUpdates as TaskUpdate[]} />)
    expect(screen.getByText('Worker @analyst')).toBeTruthy()
    expect(screen.getByText('Assigned to @reviewer')).toBeTruthy()
    expect(screen.queryByText('Worker @reviewer')).toBeNull()
    expect(screen.getByText('Computed 161')).toBeTruthy()
    expect(screen.getByText('team / t2')).toBeTruthy()
  })

  it('keeps legacy text visible without inventing a worker', () => {
    render(<TaskDeliveryNote text="Existing saved notification" updates={[]} />)
    expect(screen.getByText('Team task update')).toBeTruthy()
    expect(screen.getByText('Existing saved notification')).toBeTruthy()
    expect(screen.queryByText(/Worker @/)).toBeNull()
  })
})
