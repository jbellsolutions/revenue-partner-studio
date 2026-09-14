import { useEffect, useState } from 'react'
import { rpc } from './api'

export function Endpoints({ computer, agent }: { computer: string; agent: string }) {
  const [rows, setRows] = useState<any[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  useEffect(() => { let active = true; void rpc(computer, 'endpoints.list', { agentId: agent }).then(r => active && setRows(r.endpoints)).catch(e => active && setError(e.message)); return () => { active = false } }, [])
  return <section><h3>Custom endpoints</h3><p className="small-note">Use an existing OpenAI-compatible endpoint on this computer. Hermes keeps its configuration with this profile.</p>
    {rows.map((r, i) => <p key={i}><strong>{r.name}</strong> · {r.model || 'Configured in Hermes'}</p>)}
    <form onSubmit={async e => {
      e.preventDefault(); const form = e.currentTarget; const values = Object.fromEntries(new FormData(form)); setBusy(true); setError('')
      try { const r = await rpc(computer, 'endpoints.configure', { ...values, agentId: agent }); setRows(r.endpoints); setError(r.message); form.reset() }
      catch (e) { setError((e as Error).message) } finally { setBusy(false) }
    }}>
      <label>Name<input name="name" required maxLength={64} /></label>
      <label>Endpoint URL<input type="url" name="baseUrl" required placeholder="http://localhost:11434/v1" /></label>
      <label>Model ID<input name="model" required /></label>
      <label>API key, if required<input type="password" name="apiKey" autoComplete="off" /></label>
      <button disabled={busy} className="primary">Save endpoint</button>
    </form>{error && <p role="status">{error}</p>}
  </section>
}
