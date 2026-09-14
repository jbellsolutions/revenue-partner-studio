import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as HermesModule from '@/hermes'
import { getProfiles, getSession } from '@/hermes'
import { $activeGatewayProfile, $profiles } from '@/store/profile'
import { $sessions } from '@/store/session'
import type { SessionInfo } from '@/types/hermes'

import { resolveSessionProfile, resolveStoredSession } from './utils'

vi.mock('@/hermes', async importActual => ({
  ...(await importActual<typeof HermesModule>()),
  getProfiles: vi.fn(),
  getSession: vi.fn()
}))

const mockGetSession = vi.mocked(getSession)

const session = (over: Partial<SessionInfo>): SessionInfo => over as SessionInfo

const profiles = (...names: string[]) => names.map(name => ({ name }) as never)

describe('resolveStoredSession profile ownership', () => {
  beforeEach(() => {
    $sessions.set([])
    $profiles.set(profiles('default', 'meta'))
    $activeGatewayProfile.set('meta')
    mockGetSession.mockReset()
    vi.mocked(getProfiles).mockReset()
  })

  afterEach(() => {
    $sessions.set([])
    $profiles.set([])
    $activeGatewayProfile.set('default')
  })

  it('resolves a cold active-profile thread before the all-profile list has refreshed', async () => {
    $profiles.set([])
    mockGetSession.mockImplementation(async (id, profile) => {
      if (profile !== 'meta') {
        throw new Error('404: Session not found on primary')
      }

      return session({ id, profile: 'default', message_count: 2 })
    })

    const resolved = await resolveStoredSession('cold-worker-thread')

    expect(resolved?.id).toBe('cold-worker-thread')
    expect(resolved?.profile).toBe('meta')
    expect(mockGetSession).toHaveBeenCalledExactlyOnceWith('cold-worker-thread', 'meta')
  })

  it('keeps the requested profile ownership if the active gateway changes during lookup', async () => {
    mockGetSession.mockImplementation(async id => {
      $activeGatewayProfile.set('default')

      return session({ id })
    })

    const resolved = await resolveStoredSession('cold-worker-thread')

    expect(resolved?.profile).toBe('meta')
  })

  it('loads the profile inventory on cold reload before declaring a worker thread missing', async () => {
    $activeGatewayProfile.set('default')
    $profiles.set([])
    vi.mocked(getProfiles).mockResolvedValue({ profiles: profiles('default', 'meta') } as never)
    mockGetSession.mockImplementation(async (id, profile) => {
      if (profile !== 'meta') {
        throw new Error('404: not on primary')
      }

      return session({ id, profile: 'meta' })
    })

    await expect(resolveStoredSession('worker-thread')).resolves.toMatchObject({ id: 'worker-thread', profile: 'meta' })
    expect(getProfiles).toHaveBeenCalledOnce()
    expect(mockGetSession).toHaveBeenNthCalledWith(1, 'worker-thread', 'default')
    expect(mockGetSession).toHaveBeenNthCalledWith(2, 'worker-thread', 'meta')
  })

  it('does not turn a failed cold profile discovery into a missing-thread verdict', async () => {
    $profiles.set([])
    mockGetSession.mockRejectedValue(new Error('404: not on active profile'))
    vi.mocked(getProfiles).mockRejectedValue(new Error('Profile inventory temporarily unavailable'))

    await expect(resolveStoredSession('worker-thread')).rejects.toThrow('Profile inventory temporarily unavailable')
  })

  it('returns a cached row that carries an owning profile', async () => {
    $sessions.set([session({ id: 's1', profile: 'default' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('treats a profile-less cache hit as unresolved when multiple profiles exist', async () => {
    $sessions.set([session({ id: 's1' })])
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // rung 2 (explicit active scope) then rung 3 (cross-profile probe)
    expect(mockGetSession).toHaveBeenNthCalledWith(1, 's1', 'meta')
    expect(mockGetSession).toHaveBeenNthCalledWith(2, 's1', 'default')
  })

  it('accepts a profile-less cache hit for single-profile users', async () => {
    $profiles.set(profiles('default'))
    $sessions.set([session({ id: 's1' })])

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.id).toBe('s1')
    expect(mockGetSession).not.toHaveBeenCalled()
  })

  it('stamps the requested active profile on a by-id hit from an older backend', async () => {
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    // the upserted cache row is owned too, so the next hit short-circuits
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('probed desktop profile overrides a remote backend answering as its own "default"', async () => {
    // Per-profile remote override: Electron strips the desktop alias before
    // forwarding, so the standalone backend stamps its backend-local root.
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))
    $activeGatewayProfile.set('default')
    $profiles.set(profiles('default', 'meta'))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('meta')
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('meta')
  })

  it('stamps the probed profile on a scoped hit from an older backend that omits it', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1' }))

    const resolved = await resolveStoredSession('s1')

    expect(resolved?.profile).toBe('default')
    // the cached row is owned too — no unowned row is ever re-cached
    expect($sessions.get().find(s => s.id === 's1')?.profile).toBe('default')
  })

  it('resolveSessionProfile routes a default-profile session from a non-default gateway', async () => {
    mockGetSession.mockRejectedValueOnce(new Error('404: Session not found'))
    mockGetSession.mockResolvedValueOnce(session({ id: 's1', profile: 'default' }))

    await expect(resolveSessionProfile('s1')).resolves.toBe('default')
  })
})
