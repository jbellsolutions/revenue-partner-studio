import { useEffect, useState } from 'react'
import { rpc } from './api'
export function Delegations({ computer, agent, tasks, peerRevision, online, computers, openAgent, reviewTrust }: {
  computer: string; agent: string; tasks: any[]; peerRevision: number; online: boolean;
  computers: { id: string; name: string }[];
  openAgent: (computer: string, agent: string, session?: string) => void; reviewTrust: () => void
}) {
  const [peers, setPeers] = useState<any[]>([])
  useEffect(() => {
    let active = true
    if (online) void rpc(computer, 'peer.status', { agentId: agent }).then(r => active && setPeers(r.tasks || [])).catch(() => {})
    return () => { active = false }
  }, [computer, agent, peerRevision, online])
  const local = tasks.filter(t => t.sender === agent && t.recipient !== agent && t.sender !== 'user')
  if (!peers.length && !local.length) return null
  const label = (state: string) => ({ queued: 'Accepted · queued', working: 'Working', running: 'Working', starting: 'Starting',
    complete: 'Completed', error: 'Needs attention', needs_review: 'Review needed', cancelled: 'Cancelled' })[state] || state
  return <section className="delegation-feed" aria-label="Delegated work">
    <h3>This agent’s recent handoffs</h3>
    {local.slice(0, 6).map(t => <article key={t.id}>
      <button onClick={() => openAgent(computer, t.recipient, t.stored_id)}>{t.recipient.replaceAll('-', ' ')} ↗</button>
      <span>{label(t.state)}</span>
      <p>{t.body?.slice(0, 180)}</p>
      {t.result && <details><summary>Result</summary><p>{t.result}</p></details>}
    </article>)}
    {peers.slice(0, 6).map(t => <article key={'peer-' + t.id}>
      <button onClick={() => openAgent(t.computerId, t.agentId)}>{t.agentId.replaceAll('-', ' ')} ↗</button>
      <small>{computers.find(c => c.id === t.computerId)?.name || 'Connected computer'}</small>
      <span>{t.error?.startsWith('TRUST_REQUIRED:') ? 'Permission needed' : label(t.state)}</span>
      {t.error?.startsWith('TRUST_REQUIRED:') ? <button onClick={reviewTrust}>Review trusted connection</button> : t.error && <p role="alert">{t.error}</p>}
      {t.task?.status?.message?.parts?.filter((p: any) => p.kind === 'text').map((p: any, i: number) => <p key={i}>{p.text}</p>)}
    </article>)}
  </section>
}
