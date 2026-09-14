/** Canonical group-session binder. Plugin.js keeps an identical copy because
 *  the runtime disk loader evaluates a single blob and cannot import this
 *  module. Packaged tests should prefer this typed export. */

export interface BotGroupRecord {
  id: string
  participantIds?: string[]
  profile: string
  sessionId?: string
  title?: string
}

export interface GroupSessionBindingInput {
  storedId: string
  runtimeId: string
  eventProfile?: string
  activeRuntime?: string | null
  groups: Record<string, BotGroupRecord | undefined> | null | undefined
  pendingGroupId?: string | null
  runtimeBoundGroupId?: string
  activeGroupId?: string | null
  navigationTarget?: string
  isDraft?: boolean
}

export type GroupSessionBinding =
  | { action: 'bind'; groupId: string; sessionId: string; clearPending: boolean }
  | { action: 'keep' }
  | { action: 'clear' }
  | { action: 'ignore' }

export function resolveGroupSessionBinding(input: GroupSessionBindingInput): GroupSessionBinding {
  const {
    storedId,
    runtimeId,
    eventProfile,
    activeRuntime,
    groups,
    pendingGroupId,
    runtimeBoundGroupId,
    activeGroupId,
    navigationTarget,
    isDraft
  } = input

  const roster = groups && typeof groups === 'object' ? groups : {}
  const found = Object.values(roster).find(item => item && item.sessionId === storedId)

  if (found) {
    return { action: 'bind', groupId: found.id, sessionId: storedId, clearPending: false }
  }

  if (runtimeBoundGroupId && roster[runtimeBoundGroupId] && activeGroupId === runtimeBoundGroupId) {
    return { action: 'bind', groupId: runtimeBoundGroupId, sessionId: storedId, clearPending: false }
  }

  const pending = pendingGroupId ? roster[pendingGroupId] : null

  if (pending) {
    const profile = String(eventProfile || pending.profile || '').trim()

    if (profile === pending.profile && (!activeRuntime || activeRuntime === runtimeId)) {
      return { action: 'bind', groupId: pending.id, sessionId: storedId, clearPending: true }
    }
  }

  if (isDraft) {
    return { action: 'ignore' }
  }

  const openingGroup = String(navigationTarget || '').startsWith('group:')

  if (openingGroup || (activeGroupId && roster[activeGroupId])) {
    return { action: 'keep' }
  }

  if (activeRuntime === runtimeId) {
    return { action: 'clear' }
  }

  return { action: 'ignore' }
}
