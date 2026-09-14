import { useEffect, useRef, useState } from 'react'
import { hermesAdapter } from './hermes-adapter'
import { modelSearchText } from '../../apps/desktop/src/lib/model-search-text'

// Adapted from the inherited desktop ModelPickerDialog: preserve Hermes's
// curated order, search aliases and exact wire IDs; load only when opened.
export function ModelPicker({ computer, agent, runtime, model, provider, changed }: {
  computer: string; agent: string; runtime: string; model: string; provider: string
  changed: (value: { model: string; provider: string }) => void
}) {
  const [providers, setProviders] = useState<any[]>([]), [search, setSearch] = useState('')
  const [choice, setChoice] = useState(provider || 'openrouter'), [manual, setManual] = useState(model)
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true)
  const active = useRef(true)
  const adapter = hermesAdapter(computer, agent, runtime)
  async function load(refresh = false) {
    setLoading(true)
    try { const r = await adapter.models(refresh); if (active.current) setProviders(r.providers || []) }
    catch (e) { if (active.current) setNotice((e as Error).message) }
    finally { if (active.current) setLoading(false) }
  }
  useEffect(() => { active.current = true; void load(); return () => { active.current = false } }, [])
  async function select(p: string, m: string) {
    setBusy(true); setNotice('')
    try {
      const r = await adapter.selectModel(p, m)
      if (active.current) {
        changed({ model: m, provider: p }); setChoice(p); setManual(m)
        setNotice(r.state === 'pending' ? 'Selected for the next turn. Your current work will finish first.' : 'Model ready in this conversation. Your history is retained.')
      }
    } catch (e) { if (active.current) setNotice((e as Error).message) }
    finally { if (active.current) setBusy(false) }
  }
  const choices = Array.from(new Map([{ slug: provider, name: provider },
    { slug: 'openrouter', name: 'OpenRouter' }, { slug: 'openai-codex', name: 'ChatGPT / Codex' },
    { slug: 'anthropic', name: 'Claude' }, ...providers].filter(p => p.slug).map(p => [p.slug, p])).values())
  return <section className="model-picker">
    <h3>Conversation model</h3>
    <p className="small-note">Choose a model for this conversation. Subscription sign-ins and API keys are managed below.</p>
    <label>Search Hermes models<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search OpenRouter, Claude, GPT…" /></label>
    {loading && <p role="status">Loading this profile’s Hermes model catalog…</p>}
    <div className="model-results">
      {providers.map(p => {
        const models = (p.models || []).filter((m: string) => (p.name + ' ' + modelSearchText(m)).toLowerCase().includes(search.toLowerCase()))
        return models.length > 0 && <section key={p.slug}><h4>{p.name}{p.authenticated === false ? ' · Connection needed' : ''}</h4>
          {models.slice(0, 80).map((m: string) => <button type="button" key={m} disabled={busy || !runtime} aria-pressed={m === model && p.slug === provider} onClick={() => void select(p.slug, m)}>{m}{m === model && p.slug === provider ? ' ✓' : ''}</button>)}
          {models.length > 80 && <p className="small-note">Narrow your search to see more models.</p>}
        </section>
      })}
    </div>
    <details open={!providers.length}><summary>Enter a model ID</summary>
      <label>Provider<select value={choice} onChange={e => setChoice(e.target.value)}>{choices.map(p => <option key={p.slug} value={p.slug}>{p.name}</option>)}</select></label>
      <label>Model ID<input value={manual} onChange={e => setManual(e.target.value)} placeholder="provider/model-name" /></label>
      <button type="button" disabled={busy || !runtime || !manual.trim()} onClick={() => void select(choice, manual.trim())}>Use in this conversation</button>
    </details>
    <button type="button" disabled={loading || busy} onClick={() => void load(true)}>Refresh models</button>
    {notice && <p role="status" className="small-note">{notice}</p>}
  </section>
}
