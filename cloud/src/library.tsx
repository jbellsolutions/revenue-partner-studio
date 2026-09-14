import { useEffect, useRef, useState, type ReactNode } from 'react'
import { api, rpc } from './api'
import { invalidateModels } from './model-catalog'

export function HermesLibrary({
  computer,
  name,
  computers,
  localSetup,
  fallback,
  agent = 'default'
}: {
  computer: string
  name: string
  computers: any[]
  localSetup: () => void
  fallback: ReactNode
  agent?: string
}) {
  const sources = computers.filter(c => c.id !== computer)
  const [source, setSource] = useState(
    sources.find(c => c.kind === 'local' && c.online)?.id || sources.find(c => c.kind === 'local')?.id || ''
  )
  const [mode, setMode] = useState<'skills' | 'profiles'>('skills'),
    [sourceProfile, setSourceProfile] = useState(''),
    [targetAgent, setTargetAgent] = useState(agent)
  const [skills, setSkills] = useState<any[]>([]),
    [selectedSkills, setSelectedSkills] = useState<string[]>([]),
    [search, setSearch] = useState(''),
    [targets, setTargets] = useState<any[]>([])
  const [profiles, setProfiles] = useState<any[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [jobs, setJobs] = useState<any[]>([])
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('')
  const live = useRef(true),
    sourceOnline = sources.find(c => c.id === source)?.online
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    let current = true
    setProfiles([])
    setChosen([])
    setSourceProfile('')
    setError('')
    if (source && sourceOnline)
      void rpc(source, 'library.profiles')
        .then(r => {
          if (current) {
            setProfiles(r.profiles)
            setSourceProfile(r.profiles[0]?.id || '')
          }
        })
        .catch(e => {
          if (current) setError(e.message)
        })
    return () => {
      current = false
    }
  }, [source, sourceOnline])
  useEffect(() => {
    let current = true
    void rpc(computer, 'agents.list')
      .then(r => {
        if (current) {
          setTargets(r.agents)
          setTargetAgent(old => (r.agents.some((a: any) => a.id === old) ? old : r.agents[0]?.id || ''))
        }
      })
      .catch(e => {
        if (current) setError(e.message)
      })
    return () => {
      current = false
    }
  }, [computer])
  useEffect(() => {
    let current = true
    setSkills([])
    setSelectedSkills([])
    setLoading(false)
    if (mode === 'skills' && source && sourceProfile && sourceOnline) {
      setLoading(true)
      void rpc(source, 'agents.describe', { agentId: sourceProfile })
        .then(r => {
          if (current) setSkills(r.skills)
        })
        .catch(e => {
          if (current) setError(e.message)
        })
        .finally(() => {
          if (current) setLoading(false)
        })
    }
    return () => {
      current = false
    }
  }, [mode, source, sourceProfile, sourceOnline])
  useEffect(() => {
    let current = true
    const poll = () =>
      api('/api/transfers')
        .then(r => {
          if (current) {
            setJobs(r.transfers.filter((j: any) => j.target === computer))
            if (r.transfers.some((j: any) => j.target === computer && j.state === 'complete'))
              invalidateModels(computer)
          }
        })
        .catch(e => {
          if (current) setError(e.message)
        })
    void poll()
    const timer = setInterval(() => void poll(), 2000)
    return () => {
      current = false
      clearInterval(timer)
    }
  }, [computer])
  async function action(route: string, body: any) {
    setBusy(true)
    setError('')
    try {
      await api(route, body)
      const r = await api('/api/transfers')
      if (live.current) setJobs(r.transfers.filter((j: any) => j.target === computer))
    } catch (e) {
      if (live.current) setError((e as Error).message)
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <>
      <h2>Bring your Hermes with you</h2>
      <p>
        Copy to <strong>{name}</strong>. Your Mac and other computers keep their own independent copies.
      </p>
      <div className="import-explanation">
        Choose what to bring, review the changes, then approve the copy. Nothing syncs automatically. Credentials stay
        separate.
      </div>
      {!sources.some(c => c.kind === 'local') && (
        <div className="connection-card">
          <strong>Start with Hermes on your Mac</strong>
          <p className="small-note">
            The Mac companion finds your Hermes installation and profiles. No folder paths to type.
          </p>
          <button onClick={localSetup}>Connect local Hermes</button>
        </div>
      )}
      <div className="settings-tabs" role="group" aria-label="What to import">
        <button aria-pressed={mode === 'skills'} onClick={() => setMode('skills')}>
          Selected skills
        </button>
        <button aria-pressed={mode === 'profiles'} onClick={() => setMode('profiles')}>
          Complete profiles
        </button>
      </div>
      <label>
        1. Copy from
        <select value={source} onChange={e => setSource(e.target.value)}>
          <option value="">Choose a computer</option>
          {sources.map(c => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.online ? '' : ' — offline'}
            </option>
          ))}
        </select>
      </label>
      {source && !sourceOnline && (
        <p role="status" className="small-note">
          This source is offline. Wake the Mac and open its companion to browse Hermes. Approved transfers resume when
          it reconnects.
        </p>
      )}
      {mode === 'skills' ? (
        <>
          <label>
            Source Hermes profile
            <select value={sourceProfile} onChange={e => setSourceProfile(e.target.value)}>
              <option value="">Choose a profile</option>
              {profiles.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            2. Add skills to
            <select value={targetAgent} onChange={e => setTargetAgent(e.target.value)}>
              {targets.map(a => (
                <option key={a.id} value={a.id}>
                  {a.name} · {name}
                </option>
              ))}
            </select>
          </label>
          <p className="small-note">This agent keeps its identity, memory, history, settings and subscriptions.</p>
          <label>
            3. Choose skills
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search local Hermes skills" />
          </label>
          {loading ? (
            <p role="status">Finding skills in this profile…</p>
          ) : (
            <div className="profile-selection">
              {skills
                .filter(s => (s.name + ' ' + s.id).toLowerCase().includes(search.toLowerCase()))
                .map(s => (
                  <label className="checkbox-row" key={s.id}>
                    <input
                      type="checkbox"
                      checked={selectedSkills.includes(s.id)}
                      onChange={e =>
                        setSelectedSkills(v => (e.target.checked ? [...v, s.id] : v.filter(x => x !== s.id)))
                      }
                    />
                    <span>
                      {s.name}
                      <small className="small-note">
                        {' '}
                        · {s.id}
                        {s.enabled ? '' : ' · disabled at source'}
                      </small>
                    </span>
                  </label>
                ))}
              {sourceProfile && !skills.length && (
                <p className="small-note">
                  No installed skills were found in this profile. Try another profile or import a complete profile.
                </p>
              )}
            </div>
          )}
          <button
            className="primary"
            disabled={busy || loading || !sourceOnline || !selectedSkills.length || !targetAgent}
            onClick={() =>
              void action('/api/transfers', {
                source,
                target: computer,
                profiles: [sourceProfile],
                scope: 'skills',
                sourceProfile,
                skillIds: selectedSkills,
                targetAgent
              })
            }
          >
            Review {selectedSkills.length || ''} selected skills
          </button>
        </>
      ) : (
        <>
          <p className="small-note">
            Complete profiles include skills, instructions, memory, compatible settings and history. First imports
            create independent agents; later imports update those copies after review.
          </p>
          <div className="profile-selection">
            {profiles.map(p => (
              <label className="checkbox-row" key={p.id}>
                <input
                  type="checkbox"
                  checked={chosen.includes(p.id)}
                  onChange={e => setChosen(v => (e.target.checked ? [...v, p.id] : v.filter(x => x !== p.id)))}
                />
                <span>{p.name}</span>
              </label>
            ))}
          </div>
          <button
            className="primary"
            disabled={busy || !sourceOnline || !chosen.length}
            onClick={() => void action('/api/transfers', { source, target: computer, profiles: chosen })}
          >
            {busy ? 'Preparing…' : 'Review selected profiles'}
          </button>
        </>
      )}
      {jobs.map(j => (
        <section className="connection-card" key={j.id}>
          <strong>
            {j.state === 'review'
              ? 'Ready to review'
              : j.state === 'complete'
                ? 'Import complete'
                : j.selection?.scope === 'skills'
                  ? 'Skill transfer'
                  : 'Profile transfer'}
          </strong>
          <p className="small-note">
            {computers.find(c => c.id === j.source)?.name || 'Source computer'} → {name}
            {j.selection?.targetAgent
              ? ` · ${targets.find(a => a.id === j.selection.targetAgent)?.name || j.selection.targetAgent}`
              : ''}
          </p>
          <p role="status">{j.detail}</p>
          {j.total > 0 && j.state === 'copying' && <progress max={j.total} value={j.offset} />}
          {j.preview && j.state === 'review' && (
            <>
              {j.preview.profiles.map((p: any) => (
                <p className="small-note" key={p.source}>
                  <strong>{p.source}</strong>: {p.newProfile ? 'new independent profile; ' : ''}
                  {p.added} additions, {p.changed} updates, {p.conflicts} conflicts. Conflicts keep both versions.
                </p>
              ))}
              {j.preview.warnings.map((w: string, i: number) => (
                <p className="small-note" key={i}>
                  {w}
                </p>
              ))}
              <button
                className="primary"
                disabled={busy}
                onClick={() => void action('/api/transfers/apply', { id: j.id })}
              >
                Apply reviewed changes to {name}
              </button>
            </>
          )}
          {['failed', 'waiting'].includes(j.state) && (
            <button disabled={busy} onClick={() => void action('/api/transfers/retry', { id: j.id })}>
              Retry transfer
            </button>
          )}
        </section>
      ))}
      {error && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
      <details className="connection-card">
        <summary>Or click / drop a Hermes export</summary>
        {fallback}
      </details>
    </>
  )
}
