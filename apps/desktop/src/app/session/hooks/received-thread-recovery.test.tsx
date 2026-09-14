/** Exercise the real resume + route-retry hooks together, with only transport faked. */
import { useStore } from '@nanostores/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { getLatestSessionMessages, type SessionInfo } from '@/hermes'
import { createClientSessionState } from '@/lib/chat-runtime'
import { ensureGatewayProfile } from '@/store/profile'
import {
  $activeSessionId,
  $freshDraftReady,
  $messages,
  $resumeExhaustedSessionId,
  $resumeFailedSessionId,
  $selectedStoredSessionId,
  setActiveSessionId,
  setFreshDraftReady,
  setMessages,
  setResumeExhaustedSessionId,
  setResumeFailedSessionId,
  setSelectedStoredSessionId,
  setSessions
} from '@/store/session'

import type { ClientSessionState } from '../../types'

import { useRouteResume } from './use-route-resume'
import { useSessionActions } from './use-session-actions'

vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getLatestSessionMessages: vi.fn()
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  ensureGatewayProfile: vi.fn()
}))

function ReceivingThread({
  requestGateway
}: {
  requestGateway: <T>(method: string, params?: Record<string, unknown>) => Promise<T>
}) {
  const activeSessionId = useStore($activeSessionId)
  const selectedStoredSessionId = useStore($selectedStoredSessionId)
  const freshDraftReady = useStore($freshDraftReady)
  const resumeFailedSessionId = useStore($resumeFailedSessionId)
  const resumeExhaustedSessionId = useStore($resumeExhaustedSessionId)
  const messages = useStore($messages)
  const activeSessionIdRef = useRef<string | null>(null)
  const selectedStoredSessionIdRef = useRef<string | null>(null)
  const creatingSessionRef = useRef(false)
  const busyRef = useRef(false)
  const runtimeIdByStoredSessionIdRef = useRef(new Map<string, string>())
  const sessionStateByRuntimeIdRef = useRef(new Map<string, ClientSessionState>())

  const actions = useSessionActions({
    activeSessionId,
    activeSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    creatingSessionRef,
    busyRef,
    runtimeIdByStoredSessionIdRef,
    sessionStateByRuntimeIdRef,
    requestGateway,
    getRouteToken: () => 'received',
    getRoutedStoredSessionId: () => 'received',
    navigate: vi.fn(),
    resetViewSync: vi.fn(),
    syncSessionStateToView: vi.fn(),
    ensureSessionState: () => createClientSessionState('received'),
    updateSessionState: (_id, update) => update(createClientSessionState('received'))
  })

  useRouteResume({
    activeSessionId,
    activeSessionIdRef,
    selectedStoredSessionId,
    selectedStoredSessionIdRef,
    creatingSessionRef,
    runtimeIdByStoredSessionIdRef,
    freshDraftReady,
    resumeFailedSessionId,
    resumeExhaustedSessionId,
    currentView: 'chat',
    gatewayState: 'open',
    locationPathname: '/received',
    routedSessionId: 'received',
    resumeSession: actions.resumeSession,
    startFreshSessionDraft: actions.startFreshSessionDraft
  })

  return <pre data-testid="transcript">{JSON.stringify(messages)}</pre>
}

afterEach(() => {
  cleanup()
  setActiveSessionId(null)
  setSelectedStoredSessionId(null)
  setResumeFailedSessionId(null)
  setResumeExhaustedSessionId(null)
  setFreshDraftReady(false)
  setMessages([])
  setSessions([])
  vi.restoreAllMocks()
})

it('automatically displays a received transcript after a transient profile-start failure', async () => {
  setSessions([
    {
      id: 'received',
      profile: 'receiver',
      source: 'desktop',
      message_count: 1,
      title: 'Shared thread',
      started_at: 1,
      last_active: 1
    } as SessionInfo
  ])
  vi.mocked(ensureGatewayProfile).mockRejectedValueOnce(new Error('receiver waking up')).mockResolvedValue(undefined)
  vi.mocked(getLatestSessionMessages).mockResolvedValue({
    session_id: 'received',
    messages: [{ role: 'assistant', content: 'Received specialist result with provenance', timestamp: 1 }]
  } as never)

  const requestGateway = vi.fn(
    async () =>
      ({
        session_id: 'receiver-runtime',
        session_key: 'received',
        messages: [],
        messages_omitted: true,
        running: false
      }) as never
  )

  render(<ReceivingThread requestGateway={requestGateway} />)
  await waitFor(() => expect($resumeFailedSessionId.get()).toBe('received'))
  expect(requestGateway).not.toHaveBeenCalled()
  await waitFor(
    () => expect(screen.getByTestId('transcript').textContent).toContain('Received specialist result with provenance'),
    { timeout: 5_000 }
  )

  expect(ensureGatewayProfile).toHaveBeenCalledTimes(2)
  expect(requestGateway).toHaveBeenCalledWith(
    'session.resume',
    expect.objectContaining({
      session_id: 'received',
      profile: 'receiver'
    })
  )
  expect($activeSessionId.get()).toBe('receiver-runtime')
  expect($resumeFailedSessionId.get()).toBeNull()
  expect($resumeExhaustedSessionId.get()).toBeNull()
})
