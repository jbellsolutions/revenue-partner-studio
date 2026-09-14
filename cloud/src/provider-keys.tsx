import { useEffect, useState } from 'react'
import { rpc } from './api'
import { hermesAdapter } from './hermes-adapter'

export function ProviderKeys({ computer, agent }: { computer: string; agent: string }) {
  const [rows, setRows] = useState<any[]>([]),
    [provider, setProvider] = useState('openrouter'),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('')
  useEffect(() => {
    let active = true
    void rpc(computer, 'providers.keys', { agentId: agent })
      .then(r => active && setRows(r.keys))
      .catch(e => active && setNotice(e.message))
    return () => {
      active = false
    }
  }, [computer, agent])
  async function act(save: boolean) {
    setBusy(true)
    setNotice('')
    try {
      const adapter = hermesAdapter(computer, agent)
      const result = save
        ? await adapter.saveAndCheck(provider, key, () => setKey(''))
        : await adapter.checkKey(provider)
      setNotice(result.message)
      const refreshed = await rpc(computer, 'providers.keys', { agentId: agent })
      setRows(refreshed.keys)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="provider-keys">
      <h3>API keys</h3>
      <p className="small-note">
        Keys belong to this agent on this computer. Your subscription sign-ins stay separate.
      </p>
      <div className="connection-rows">
        {rows.map(row => (
          <div key={row.id}>
            <strong>{row.name}</strong>
            <span>{row.status?.replaceAll('_', ' ')}</span>
            <small>
              {row.source === 'computer'
                ? 'Using the computer’s existing key'
                : row.source === 'profile'
                  ? 'This agent’s key'
                  : 'No key configured'}
            </small>
          </div>
        ))}
      </div>
      <form
        onSubmit={e => {
          e.preventDefault()
          void act(true)
        }}
      >
        <label>
          Provider
          <select
            value={provider}
            disabled={busy}
            onChange={e => {
              setProvider(e.target.value)
              setKey('')
              setNotice('')
            }}
          >
            <option value="openrouter">OpenRouter</option>
            <option value="anthropic">Anthropic API</option>
          </select>
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            value={key}
            disabled={busy}
            onChange={e => setKey(e.target.value)}
            placeholder="Enter a key to add or replace it"
          />
        </label>
        <div className="drawer-actions">
          <button className="primary" disabled={busy || !key.trim()}>
            {busy ? 'Checking…' : 'Save and check'}
          </button>
          <button type="button" disabled={busy || !!key.trim()} onClick={() => void act(false)}>
            Test saved key
          </button>
        </div>
      </form>
      <p className="small-note">Authentication checks do not send a chat message. Model availability appears in the model picker; tool access is verified by running a task.</p>
      {notice && (
        <p role="status" className="small-note">
          {notice}
        </p>
      )}
    </section>
  )
}
