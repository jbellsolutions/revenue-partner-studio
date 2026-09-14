import { useEffect, useRef, useState } from 'react'
import { hermesAdapter } from './hermes-adapter'
import { modelCatalog, type ModelProvider, type ModelSelection } from './model-catalog'
import { modelSearchText } from '../../apps/desktop/src/lib/model-search-text'

export function ModelPicker({
  computer,
  agent,
  runtime,
  model,
  provider,
  online = true,
  readOnly = false,
  selection,
  changed,
  close,
  connections
}: {
  computer: string
  agent: string
  runtime: string
  model: string
  provider: string
  online?: boolean
  readOnly?: boolean
  selection?: ModelSelection
  changed: (value: ModelSelection) => void
  close?: () => void
  connections?: () => void
}) {
  const [providers, setProviders] = useState<ModelProvider[]>([]),
    [search, setSearch] = useState('')
  const [choice, setChoice] = useState(provider || 'openrouter'),
    [manual, setManual] = useState(model)
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(true)
  const active = useRef(true),
    generation = useRef(0),
    panel = useRef<HTMLElement>(null),
    input = useRef<HTMLInputElement>(null)
  const adapter = hermesAdapter(computer, agent, runtime)
  async function load(refresh = false) {
    const version = ++generation.current
    setLoading(true)
    setNotice('')
    try {
      const r = await modelCatalog(computer, agent, refresh)
      if (active.current && version === generation.current) setProviders(r)
    } catch (e) {
      if (active.current && version === generation.current) setNotice((e as Error).message)
    } finally {
      if (active.current && version === generation.current) setLoading(false)
    }
  }
  useEffect(() => {
    active.current = true
    if (online) void load()
    else setLoading(false)
    return () => {
      active.current = false
      generation.current++
    }
  }, [computer, agent, online])
  useEffect(() => {
    if (!close) return
    const previous = document.activeElement as HTMLElement | null
    input.current?.focus()
    const outside = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('[aria-haspopup="dialog"]'))
        close()
    }
    document.addEventListener('pointerdown', outside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      if (previous?.isConnected) previous.focus()
    }
  }, [close])
  async function select(p: string, m: string) {
    setBusy(true)
    setNotice('')
    try {
      const r = await adapter.selectModel(p, m)
      if (active.current) {
        const value: ModelSelection = {
          ...r,
          model: r.model || m,
          provider: r.provider || p,
          state: r.state || 'applied'
        }
        changed(value)
        setChoice(p)
        setManual(m)
        if (value.state === 'pending') setNotice('Selected for the next turn. Your current work will finish first.')
        else if (value.state === 'error') setNotice(value.error || 'Choose a model again to continue.')
        else {
          setNotice('Model ready. Your conversation is retained.')
          close?.()
        }
      }
    } catch (e) {
      if (active.current) {
        setNotice((e as Error).message)
        if ((e as Error).message.includes('selected model could not be activated'))
          changed({
            model: m,
            provider: p,
            state: 'error',
            activeModel: model,
            activeProvider: provider,
            error: (e as Error).message
          })
        // Read back durable state: a failed activation must block a next turn,
        // while an invalid manual ID must not poison a working conversation.
        try {
          const value = await adapter.modelStatus()
          if (active.current && value.state) changed(value)
        } catch {
          /* Original actionable error stays visible. */
        }
      }
    } finally {
      if (active.current) setBusy(false)
    }
  }
  const reason = !online
    ? 'This computer is offline. Connect it to choose a model.'
    : readOnly
      ? 'This imported history is read-only. Open a new conversation to choose a model.'
      : !runtime
        ? 'Opening this conversation…'
        : ''
  const choices = Array.from(
    new Map(
      [
        { slug: provider, name: provider },
        { slug: 'openrouter', name: 'OpenRouter' },
        { slug: 'openai-codex', name: 'ChatGPT / Codex' },
        { slug: 'anthropic', name: 'Claude' },
        ...providers
      ]
        .filter(p => p.slug)
        .map(p => [p.slug, p])
    ).values()
  )
  const connected = providers.filter(p => p.authenticated !== false)
  const visible = connected
    .map(p => ({
      ...p,
      models: p.models.filter(m => (p.name + ' ' + modelSearchText(m)).toLowerCase().includes(search.toLowerCase()))
    }))
    .filter(p => p.models.length)
  return (
    <section
      ref={panel}
      className={'model-picker' + (close ? ' model-popover' : '')}
      role={close ? 'dialog' : undefined}
      aria-label="Conversation model"
      onKeyDown={e => {
        if (e.key === 'Escape' && close) {
          e.stopPropagation()
          close()
        }
        if (e.key === 'Enter') e.stopPropagation()
        if (e.key === 'Tab' && close) {
          const items = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), select:not(:disabled), summary'
            ) || []
          ).filter(el => el.getClientRects().length)
          const first = items[0],
            last = items.at(-1)
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault()
            last?.focus()
          }
          if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault()
            first?.focus()
          }
        }
      }}
    >
      <div className="model-heading">
        <h3>Conversation model</h3>
        {close && (
          <button type="button" aria-label="Close model picker" onClick={close}>
            ×
          </button>
        )}
      </div>
      <p className="small-note">
        Active: {model || 'Profile model'}
        {provider ? ` · ${provider}` : ''}
      </p>
      {selection?.state === 'pending' && (
        <p role="status" className="small-note">
          Next turn: {selection.model}
        </p>
      )}
      {selection?.state === 'error' && (
        <p role="alert" className="connection-error">
          {selection.error}
        </p>
      )}
      {reason && (
        <p role="status" className="small-note">
          {reason}
        </p>
      )}
      <label>
        Search models
        <input
          ref={input}
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') e.preventDefault()
          }}
          placeholder="OpenRouter, Claude, GPT…"
        />
      </label>
      {loading && <p role="status">Loading this profile’s models…</p>}
      <div className="model-results">
        {visible.map(p => (
          <section key={p.slug}>
            <h4>{p.name}</h4>
            {p.models.slice(0, 80).map(m => (
              <button
                type="button"
                key={m}
                disabled={busy || !!reason}
                aria-pressed={m === model && p.slug === provider}
                onClick={() => void select(p.slug, m)}
              >
                {m}
                {m === model && p.slug === provider ? ' ✓' : ''}
              </button>
            ))}
            {p.models.length > 80 && <p className="small-note">Narrow your search to see more models.</p>}
          </section>
        ))}
      </div>
      {!loading && !visible.length && (
        <p className="small-note">
          {search
            ? 'No matching models. You can enter an exact model ID below.'
            : 'No connected model catalog yet. Connect a provider or enter your model ID.'}
        </p>
      )}
      <details>
        <summary>Enter a model ID</summary>
        <label>
          Provider
          <select value={choice} onChange={e => setChoice(e.target.value)}>
            {choices.map(p => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model ID
          <input
            value={manual}
            onChange={e => setManual(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (!busy && !reason && manual.trim()) void select(choice, manual.trim())
              }
            }}
            placeholder="provider/model-name"
          />
        </label>
        <button
          type="button"
          disabled={busy || !!reason || !manual.trim()}
          onClick={() => void select(choice, manual.trim())}
        >
          Use in this conversation
        </button>
      </details>
      <div className="model-footer">
        <button type="button" disabled={loading || busy || !online} onClick={() => void load(true)}>
          Refresh models
        </button>
        {connections && (
          <button type="button" onClick={connections}>
            Provider connections ↗
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="small-note">
          {notice}
        </p>
      )}
    </section>
  )
}
