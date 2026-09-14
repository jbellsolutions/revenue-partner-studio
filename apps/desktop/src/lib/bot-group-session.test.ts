import { describe, expect, it } from 'vitest'

import { resolveGroupSessionBinding } from './bot-group-session'

const group = {
  id: 'trio',
  participantIds: ['dewey', 'agentinbox', 'newbot'],
  profile: 'dewey',
  sessionId: 'stored-a',
  title: 'Dewey, Agent Inbox, New Bot'
}

describe('resolveGroupSessionBinding', () => {
  it('keeps a known stored id bound to the group', () => {
    const next = resolveGroupSessionBinding({
      storedId: 'stored-a',
      runtimeId: 'rt-1',
      eventProfile: 'dewey',
      activeRuntime: 'rt-1',
      groups: { trio: group },
      pendingGroupId: null,
      activeGroupId: 'trio',
      navigationTarget: 'group:trio',
      isDraft: false
    })

    expect(next).toEqual({ action: 'bind', groupId: 'trio', sessionId: 'stored-a', clearPending: false })
  })

  it('rebinds compression only while the same group is still active', () => {
    const next = resolveGroupSessionBinding({
      storedId: 'stored-b',
      runtimeId: 'rt-1',
      eventProfile: 'dewey',
      activeRuntime: 'rt-1',
      groups: { trio: { ...group, sessionId: 'stored-a' } },
      pendingGroupId: null,
      runtimeBoundGroupId: 'trio',
      activeGroupId: 'trio',
      navigationTarget: 'group:trio',
      isDraft: false
    })

    expect(next.action).toBe('bind')

    if (next.action === 'bind') {
      expect(next.sessionId).toBe('stored-b')
    }
  })

  it('does not retarget a group onto a 1:1 after leaving the group', () => {
    const next = resolveGroupSessionBinding({
      storedId: 'bot-chat',
      runtimeId: 'rt-1',
      eventProfile: 'dewey',
      activeRuntime: 'rt-1',
      groups: { trio: group },
      pendingGroupId: null,
      runtimeBoundGroupId: 'trio',
      activeGroupId: null,
      navigationTarget: 'dewey',
      isDraft: false
    })

    expect(next.action).not.toBe('bind')
  })
})
