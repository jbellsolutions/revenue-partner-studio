import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { createPortal } from 'react-dom'
import { atom } from 'nanostores'
import { useStore } from '@nanostores/react'
import { Input } from '@/components/ui/input'

const $conversationTarget = atom<HTMLElement | null>(null)
export function closeStudioConversation() { window.dispatchEvent(new Event('studio:close-conversation')) }
export function StudioConversationMount() {
  return <div ref={node => $conversationTarget.set(node)} className="pointer-events-none absolute inset-0 z-[60]" />
}

type Agent = { name: string; role: string; stored_id: string | null }
type Group = { id: string; title: string; members: string[] }
type Delivery = { id: string; sender: string; recipient: string; body: string; result: string | null;
  state: string; response_id?: string | null; group_id: string | null; stored_id: string | null; created: number }
type Approval = { request_id: string; session_id: string; agent: string; command: string; description?: string; expires_at?: number }
type Snapshot = { agents: Agent[]; groups: Group[]; deliveries: Delivery[]; approvals?: Approval[] }
type RecoveryEvidence = { inspection_token: string; events: unknown[]; history_tail: unknown[] }
interface Props {
  connected: boolean
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
  onOpenThread: (profile: string, id: string) => Promise<unknown>
}

/** A read-through view of remote records. Names never come from parsed model prose. */
export function StudioCollaboration({ connected, request, onOpenThread }: Props) {
  const existingHermes = new URLSearchParams(window.location.search).get('workspace') === 'hermes'
  const target = useStore($conversationTarget)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [selected, setSelected] = useState<Group | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [recovering, setRecovering] = useState<string | null>(null)
  const [recoveryEvidence, setRecoveryEvidence] = useState<Record<string, RecoveryEvidence>>({})
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const followLatest = useRef(true)
  const generation = useRef(0)
  const pendingSend = useRef<{ id: string; body: string; group: string | null } | null>(null)
  const refresh = useCallback(async () => {
    const version = ++generation.current
    try {
      const result = await request('studio.snapshot', {}) as Snapshot
      if (version === generation.current) { setSnapshot(result); setError('') }
    } catch (e) {
      if (version === generation.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [request])
  useEffect(() => {
    if (!connected || existingHermes) return
    void refresh()
    const timer = setInterval(() => void refresh(), selected || showAll ? 2000 : 10000)
    return () => { clearInterval(timer); generation.current++ }
  }, [connected, refresh, selected, showAll])
  useEffect(() => {
    const close = () => { setSelected(null); setShowAll(false) }
    window.addEventListener('studio:close-conversation', close)
    return () => window.removeEventListener('studio:close-conversation', close)
  }, [])
  useEffect(() => { followLatest.current = true }, [selected?.id, showAll])
  useEffect(() => {
    const pane = scrollRef.current
    if (pane && followLatest.current) pane.scrollTop = pane.scrollHeight
  }, [snapshot, selected?.id, showAll, target])
  const send = async (operation: 'send' | 'redirect' = 'send') => {
    if (!message.trim() || sending) return
    setSending(true)
    const group = selected?.id ?? null
    if (!pendingSend.current || pendingSend.current.body !== message || pendingSend.current.group !== group) {
      pendingSend.current = { id: crypto.randomUUID(), body: message, group }
    }
    try {
      await request('studio.operation', { operation, recipient: selected?.members.includes('default') === false ? selected.members[0] : 'default',
        message, group_id: group, request_id: pendingSend.current.id })
      pendingSend.current = null
      setMessage('')
      await refresh()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setSending(false) }
  }
  const decide = async (approval: Approval, choice: 'once' | 'deny') => {
    if (deciding) return
    setDeciding(approval.request_id)
    try {
      const result = await request('approval.respond', {session_id:approval.session_id, request_id:approval.request_id, choice}) as {resolved?: number | boolean}
      if (!result.resolved) throw new Error('This request has expired or was already answered.')
      await refresh()
    } catch (e) { setError(String(e)) }
    finally { setDeciding(null) }
  }
  const recover = async (id: string, resume = false) => {
    if (recovering) return
    setRecovering(id)
    try {
      if (resume) {
        const evidence = recoveryEvidence[id]
        if (!evidence) throw new Error('Inspect the interrupted work first.')
        await request('studio.operation', {operation: 'resume_recovery', request_id: id, inspection_token: evidence.inspection_token})
        setRecoveryEvidence(previous => { const next = {...previous}; delete next[id]; return next })
        await refresh()
      } else {
        const evidence = await request('studio.operation', {operation: 'inspect_recovery', request_id: id}) as RecoveryEvidence
        setRecoveryEvidence(previous => ({...previous, [id]: evidence}))
      }
    } catch (e) { setError(String(e)) }
    finally { setRecovering(null) }
  }
  const deliveries = (snapshot?.deliveries ?? []).filter(d => !selected || d.group_id === selected.id).slice().reverse()
  const name = (id: string) => id === 'user' ? 'You' : id === 'default' ? 'Head of Operations' : snapshot?.agents.find(a => a.name === id)?.role || id
  // Native Hermes bots and groups remain in the main sidebar. This panel needs Studio RPCs.
  if (existingHermes) return null
  return <section className="studio-groups px-3 py-2" aria-label="Project groups">
    <div className="flex items-center justify-between text-xs text-(--ui-text-secondary)">
      <span>GROUPS</span><Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>Exchanges</Button>
    </div>
    {snapshot?.groups.map(group => <button key={group.id} type="button" className="w-full rounded-lg px-2 py-2 text-left text-sm hover:bg-(--ui-control-hover-background)" onClick={() => setSelected(group)}><span className="min-w-0 flex-1 truncate">{group.title}</span><span className="text-xs text-(--ui-text-tertiary)">{group.members.length}</span></button>)}
    {!snapshot?.groups.length && <p className="py-2 text-xs text-(--ui-text-tertiary)">{connected ? 'Ask your head agent to form a team.' : 'Groups appear when Orgo connects.'}</p>}
    {(snapshot?.approvals ?? []).map(approval => <div key={approval.request_id} className="my-2 rounded-lg border border-primary/30 p-2">
      <p className="text-xs font-semibold">{name(approval.agent)} needs approval</p>
      <p className="my-2 break-words text-xs">{approval.description || approval.command}</p>
      <details className="text-xs"><summary>Proposed action</summary><pre className="whitespace-pre-wrap">{approval.command}</pre></details>
      <div className="mt-2 flex gap-2">
        <Button size="sm" disabled={!connected || Boolean(deciding)} onClick={() => void decide(approval, 'once')}>Allow once</Button>
        <Button size="sm" variant="outline" disabled={!connected || Boolean(deciding)} onClick={() => void decide(approval, 'deny')}>Deny</Button>
      </div>
    </div>)}
    {error && !selected && !showAll && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {target && (selected || showAll) && createPortal(<section className="pointer-events-auto flex h-full min-h-0 flex-col bg-(--ui-chat-surface-background)" aria-label="Project conversation">
        <header className="flex shrink-0 items-center justify-between border-b border-(--ui-stroke-secondary) px-6 py-4">
          <div><h2 className="font-semibold">{selected?.title ?? 'Agent exchanges'}</h2>
          <p className="mt-1 text-xs text-(--ui-text-secondary)">{selected ? `${selected.members.length} teammates · Remote workspace` : 'Messages and verified execution records'}</p></div>
          <Button variant="ghost" size="sm" onClick={closeStudioConversation}>Back to agent</Button>
        </header>
        {selected && <div className="flex shrink-0 flex-wrap gap-1 border-b border-(--ui-stroke-secondary) px-5 py-2">{selected.members.map(member => {
          const agent = snapshot?.agents.find(a => a.name === member)
          return <Button key={member} variant="ghost" size="sm" disabled={!agent?.stored_id} onClick={() => { if (agent?.stored_id) void onOpenThread(member, agent.stored_id) }}>{name(member)}</Button>
        })}</div>}
        <div ref={scrollRef} onScroll={event => { const el = event.currentTarget; followLatest.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100 }} className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5" aria-live="polite">
          {!deliveries.length && <p className="text-sm text-(--ui-text-secondary)">No exchanges yet. Send the head agent a project to begin.</p>}
          {deliveries.map((d, index) => <article key={d.id} className="border-b border-(--ui-stroke-secondary) pb-4">
            <div className="flex items-center justify-between gap-3 text-xs text-(--ui-text-secondary)">
              <span>{name(d.sender)} → {name(d.recipient)}</span><span>{d.state === 'complete' ? 'Replied' : d.state.replaceAll('_', ' ')}</span>
            </div>
            <details className="mt-2 text-sm" open={d.body.length < 400}><summary className="cursor-pointer leading-6">{d.body.length > 400 ? d.body.slice(0, 220) + '…' : 'Message'}</summary><p className="mt-2 whitespace-pre-wrap leading-6">{d.body}</p></details>
            {d.result && (!d.response_id || !deliveries.slice(index + 1).some(other => other.response_id === d.response_id)) && <div className="mt-3 border-l-2 border-(--ui-stroke-secondary) pl-3">
              <p className="mb-1 text-xs font-semibold">{name(d.recipient)}</p><p className="whitespace-pre-wrap text-sm">{d.result}</p>
            </div>}
            <details className="mt-2 text-xs text-(--ui-text-secondary)"><summary className="cursor-pointer">Execution details</summary>
              <p className="mt-2 break-all">Delivery: {d.id}</p><p>Hermes session: {d.stored_id ?? 'Waiting to start'}</p>
              {d.stored_id && <Button variant="ghost" size="sm" onClick={() => { void onOpenThread(d.recipient, d.stored_id!); setSelected(null); setShowAll(false) }}>Open agent conversation</Button>}
              {['queued', 'running', 'starting'].includes(d.state) && <Button variant="ghost" size="sm" onClick={() => { void request('studio.operation', { operation:'cancel', request_id:d.id }).then(refresh).catch(e => setError(String(e))) }}>Cancel work</Button>}
            </details>
            {d.state === 'needs_review' && <div className="mt-3 rounded-lg border border-primary/30 p-3 text-xs">
              <p>Work was interrupted. Review the saved history before asking this agent to check completed actions and continue.</p>
              <Button size="sm" variant="outline" className="mt-2" disabled={!connected || Boolean(recovering)} onClick={() => void recover(d.id)}>Inspect saved work</Button>
              {recoveryEvidence[d.id] && <>
                <details open className="mt-2"><summary>Saved execution history</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(recoveryEvidence[d.id].history_tail, null, 2)}</pre></details>
                <details className="mt-2"><summary>Tool records ({recoveryEvidence[d.id].events.length})</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{JSON.stringify(recoveryEvidence[d.id].events, null, 2)}</pre></details>
                <Button size="sm" className="mt-2" disabled={!connected || Boolean(recovering)} onClick={() => void recover(d.id, true)}>Verify completed actions and resume</Button>
              </>}
            </div>}
          </article>)}
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <form className="m-5 flex shrink-0 gap-2 rounded-xl border border-(--ui-stroke-secondary) p-3" onSubmit={e => { e.preventDefault(); void send() }}>
          <Input aria-label="Message project group" value={message} onChange={e => setMessage(e.target.value)} placeholder="Message or redirect the project…" />
          <Button type="button" variant="outline" disabled={!connected || sending || !message.trim()} onClick={() => void send('redirect')}>Redirect</Button>
          <Button type="submit" disabled={!connected || sending || !message.trim()}>{sending ? 'Sending…' : 'Send'}</Button>
        </form>
      </section>, target)}
  </section>
}
