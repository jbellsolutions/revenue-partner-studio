import { QueryClient } from '@tanstack/react-query'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { useEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import type { ClientSessionState } from '@/app/types'
import { chatMessageText, toChatMessages } from '@/lib/chat-messages'
import { createClientSessionState } from '@/lib/chat-runtime'
import type { RpcEvent } from '@/types/hermes'

import { useMessageStream } from './index'

let handler: ((event: RpcEvent) => void) | null = null
const states = new Map<string, ClientSessionState>()
const active = { current: 'foreground' as string | null }

function Harness() {
  const stateRef = useRef(states)
  const queryRef = useRef(new QueryClient())

  const stream = useMessageStream({
    activeSessionIdRef: active,
    sessionStateByRuntimeIdRef: stateRef,
    queryClient: queryRef.current,
    hydrateFromStoredSession: vi.fn(async () => undefined),
    refreshHermesConfig: vi.fn(async () => undefined),
    refreshSessions: vi.fn(async () => undefined),
    updateSessionState: (sid, updater) => {
      const next = updater(states.get(sid) ?? createClientSessionState())
      states.set(sid, next)

      return next
    }
  })

  useEffect(() => {
    handler = stream.handleGatewayEvent
  }, [stream.handleGatewayEvent])

  return null
}

afterEach(() => {
  cleanup()
  states.clear()
  handler = null
})

it('shows a delivery before its reply, deduplicates it, and leaves another conversation alone', async () => {
  const foreground = createClientSessionState('foreground')
  states.set('foreground', foreground)
  states.set(
    'background',
    createClientSessionState('background', [{ id: 'reply', role: 'assistant', pending: true, parts: [] }])
  )
  render(<Harness />)
  await waitFor(() => expect(handler).not.toBeNull())

  const payload = {
    kind: 'task_delivery',
    text: 'Computed 161',
    display_metadata: {
      delivery_ids: ['d1'],
      task_updates: [{ task_id: 't1', board: 'team', text: 'Computed 161', worker: 'analyst' }]
    }
  }

  act(() => {
    handler!({ type: 'status.update', session_id: 'background', payload })
    handler!({ type: 'status.update', session_id: 'background', payload })
  })
  const messages = states.get('background')!.messages
  expect(messages).toHaveLength(2)
  expect(chatMessageText(messages[0])).toBe('Computed 161')
  expect(messages[0].taskUpdates?.[0].worker).toBe('analyst')
  expect(messages[1].id).toBe('reply')

  const [rehydrated] = toChatMessages([
    {
      role: 'user',
      content: payload.text,
      display_kind: 'kanban_notification',
      display_metadata: payload.display_metadata
    }
  ])

  expect(messages[0].id).toBe(rehydrated.id)
  expect(states.get('foreground')).toBe(foreground)
  expect(active.current).toBe('foreground')
})

it('displays a passive update without starting a reply or changing idle state', async () => {
  states.set('foreground', createClientSessionState('foreground'))
  render(<Harness />)
  await waitFor(() => expect(handler).not.toBeNull())

  act(() =>
    handler!({
      type: 'status.update',
      session_id: 'foreground',
      payload: {
        kind: 'task_delivery',
        text: 'Passive specialist result',
        display_metadata: {
          delivery_ids: ['passive-1'],
          task_updates: [{ task_id: 'task-1', board: 'team', worker: 'researcher', text: 'Passive specialist result' }]
        }
      }
    })
  )

  const state = states.get('foreground')!
  expect(state.messages).toHaveLength(1)
  expect(state.messages[0].taskUpdates?.[0].worker).toBe('researcher')
  expect(state.messages.some(message => message.pending)).toBe(false)
  expect(state.busy).toBe(false)
  expect(state.awaitingResponse).toBe(false)
})
