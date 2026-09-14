import type { ModelSelection } from './model-catalog'
import type { Attachment } from './attachments'
export type Message = { id: string | number; role: string; content: string; truncated?: boolean }
export type Agent = { id: string; name: string; description: string; model: string; provider: string; head: boolean }
export type Conversation = {
  modelSelection?: ModelSelection
  pendingSend?: { requestId: string; runtimeId: string; text: string; attachmentIds: string[] }
  attachments: Attachment[]
  readOnly: boolean
  afterSeq: number
  runtimeId: string
  sessionId: string | null
  messages: Message[]
  draft: string
  running: boolean
  loading: boolean
  error: string
  hasMore: boolean
  model: string
  provider: string
  stream: string
}
export type Space = {
  agents: Agent[]
  agentId: string
  conversations: Record<string, Conversation>
  selected: Record<string, string>
  online: boolean
  connectorOnline?: boolean
  healthCursor?: number
  runtimeVersion?: string
  runtimeEpoch?: string
  peerRevision?: number
  capabilities: Record<string, boolean>
  error: string
  seq: number
  tasks: any[]
  approvals: any[]
}
export function blankConversation(): Conversation {
  return {
    attachments: [],
    readOnly: false,
    afterSeq: 0,
    runtimeId: '',
    sessionId: null,
    messages: [],
    draft: '',
    running: false,
    loading: false,
    error: '',
    hasMore: false,
    model: '',
    provider: '',
    stream: ''
  }
}
export function blankSpace(): Space {
  return {
    agents: [],
    agentId: 'default',
    conversations: {},
    selected: {},
    online: false,
    capabilities: {},
    error: '',
    seq: 0,
    tasks: [],
    approvals: []
  }
}
export function runtimeHealth(space: Space, status: { eventCursor?: number; epoch?: string; runtimeConnected: boolean }): Space {
  if ((status.eventCursor ?? 0) < (space.healthCursor || 0)) return space
  const changed = status.epoch && space.runtimeEpoch && status.epoch !== space.runtimeEpoch
  return { ...space, online: status.runtimeConnected, healthCursor: status.eventCursor || space.healthCursor,
    runtimeEpoch: status.epoch || space.runtimeEpoch,
    conversations: changed ? Object.fromEntries(Object.entries(space.conversations).map(([key, c]) =>
      [key, { ...c, runtimeId: '', loading: false }])) : space.conversations }
}
export function reduceEvent(space: Space, event: any): Space {
  if (!Number.isSafeInteger(event.seq) || event.seq <= space.seq) return space
  const next = { ...space, seq: event.seq }
  // Replayed transport events describe the past, not the currently probed runtime.
  if (event.kind.startsWith('runtime.') && (event.replay || event.seq <= (space.healthCursor || 0))) return next
  if (event.kind === 'runtime.disconnected')
    return {
      ...next,
      healthCursor: event.seq,
      online: false,
      conversations: Object.fromEntries(
        Object.entries(space.conversations).map(([key, c]) => [key, { ...c, runtimeId: '', loading: false }])
      )
    }
  if (event.kind === 'runtime.connected') return runtimeHealth(next, { runtimeConnected: true, eventCursor: event.seq, epoch: event.payload?.epoch })
  if (event.kind === 'peer.changed' || event.kind === 'peer.approval_required')
    return { ...next, peerRevision: event.seq }
  if (event.kind === 'studio.task') {
    const task = event.payload
    const conversations = Object.fromEntries(
      Object.entries(space.conversations).map(([key, c]) => [
        key,
        c.pendingSend?.requestId === task.id ? { ...c, pendingSend: undefined, draft: '', attachments: [] } : c
      ])
    )
    for (const [key, c] of Object.entries(conversations))
      if (c.runtimeId && c.runtimeId === task.runtime_id) {
        if (['cancelled', 'needs_review', 'error'].includes(task.state))
          conversations[key] = {
            ...c,
            running: false,
            error: task.state === 'cancelled' ? '' : task.result || 'This task needs review before retrying.'
          }
        else if (['queued', 'starting', 'running'].includes(task.state)) conversations[key] = { ...c, running: true }
      }
    return { ...next, conversations, tasks: [task, ...space.tasks.filter(t => t.id !== task.id)].slice(0, 40) }
  }
  if (event.kind === 'approval.request') {
    return {
      ...next,
      approvals: [
        ...space.approvals.filter(a => a.request_id !== event.payload.request_id),
        { ...event.payload, runtimeId: event.runtimeId, agentId: event.agentId }
      ]
    }
  }
  const entry = Object.entries(space.conversations).find(
    ([key, c]) => key.startsWith(event.agentId + '/') && c.runtimeId === event.runtimeId
  )
  if (!entry) return next
  const [key, c] = entry
  if (event.seq <= c.afterSeq) return next
  let updated = { ...c }
  const p = event.payload || {}
  if (event.kind === 'session.reclaimed')
    return { ...next, conversations: { ...space.conversations, [key]: { ...c, runtimeId: '', loading: false } } }
  if (event.kind === 'message.delta') updated = { ...updated, running: true, stream: updated.stream + (p.text || '') }
  if (event.kind === 'message.complete') {
    const content = p.text || updated.stream
    updated = {
      ...updated,
      running: false,
      stream: '',
      messages: content
        ? [...updated.messages, { id: 'event-' + event.seq, role: 'assistant', content }]
        : updated.messages,
      error: p.status === 'error' ? p.error || 'The model could not complete this turn.' : ''
    }
  }
  if (event.kind === 'session.info')
    updated = { ...updated, running: !!p.running, sessionId: p.stored_session_id || p.session_key || updated.sessionId }
  return { ...next, conversations: { ...space.conversations, [key]: updated } }
}

