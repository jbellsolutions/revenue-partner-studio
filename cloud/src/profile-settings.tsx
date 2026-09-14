import { useEffect, useState } from 'react'
import { rpc } from './api'
type Settings = { version: string; values: Record<string, any>; efforts: string[]; toolsets: string[]; busy: boolean }
export function ProfileSettings({ computer, agent, supported, screens = false }: { computer: string; agent: string; supported: boolean; screens?: boolean }) {
  const [data, setData] = useState<Settings | null>(null)
  const [changes, setChanges] = useState<Record<string, any>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [capacity, setCapacity] = useState<any>(null)
  useEffect(() => { let active = true; if (screens) void rpc(computer, 'screen.status', { agentId: agent }).then(r => active && setCapacity(r.capacity)).catch(() => {}); return () => { active = false } }, [computer, agent, screens])
  useEffect(() => {
    let active = true
    if (supported) void rpc(computer, 'profile.settings.get', { agentId: agent }).then(r => {
      if (active) { setData(r); setChanges({}); setError('') }
    }).catch(e => active && setError(e.message))
    return () => { active = false }
  }, [computer, agent, supported, revision])
  if (!supported) return <p>This computer needs the compatible Studio extension before advanced settings can be edited. Your existing Hermes settings remain intact.</p>
  const values = { ...data?.values, ...changes }
  async function save() {
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await rpc(computer, 'profile.settings.update', { agentId: agent, version: data?.version, changes })
      setData(result); setChanges({}); setNotice('Saved for this profile. Changes apply before its next turn.')
    } catch (e) { setError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <section className="profile-settings">
    <h3>Agent settings</h3>
    <p className="small-note">These controls belong to the selected agent. Model support determines the available reasoning behavior.</p>
    {data && <fieldset disabled={busy || data.busy}>
      <label>Maximum tool turns<input type="number" min={1} max={1000} value={values['agent.max_turns']}
        onChange={e => setChanges(c => ({ ...c, 'agent.max_turns': Number(e.target.value) }))} /></label>
      <label>Reasoning effort<select value={values['agent.reasoning_effort'] === false ? 'none' : values['agent.reasoning_effort']}
        onChange={e => setChanges(c => ({ ...c, 'agent.reasoning_effort': e.target.value }))}>
        {data.efforts.map(e => <option key={e} value={e}>{e}</option>)}
      </select></label>
      <details><summary>Tool permissions</summary><p className="small-note">Restrict toolsets for this agent. Enabling a toolset here removes its restriction; it does not grant a new account or a trusted connection.</p>
        {data.toolsets.map(name => <label className="tool-permission" key={name}>
          <input type="checkbox" checked={!values['agent.disabled_toolsets'].includes(name)} onChange={e => {
            const disabled = values['agent.disabled_toolsets'].filter((v: string) => v !== name)
            setChanges(c => ({ ...c, 'agent.disabled_toolsets': e.target.checked ? disabled : [...disabled, name] }))
          }} />{name.replaceAll('_', ' ')}
        </label>)}
      </details>
      <button className="primary" disabled={!Object.keys(changes).length} onClick={() => void save()}>{busy ? 'Saving…' : 'Save agent settings'}</button>
    </fieldset>}
    {capacity && <label>Specialist screens on this computer<select disabled={busy} value={capacity.specialists} onChange={async e => {
      setBusy(true); setError('')
      try { const r = await rpc(computer, 'screen.capacity', { agentId: agent, specialists: Number(e.target.value) }); setCapacity(r.capacity) }
      catch(e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>{Array.from({ length: capacity.qualified }, (_, n) => n + 1).map(n => <option key={n} value={n}>{n}</option>)}</select>
      <span className="small-note">{capacity.qualified} specialist slots {capacity.qualification === 'host_verified' ? 'verified on this computer' : 'in the current baseline; live qualification is pending'}, plus the head operator’s screen. Existing work keeps its assignment when this limit is lowered.</span>
    </label>}
    {data?.busy && <p>This agent is working. Refresh after its turn to edit settings.</p>}
    {(error || data?.busy) && <button disabled={busy} onClick={() => setRevision(v => v + 1)}>Reload settings</button>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>
}
