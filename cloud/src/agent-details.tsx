import { useEffect, useRef, useState } from 'react'
import { rpc } from './api'
import { ProviderKeys } from './provider-keys'
import { hermesAdapter } from './hermes-adapter'
type Document = { kind: string; text: string; version: string }
export function AgentDetails({
  computer,
  agent,
  name,
  computerName,
  close
}: {
  computer: string
  agent: string
  name: string
  computerName: string
  close: () => void
}) {
  const [data, setData] = useState<any>(null),
    [tab, setTab] = useState('instructions'),
    [docs, setDocs] = useState<Record<string, Document>>({}),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  const [skillSearch, setSkillSearch] = useState('')
  const root = useRef<HTMLElement>(null),
    active = useRef(true)
  async function load() {
    setNotice('')
    setBusy(true)
    try {
      const result = await rpc(computer, 'agents.describe', { agentId: agent })
      if (active.current) {
        setData(result)
        setDocs(Object.fromEntries(result.documents.map((d: Document) => [d.kind, d])))
      }
    } catch (e) {
      if (active.current) setNotice((e as Error).message)
    } finally {
      if (active.current) setBusy(false)
    }
  }
  useEffect(() => {
    active.current = true
    void load()
    const previous = document.activeElement as HTMLElement | null
    root.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
      if (e.key === 'Tab') {
        const nodes = Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]'
          ) || []
        )
        const first = nodes[0],
          last = nodes[nodes.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === root.current)) {
          e.preventDefault()
          last?.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      active.current = false
      document.removeEventListener('keydown', key)
      previous?.focus()
    }
  }, [])
  async function save(kind: string) {
    setBusy(true)
    setNotice('')
    try {
      const result = await rpc(computer, 'agents.update', { agentId: agent, ...docs[kind] })
      if (active.current) {
        setDocs(d => ({ ...d, [kind]: result }))
        setNotice('Saved. This agent will use the changes on its next turn.')
      }
    } catch (e) {
      if (active.current) setNotice((e as Error).message)
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const editor = (kind: string, label: string) =>
    docs[kind] && (
      <section className="document-editor" key={kind}>
        <label>
          {label}
          <textarea
            value={docs[kind].text}
            disabled={busy || data?.busy}
            onChange={e => setDocs(d => ({ ...d, [kind]: { ...d[kind], text: e.target.value } }))}
          />
        </label>
        <button className="primary" disabled={busy || data?.busy} onClick={() => void save(kind)}>
          Save {label.toLowerCase()}
        </button>
      </section>
    )
  return (
    <div className="drawer-backdrop" onMouseDown={e => e.target === e.currentTarget && close()}>
      <section
        className="agent-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Agent details"
        ref={root}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2>{name}</h2>
            <p>{computerName}</p>
          </div>
          <button onClick={close} aria-label="Close agent details">
            ×
          </button>
        </header>
        <nav aria-label="Agent details sections">
          {['instructions', 'skills', 'memory', 'connections'].map(t => (
            <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
        <div className="drawer-body">
          {busy && !data && <p>Loading agent details…</p>}
          {data?.busy && (
            <p className="small-note">This agent is working. You can browse now and edit after it finishes.</p>
          )}
          {tab === 'instructions' && editor('instructions', 'Instructions')}
          {tab === 'memory' && (
            <>
              {editor('memory', 'Agent memory')}
              {editor('user', 'User notes')}
            </>
          )}
          {tab === 'skills' && (
            <>
              <h3>Installed skills</h3>
              <p className="small-note">Available on this agent’s computer. Existing permissions are preserved.</p>
              <label>Find a skill<input value={skillSearch} onChange={e => setSkillSearch(e.target.value)} placeholder="Search installed skills" /></label>
              <div className="skill-list">
                {data?.skills.filter((s: any) => s.id.toLowerCase().includes(skillSearch.toLowerCase())).map((s: any) => (
                  <div key={s.id}>
                    <strong>{s.name}</strong>
                    <button type="button" aria-pressed={s.enabled} disabled={busy || data.busy} onClick={async () => {
                      setBusy(true); setNotice('')
                      try { await hermesAdapter(computer, agent).skill(s.id, !s.enabled); await load() }
                      catch (e) { if (active.current) setNotice((e as Error).message) }
                      finally { if (active.current) setBusy(false) }
                    }}>{s.enabled ? 'Enabled · Disable' : 'Disabled · Enable'}</button>
                  </div>
                ))}
              </div>
              {data && !data.skills.length && <p>No skills installed for this profile.</p>}
            </>
          )}
          {tab === 'connections' && (
            <>
              <ProviderKeys key={computer + agent} computer={computer} agent={agent} />
              <h3>Tool connections</h3>
              <div className="connection-rows">
                {data?.connections.map((c: any) => (
                  <div key={c.name}>
                    <strong>{c.name}</strong>
                    <span>{c.status}</span>
                    <small>{c.message}</small>
                  </div>
                ))}
              </div>
              {data && !data.connections.length && (
                <p className="small-note">No profile-specific tool connections configured.</p>
              )}
            </>
          )}
          {notice && (
            <p role="status" className="notice">
              {notice}
            </p>
          )}
        </div>
        <footer>
          <small>Saved on {computerName}</small>
          <button disabled={busy} onClick={() => void load()}>
            Reload saved details
          </button>
        </footer>
      </section>
    </div>
  )
}