export function selectedKey(space: Space, agent: string) {
  return space.selected[agent] || agent + '/new'
}
export function currentConversation(space: Space, agent: string) {
  return space.conversations[selectedKey(space, agent)] || blankConversation()
}
export function restoreSpaces(): Record<string, Space> {
  try {
    const saved = JSON.parse(localStorage.getItem('studio.preferences') || '{}'),
      result: Record<string, Space> = {}
    for (const [id, value] of Object.entries(saved)) {
      const v = value as any
      if (!v || typeof v.agentId !== 'string') continue
      const conversations: Record<string, Conversation> = {}
      for (const [key, raw] of Object.entries(v.conversations || {})) {
        const c = raw as any
        conversations[key] = {
          ...blankConversation(),
          pendingSend: c.pendingSend && typeof c.pendingSend.requestId === 'string' ? c.pendingSend : undefined,
          attachments: Array.isArray(c.attachments)
            ? c.attachments
                .slice(0, 10)
                .map((a: Attachment) => ({
                  ...a,
                  status: a.status === 'ready' ? 'ready' : 'error',
                  error: a.status === 'ready' ? undefined : 'Choose this file again to resume its upload.'
                }))
            : [],
          sessionId: typeof c.sessionId === 'string' ? c.sessionId : null,
          draft: String(c.draft || '').slice(0, 100000),
          model: String(c.model || ''),
          provider: String(c.provider || '')
        }
      }
      result[id] = { ...blankSpace(), agentId: v.agentId, selected: v.selected || {}, conversations }
    }
    return result
  } catch {
    return {}
  }
}
export function saveSpaces(spaces: Record<string, Space>) {
  const saved = Object.fromEntries(
    Object.entries(spaces).map(([id, s]) => [
      id,
      {
        agentId: s.agentId,
        selected: s.selected,
        conversations: Object.fromEntries(
          Object.entries(s.conversations).map(([key, c]) => [
            key,
            {
              sessionId: c.sessionId,
              draft: c.draft,
              model: c.model,
              provider: c.provider,
              attachments: c.attachments,
              pendingSend: c.pendingSend
            }
          ])
        )
      }
    ])
  )
  try {
    localStorage.setItem('studio.preferences', JSON.stringify(saved))
  } catch {
    /* Storage may be unavailable in private browser sessions. */
  }
}
