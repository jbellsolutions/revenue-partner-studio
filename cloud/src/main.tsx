import BRAND from '../../brand/product.json'
import { LocalSetup } from './local'
import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Streamdown } from 'streamdown'
import { api, rpc } from './api'
import { ComputerManager } from './computers'
import { HermesLibrary } from './library'
import { Explorer } from './explorer'
import { TrustedConnections } from './grants'
import { prepareImport } from './import'
import {
  blankConversation,
  blankSpace,
  reduceEvent,
  selectedKey,
  currentConversation,
  restoreSpaces,
  saveSpaces,
  type Space,
  type Conversation,
  type Agent
} from './state'
import { Screen } from './screen'
import { TaskActions } from './task-actions'
import { ConversationFiles } from './conversation-files'
const AgentDetails = lazy(() => import('./agent-details').then(m => ({ default: m.AgentDetails })))
const ModelPicker = lazy(() => import('./model-picker').then(m => ({ default: m.ModelPicker })))
const Endpoints = lazy(() => import('./endpoints').then(m => ({ default: m.Endpoints })))
import { ProviderKeys } from './provider-keys'
import { ACCEPT, checkFiles, uploadAttachment, type Attachment } from './attachments'
import '../../apps/desktop/src/app/bot-product/shell.css'
import './style.css'

type Computer = { id: string; name: string; online: boolean; kind?: string }
const initials = (name: string) =>
  name
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(x => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
const title = (agent: Agent) => agent.name === 'default' ? 'Head of Operations' : agent.name.replace(/^imported-/, '').replace(/-[a-f0-9]{10}$/, '').replace(/[-_]/g, ' ')
const isTestAgent = (agent: Agent) => /(?:^|[-_ ])studio[-_ ]qa(?:[-_ ]|$)/i.test(agent.id + ' ' + agent.name)
function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [password, setPassword] = useState(''),
    [loginError, setLoginError] = useState('')
  const [computers, setComputers] = useState<Computer[]>([]),
    [computer, setComputer] = useState(localStorage.getItem('studio.computer') || '')
  const [spaces, setSpaces] = useState<Record<string, Space>>(restoreSpaces),
    [search, setSearch] = useState(''),
    [modal, setModal] = useState(''),
    [notice, setNotice] = useState('')
  const [names, setNames] = useState<any[]>([]),
    [historyOffset, setHistoryOffset] = useState<number | null>(null),
    [archiveOffset, setArchiveOffset] = useState<number | null>(null),
    [historyLoading, setHistoryLoading] = useState(false),
    [agentName, setAgentName] = useState(''),
    [role, setRole] = useState(''),
    [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState<any>(null),
    [flow, setFlow] = useState<any>(null)
  const [details, setDetails] = useState(false)
  const [showTests, setShowTests] = useState(false), [settingsTab, setSettingsTab] = useState('accounts')
  const [pendingImport,setPendingImport]=useState<any>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const uploads = useRef<Record<string, File>>({})
  const sending = useRef(new Set<string>())
  const spacesRef = useRef(spaces)
  spacesRef.current = spaces
  const generations = useRef<Record<string, number>>({}),
    bottom = useRef<HTMLDivElement>(null),
    composer = useRef<HTMLTextAreaElement>(null)
  const space = spaces[computer] || blankSpace(),
    agent = space.agents.find(a => a.id === space.agentId),
    conversation = currentConversation(space, space.agentId),
    conversationKey = selectedKey(space, space.agentId)
  const selected = computers.find(c => c.id === computer)
  const selectionRef = useRef('')
  selectionRef.current = computer + ':' + space.agentId
  const [limits, setLimits] = useState({ maxConcurrent: 4, maxPeerHops: 5 })
  useEffect(() => {
    setModal('')
    setDetails(false)
    setFlow(null)
    setProviders(null)
    setNames([])
    setNotice('')
  }, [computer, space.agentId])
  const update = useCallback(
    (id: string, fn: (s: Space) => Space) => setSpaces(all => ({ ...all, [id]: fn(all[id] || blankSpace()) })),
    []
  )
  const updateChat = useCallback(
    (id: string, aid: string, fn: (c: Conversation) => Conversation, key?: string) =>
      update(id, s => {
        const target = key || selectedKey(s, aid)
        return {
          ...s,
          conversations: { ...s.conversations, [target]: fn(s.conversations[target] || blankConversation()) }
        }
      }),
    [update]
  )
  useEffect(() => {
    const timer = setTimeout(() => saveSpaces(spaces), 150)
    return () => clearTimeout(timer)
  }, [spaces])
  useEffect(() => {
    const save = () => saveSpaces(spacesRef.current)
    window.addEventListener('pagehide', save)
    return () => window.removeEventListener('pagehide', save)
  }, [])
  async function refreshComputers() {
    try {
      const result = await api('/api/computers')
      setComputers(result.computers)
      setAuth(true)
      if (!computer || !result.computers.some((c: Computer) => c.id === computer))
        setComputer(result.computers[0]?.id || '')
    } catch (e) {
      if ((e as any).status === 401) setAuth(false)
      else setNotice((e as Error).message)
    }
  }
  useEffect(() => {
    void refreshComputers()
  }, [])
  async function roster(id: string) {
    try {
      const [list, status] = await Promise.all([rpc(id, 'agents.list'), rpc(id, 'status')])
      update(id, s => ({
        ...s,
        agents: list.agents,
        online: status.runtimeConnected,
        capabilities: status.capabilities,
        error: '',
        agentId: list.agents.some((a: Agent) => a.id === s.agentId) ? s.agentId : list.agents[0]?.id || 'default'
      }))
    } catch (e) {
      update(id, s => ({ ...s, error: (e as Error).message }))
    }
  }
  useEffect(() => {
    if (!auth || !computer) return
    localStorage.setItem('studio.computer', computer)
    void roster(computer)
    let disposed = false,
      socket: WebSocket | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      delay = 500
    const connect = () => {
      const url = new URL('/api/events', location.origin)
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      url.searchParams.set('computerId', computer)
      url.searchParams.set('after', String(spacesRef.current[computer]?.seq || 0))
      socket = new WebSocket(url)
      socket.onopen = () => {
        delay = 500
      }
      socket.onmessage = event => {
        const frame = JSON.parse(event.data)
        if (frame.computerId !== computer) return
        if (frame.type === 'directory') setComputers(frame.computers)
        if (frame.type === 'connection') {
          update(computer, s => ({ ...s, online: frame.online }))
          if (frame.online) void roster(computer)
        }
        if (frame.type === 'event') {
          if(frame.kind==='peer.approval_required')setNotice('An agent is waiting for a trusted connection. Open Trusted connections to review who may collaborate.')
          update(computer, s => reduceEvent(s, frame))
          socket?.send(JSON.stringify({ type: 'cursor', seq: frame.seq }))
          if (frame.kind === 'agents.changed') void roster(computer)
          if (frame.kind === 'message.complete')
            update(computer, s => ({ ...s, approvals: s.approvals.filter(a => a.runtimeId !== frame.runtimeId) }))
        }
      }
      socket.onclose = () => {
        if (!disposed) {
          update(computer, s => ({ ...s, online: false }))
          retry = setTimeout(connect, delay)
          delay = Math.min(2000, delay * 1.7)
        }
      }
    }
    connect()
    return () => {
      disposed = true
      clearTimeout(retry)
      socket?.close()
    }
  }, [computer, auth, update])
  useEffect(() => {
    if (agent && !conversation.readOnly && !conversation.runtimeId && !conversation.loading && space.online)
      void open(computer, agent.id, conversation.sessionId || undefined)
  }, [computer, agent?.id, space.online, conversation.runtimeId])
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'instant' })
  }, [computer, space.agentId, conversation.messages.length, conversation.stream])
  async function open(id: string, aid: string, sessionId?: string, force = false) {
    const s = spacesRef.current[id] || blankSpace(),
      previous = currentConversation(s, aid)
    const cached = Object.entries(s.conversations).find(
      ([key, c]) => key.startsWith(aid + '/') && sessionId && c.sessionId === sessionId
    )
    const key = cached?.[0] || aid + '/' + (sessionId || crypto.randomUUID())
    update(id, s => ({
      ...s,
      selected: { ...s.selected, [aid]: key },
      conversations: {
        ...s.conversations,
        [key]: s.conversations[key] || { ...blankConversation(), model: previous.model, provider: previous.provider }
      }
    }))
    if ((cached?.[1].runtimeId || cached?.[1].readOnly) && !force) return
    const guard = id + ':' + key
    const version = (generations.current[guard] || 0) + 1
    generations.current[guard] = version
    updateChat(id, aid, c => ({ ...c, loading: true, error: '' }), key)
    try {
      const result = await rpc(id, 'sessions.open', {
        agentId: aid,
        sessionId,
        model: previous.model,
        provider: previous.provider
      })
      if (generations.current[guard] !== version) return
      updateChat(
        id,
        aid,
        c => ({
          ...c,
          readOnly: !!result.readOnly,
          runtimeId: result.runtimeId,
          afterSeq: result.eventCursor || 0,
          sessionId: result.sessionId,
          messages: result.messages || [],
          hasMore: result.hasMore,
          loading: false,
          running: !!result.info?.running,
          stream: ''
        }),
        key
      )
    } catch (e) {
      if (generations.current[guard] === version)
        updateChat(id, aid, c => ({ ...c, loading: false, error: (e as Error).message }), key)
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault()
    const id = computer,
      aid = space.agentId,
      key = conversationKey,
      c = conversation,
      text = c.pendingSend?.text || c.draft.trim()
    if (
      (!text && !c.attachments.length && !c.pendingSend) ||
      !c.runtimeId ||
      c.running ||
      c.attachments.some(a => a.status !== 'ready')
    )
      return
    const sendingKey = id + ':' + key
    if (sending.current.has(sendingKey)) return
    sending.current.add(sendingKey)
    const packet = c.pendingSend || {
      requestId: crypto.randomUUID(),
      runtimeId: c.runtimeId,
      text,
      attachmentIds: c.attachments.map(a => a.attachmentId!)
    }
    const requestId = packet.requestId
    updateChat(
      id,
      aid,
      c => ({
        ...c,
        draft: '',
        attachments: [],
        pendingSend: packet,
        running: true,
        error: '',
        messages: c.messages.some(m => m.id === requestId)
          ? c.messages
          : [
              ...c.messages,
              {
                id: requestId,
                role: 'user',
                content:
                  text + (c.attachments.length ? '\n\nAttached: ' + c.attachments.map(a => a.name).join(', ') : '')
              }
            ]
      }),
      key
    )
    try {
      await rpc(
        id,
        'chat.send',
        { agentId: aid, runtimeId: packet.runtimeId, text: packet.text, attachmentIds: packet.attachmentIds },
        requestId
      )
      updateChat(id, aid, current => ({ ...current, pendingSend: undefined }), key)
    } catch (e) {
      updateChat(
        id,
        aid,
        current =>
          current.pendingSend?.requestId !== requestId
            ? current
            : {
                ...current,
                running: false,
                draft: text,
                attachments: c.attachments,
                error:
                  (e as Error).message +
                  ' Your message is retained. Retry checks the same request without creating another task.'
              },
        key
      )
    } finally {
      sending.current.delete(sendingKey)
    }
  }
  async function attach(selectedFiles: File[], retry?: Attachment) {
    if (conversation.pendingSend || !space.capabilities.files) return
    const id = computer,
      aid = space.agentId,
      key = conversationKey,
      sessionId = conversation.sessionId
    try {
      checkFiles(
        selectedFiles,
        conversation.attachments.filter(
          a =>
            a.id !== retry?.id &&
            !(a.status === 'error' && selectedFiles.some(f => f.name === a.name && f.size === a.size))
        )
      )
    } catch (e) {
      setNotice((e as Error).message)
      return
    }
    for (const file of selectedFiles) {
      const matching =
        retry ||
        conversation.attachments.find(a => a.status === 'error' && a.name === file.name && a.size === file.size)
      const item: Attachment = {
        id: matching?.id || crypto.randomUUID(),
        name: file.name,
        size: file.size,
        progress: 0,
        status: 'uploading'
      }
      uploads.current[item.id] = file
      updateChat(id, aid, c => ({ ...c, attachments: [...c.attachments.filter(a => a.id !== item.id), item] }), key)
      const change = (value: Partial<Attachment>) =>
        updateChat(
          id,
          aid,
          c => ({ ...c, attachments: c.attachments.map(a => (a.id === item.id ? { ...a, ...value } : a)) }),
          key
        )
      try {
        const result = await uploadAttachment(
          file,
          id,
          aid,
          item.id,
          () => {
            const current = spacesRef.current[id]?.conversations[key]
            if (!current?.runtimeId || current.sessionId !== sessionId)
              throw new Error('Reopen this conversation and retry the upload.')
            return { runtimeId: current.runtimeId }
          },
          progress => change({ progress })
        )
        change({
          attachmentId: result.id,
          sessionId: result.sessionId,
          status: 'ready',
          progress: 100,
          error: undefined
        })
        delete uploads.current[item.id]
      } catch (e) {
        change({ status: 'error', error: (e as Error).message })
      }
    }
  }
  async function loadTasks(id = computer) {
    try {
      const result = await rpc(id, 'tasks.list')
      update(id, s => ({ ...s, tasks: result.deliveries || [], approvals: result.approvals || [] }))
    } catch {}
  }
  async function history(offset = 0) {
    const context = selectionRef.current
    if (!offset) setNames([])
    setHistoryLoading(true)
    setModal('history')
    setNotice('')
    try {
      const r = await rpc(computer, 'sessions.list', { agentId: space.agentId, offset })
      if (context === selectionRef.current) {
        setNames(current =>
          offset
            ? [...current, ...(r.sessions || []).filter((s: any) => !current.some(c => c.id === s.id))]
            : r.sessions || []
        )
        setHistoryOffset(r.nextOffset ?? null)
        if (!offset) setArchiveOffset(r.nextArchiveOffset ?? null)
      }
    } catch (e) {
      if (context === selectionRef.current) setNotice((e as Error).message)
    } finally {
      if (context === selectionRef.current) setHistoryLoading(false)
    }
  }
  async function archivedHistory() {
    if (archiveOffset === null || historyLoading) return
    const context = selectionRef.current
    setHistoryLoading(true)
    try {
      const result = await rpc(computer, 'sessions.archives', { agentId: space.agentId, offset: archiveOffset })
      if (selectionRef.current !== context) return
      setNames(current => [...current, ...result.sessions.filter((s: any) => !current.some(c => c.id === s.id))])
      setArchiveOffset(result.nextArchiveOffset)
    } catch (e) {
      if (selectionRef.current === context) setNotice((e as Error).message)
    } finally {
      if (selectionRef.current === context) setHistoryLoading(false)
    }
  }
  async function older() {
    if (!conversation.sessionId) return
    const id = computer,
      aid = space.agentId,
      key = conversationKey
    try {
      const r = await rpc(id, 'sessions.history', {
        agentId: aid,
        sessionId: conversation.sessionId,
        before: conversation.messages[0]?.id
      })
      updateChat(id, aid, c => ({ ...c, messages: [...r.messages, ...c.messages], hasMore: r.hasMore }), key)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }
  async function moreMessage(messageId: string | number, offset: number) {
    const id = computer,
      aid = space.agentId,
      key = conversationKey
    const result = await rpc(id, 'sessions.message', {
      agentId: aid,
      sessionId: conversation.sessionId,
      messageId,
      offset
    })
    updateChat(
      id,
      aid,
      c => ({
        ...c,
        messages: c.messages.map(m =>
          m.id === messageId ? { ...m, content: m.content + result.content, truncated: !!result.truncated } : m
        )
      }),
      key
    )
  }
  async function createAgent(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setNotice('')
    try {
      await rpc(computer, 'agents.create', {
        name: agentName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '-'),
        role
      })
      await roster(computer)
      setModal('')
      setAgentName('')
      setRole('')
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function importFile(file: File) {
    const context = selectionRef.current
    setBusy(true)
    setNotice('')
    try {
      const result = await prepareImport(file, computer, percent => {
        if (selectionRef.current === context)
          setNotice(
            percent === 100
              ? 'Transfer complete. Preparing your review…'
              : `Transferring ${percent}%…`
          )
      })
      if (selectionRef.current !== context) return
      setPendingImport({...result,computer,name:file.name});setNotice('Review the selected export before applying it.')
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function settings() {
    const context = selectionRef.current
    setModal('settings')
    setNotice('')
    setFlow(null)
    try {
      const [providers, settings] = await Promise.all([
        rpc(computer, 'providers.list', { agentId: space.agentId }),
        rpc(computer, 'settings.get')
      ])
      if (context !== selectionRef.current) return
      setProviders(providers)
      setLimits(settings)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }
  async function authenticate(provider: string, acknowledgeExtraUsage = false) {
    const context = selectionRef.current
    setBusy(true)
    setNotice('')
    try {
      const flow = await rpc(computer, 'providers.begin', { agentId: space.agentId, provider, acknowledgeExtraUsage })
      if (context === selectionRef.current) setFlow(flow)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (auth === null)
    return (
      <div className="login bot-product-shell">
        <img src="/studio-icon.png" />
        <p>Opening Studio…</p>
      </div>
    )
  if (!auth)
    return (
      <main className="login bot-product-shell">
        <form
          onSubmit={async e => {
            e.preventDefault()
            try {
              await api('/api/login', { password })
              setPassword('')
              await refreshComputers()
            } catch (e) {
              setLoginError((e as Error).message)
            }
          }}
        >
          <img src="/studio-icon.png" />
          <h1>{BRAND.name}</h1>
          <p>Your agents. Your computers.</p>
          <label>
            Studio password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
            />
          </label>
          <button className="primary">Open workspace →</button>
          {loginError && <p role="alert">{loginError}</p>}
        </form>
      </main>
    )
  return (
    <main className="app bot-product-shell">
      <aside className="rail">
        <div className="studio-brand">
          <img className="studio-brand-icon" src="/studio-icon.png" />
          <h1>
            {BRAND.name}<span>{BRAND.byline}</span>
          </h1>
        </div>
        <div className="computer-picker">
          <label htmlFor="computer">Computer</label>
          <select
            id="computer"
            aria-label="Select computer"
            value={computer}
            onChange={e => {
              setComputer(e.target.value)
              setNotice('')
              setModal('')
              setFlow(null)
            }}
          >
            {!computers.length && <option value="">No computers connected</option>}
            {computers.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="connection">
            <i className={space.online ? 'dot live' : 'dot'} />
            {space.online ? 'Connected to Hermes' : computer ? 'Offline' : 'Connect an Orgo computer'}
            {!space.online && computer && <button onClick={() => setModal('computers')}>Connect / Repair</button>}
          </div>
        </div>
        <input
          className="search"
          placeholder="Search agents"
          aria-label="Search agents"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div className="roster-heading">
          <span className="studio-nav-label">AGENTS</span>
          <button
            className="icon-button"
            title="Create an agent"
            disabled={!space.capabilities.teams}
            onClick={() => {
              setModal('agent')
              setNotice('')
            }}
          >
            ＋
          </button>
        </div>
        {space.agents.some(isTestAgent) && <button className="test-agents-toggle" onClick={() => setShowTests(v => !v)}>{showTests ? "Hide test agents" : "Test agents"}</button>}
        <nav className="roster">
          {space.agents
            .filter(a => (showTests || !isTestAgent(a) || a.id === space.agentId) && (a.name + ' ' + a.description).toLowerCase().includes(search.toLowerCase()))
            .map(a => (
              <button
                data-studio-bot-row
                key={a.id}
                aria-current={a.id === space.agentId ? 'page' : undefined}
                onClick={() => update(computer, s => ({ ...s, agentId: a.id }))}
              >
                <span className={'avatar ' + (a.head ? 'head' : '')}>{a.head ? '✳' : initials(a.name)}</span>
                <span className="agent-label">
                  <strong>{title(a)}</strong>
                  <small>
                    {Object.entries(space.conversations).some(([key, c]) => key.startsWith(a.id + '/') && c.running)
                      ? 'Working…'
                      : a.head
                        ? 'Your lead operator'
                        : a.description || 'Hermes specialist'}
                  </small>
                </span>
                {Object.entries(space.conversations).some(([key, c]) => key.startsWith(a.id + '/') && c.running) && (
                  <i className="working" />
                )}
              </button>
            ))}
        </nav>
        <footer className="rail-footer">
          <button
            onClick={() => {
              setModal('computers')
              setNotice('')
            }}
          >
            ▱ &nbsp; Computers
          </button>
          <button
            disabled={!computer}
            onClick={() => {
              setModal('import')
              setNames([])
              setNotice('')
            }}
          >
            ↥ &nbsp; Import from Hermes
          </button>
          <button disabled={!agent} onClick={() => setDetails(true)}>◈ &nbsp; Profiles & skills</button>
          <button disabled={!computer} onClick={() => setModal('files')}>▤ &nbsp; Computer files</button>
          <button disabled={!computer} onClick={() => setModal('connections')}>⇄ &nbsp; Trusted connections</button>
          <button disabled={!computer} onClick={() => void settings()}>
            ⚙ &nbsp; Settings & subscriptions
          </button>
          <div className="owner">
            <span className="avatar small">GS</span>
            <span>
              Private workspace<small>Hermes on your computers</small>
            </span>
            <button
              title="Sign out"
              onClick={async () => {
                await api('/api/logout', {})
                setAuth(false)
                setSpaces({})
                localStorage.removeItem('studio.preferences')
              }}
            >
              ↪
            </button>
          </div>
        </footer>
      </aside>
      <section className="conversation">
        <header data-hermes-bot-chat-header>
          <span className="avatar small">{agent?.head ? '✳' : initials(agent?.name || '')}</span>
          <div>
            <strong>{agent ? title(agent) : 'Your workspace'}</strong>
            <small>{selected?.name || 'Connect a computer to begin'}</small>
          </div>
          <div className="header-actions">
            <button disabled={!agent} onClick={() => setDetails(true)}>
              Agent details
            </button>
            <button disabled={!agent} onClick={() => void history()}>
              History
            </button>
            <button disabled={!agent || conversation.running} onClick={() => void open(computer, space.agentId)}>
              New chat ＋
            </button>
          </div>
        </header>
        {(space.error || conversation.error) && (
          <div className="error-banner" role="alert">
            {conversation.error || space.error}
            <button onClick={() => selected?.online ? void open(computer, space.agentId, conversation.sessionId || undefined, true) : setModal('computers')}>
              {selected?.online ? 'Reconnect conversation' : 'Connect / Repair computer'}
            </button>
          </div>
        )}
        <ConversationFiles
          key={computer + conversationKey}
          computer={computer}
          agent={space.agentId}
          runtime={conversation.runtimeId}
          revision={conversation.messages.length}
          enabled={!!space.capabilities.files}
        />
        <div className="transcript" data-chat-surface>
          {conversation.hasMore && (
            <button className="older" onClick={() => void older()}>
              Load earlier messages
            </button>
          )}
          {conversation.loading && <div className="loading-line">Opening conversation…</div>}
          {!conversation.messages.length && !conversation.loading && (
            <div className="empty-conversation">
              <span className="empty-mark">✳</span>
              <h2>{agent ? 'What are we working on?' : 'Your computers, together.'}</h2>
              <p>
                {agent
                  ? `Talk to ${title(agent)} on ${selected?.name}.`
                  : 'Connect an Orgo computer to see its agents and continue their work.'}
              </p>
              {agent && (
                <div className="suggestions">
                  {['Create a specialist for my next task', 'Show me what you can help with'].map(text => (
                    <button
                      key={text}
                      onClick={() => {
                        updateChat(computer, space.agentId, c => ({ ...c, draft: text }))
                        composer.current?.focus()
                      }}
                    >
                      {text} ↗
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {conversation.messages
            .filter(m => ['user', 'assistant', 'tool'].includes(m.role))
            .map(m => (
              <article key={m.id} className={'message ' + m.role}>
                <div className="message-author">
                  {m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool result' : agent ? title(agent) : 'Agent'}
                </div>
                {m.role === 'tool' ? (
                  <details>
                    <summary>View tool result</summary>
                    <pre>{m.content}</pre>
                  </details>
                ) : (
                  <Streamdown>{typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}</Streamdown>
                )}
                {m.truncated && (
                  <button
                    onClick={() =>
                      void moreMessage(m.id, Array.from(m.content).length).catch(e => setNotice(e.message))
                    }
                  >
                    Show more of this message
                  </button>
                )}
              </article>
            ))}
          {conversation.running && (
            <article className="message assistant">
              <div className="message-author">
                {agent ? title(agent) : 'Agent'} <i className="working" />
              </div>
              {conversation.stream ? (
                <Streamdown>{conversation.stream}</Streamdown>
              ) : (
                <span className="thinking">
                  Working on your computer<span>•••</span>
                </span>
              )}
            </article>
          )}
          <div ref={bottom} />
        </div>
        <form
          className="composer"
          onSubmit={e => void send(e)}
          data-slot="composer-root"
          onDragOver={e => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault()
          }}
          onDrop={e => {
            if (e.dataTransfer.files.length) {
              e.preventDefault()
              if (!conversation.readOnly && conversation.runtimeId) void attach(Array.from(e.dataTransfer.files))
            }
          }}
        >
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            accept={ACCEPT}
            onChange={e => {
              if (e.target.files) void attach(Array.from(e.target.files))
              e.target.value = ''
            }}
          />
          {!!conversation.attachments.length && (
            <div className="attachment-chips">
              {conversation.attachments.map(a => (
                <div className={'attachment-chip ' + a.status} key={a.id}>
                  <span title={a.error || a.name}>
                    {a.name}
                    <small>
                      {a.status === 'uploading'
                        ? a.progress + '%'
                        : a.status === 'error'
                          ? a.error
                          : Math.ceil(a.size / 1024) + ' KB · Ready'}
                    </small>
                  </span>
                  {a.status === 'error' && uploads.current[a.id] && (
                    <button type="button" onClick={() => void attach([uploads.current[a.id]], a)}>
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={'Remove ' + a.name}
                    onClick={() =>
                      updateChat(computer, space.agentId, c => ({
                        ...c,
                        attachments: c.attachments.filter(f => f.id !== a.id)
                      }))
                    }
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          {conversation.pendingSend && !conversation.running && (
            <p className="small-note" style={{ padding: '0 16px' }}>
              Message awaiting confirmation. Send again to check the same request.
            </p>
          )}
          {conversation.readOnly && (
            <p>
              Preserved Mac history.{' '}
              <button type="button" onClick={() => void open(computer, space.agentId)}>
                Start a new conversation
              </button>
            </p>
          )}
          <textarea
            ref={composer}
            onPaste={e => {
              const images = Array.from(e.clipboardData.files).filter(f => f.type.startsWith('image/'))
              if (images.length && !conversation.readOnly) {
                e.preventDefault()
                void attach(images)
              }
            }}
            aria-label="Message your agent"
            placeholder={
              conversation.readOnly
                ? 'Preserved Mac history · start a new conversation to continue'
                : agent
                  ? `Message ${title(agent)}…`
                  : 'Connect a computer to chat'
            }
            value={conversation.draft}
            disabled={!agent || conversation.readOnly || !!conversation.pendingSend}
            onChange={e => updateChat(computer, space.agentId, c => ({ ...c, draft: e.target.value }))}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                e.currentTarget.form?.requestSubmit()
              }
            }}
          />
          <div className="composer-toolbar">
            <button
              type="button"
              className="attach-button"
              aria-label="Attach files"
              title="Attach images or documents · 25 MB per file"
              disabled={
                !conversation.runtimeId ||
                conversation.readOnly ||
                !space.online ||
                !space.capabilities.files ||
                !!conversation.pendingSend
              }
              onClick={() => fileInput.current?.click()}
            >
              ＋
            </button>
            <button type="button" className="model" onClick={() => void settings()}>
              {conversation.model || agent?.model || 'Profile model'} ⌄
            </button>
            <span>Runs on {selected?.name || 'Orgo'}</span>
            {conversation.running ? (
              <button
                type="button"
                className="send"
                aria-label="Stop agent"
                onClick={() =>
                  void rpc(computer, 'chat.cancel', {
                    agentId: space.agentId,
                    runtimeId: conversation.runtimeId
                  }).catch(e => setNotice(e.message))
                }
              >
                ■
              </button>
            ) : (
              <button
                className="send"
                aria-label="Send message"
                disabled={
                  !space.online ||
                  !conversation.runtimeId ||
                  (!conversation.draft.trim() && !conversation.attachments.length && !conversation.pendingSend) ||
                  conversation.attachments.some(a => a.status !== 'ready') ||
                  conversation.loading
                }
              >
                ↑
              </button>
            )}
          </div>
        </form>
        <div className="composer-note">Enter to send · Shift + Enter for a new line</div>
      </section>
      <aside className="inspector">
        <header>
          <span>WORKSPACE</span>
          <span className="cloud-label">{selected?.kind === 'local' ? '⌘ Mac' : '☁ Orgo'}</span>
        </header>
        {agent && (
          selected?.kind === 'local' ? <section className="local-summary connection-card"><h3>Hermes on your Mac</h3><p><strong>{title(agent)}</strong> · {selected.name}</p><p className="small-note">Chat and files use this Mac’s Hermes profile. Sharing with another computer follows your trusted connections.</p><button onClick={() => setModal('files')}>Browse Mac files</button><button onClick={() => setDetails(true)}>Profiles, skills & memory</button></section> : <Screen
            key={computer + ':' + agent.id}
            computer={computer}
            agent={agent.id}
            enabled={!!space.capabilities.screens && space.online}
          />
        )}
        <section className="task-section">
          {space.approvals.map(a => (
            <div className="approval" key={a.request_id}>
              <h3>Approval needed</h3>
              <p>{a.description || a.command}</p>
              {(a.choices || ['once', 'deny'])
                .filter((choice: string) => ['once', 'deny'].includes(choice))
                .map((choice: string) => (
                  <button
                    key={choice}
                    onClick={async () => {
                      try {
                        await rpc(computer, 'approvals.resolve', {
                          agentId: a.agentId || a.agent,
                          runtimeId: a.runtimeId || a.session_id,
                          approvalId: a.request_id,
                          choice
                        })
                        update(computer, s => ({
                          ...s,
                          approvals: s.approvals.filter(x => x.request_id !== a.request_id)
                        }))
                      } catch (e) {
                        setNotice((e as Error).message)
                      }
                    }}
                  >
                    {choice === 'once' ? 'Allow once' : 'Deny'}
                  </button>
                ))}
            </div>
          ))}
          <div className="section-heading">
            <h3>Team activity</h3>
            <button title="Refresh activity" onClick={() => void loadTasks()}>
              ↻
            </button>
          </div>
          {space.tasks.length ? (
            [...space.tasks]
              .sort((a, b) => Number(b.state === 'needs_review') - Number(a.state === 'needs_review'))
              .slice(0, 10)
              .map(t => (
                <div className="task-row" key={computer + ':' + t.id}>
                  <span className={'task-state ' + t.state} />
                  <div>
                    <strong>{t.recipient}</strong>
                    <p>{t.body?.slice(0, 100)}</p>
                    <small>{t.state.replace('_', ' ')}</small>
                    <TaskActions computer={computer} task={t} changed={() => void loadTasks(computer)} />
                  </div>
                </div>
              ))
          ) : (
            <div className="muted-empty">
              <span>↗</span>
              <p>Delegated work appears here.</p>
              <small>Your head operator can create specialists and coordinate across your computers.</small>
            </div>
          )}
        </section>
        <div className="inspector-note">
          <i className={space.online ? 'dot live' : 'dot'} />
          <span>Agents keep working when you close Studio.</span>
        </div>
      </aside>
      {details && agent && (
        <Suspense fallback={<div className="toast">Opening profile…</div>}><AgentDetails
          key={computer + ':' + agent.id}
          computer={computer}
          agent={agent.id}
          name={title(agent)}
          computerName={selected?.name || 'Orgo'}
          close={() => setDetails(false)}
        /></Suspense>
      )}
      {modal && (
        <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setModal('')}>
          <section className="modal" role="dialog" aria-modal="true" aria-label={modal}>
            <button className="modal-close" onClick={() => setModal('')}>
              ×
            </button>
            {modal === 'agent' && (
              <form onSubmit={e => void createAgent(e)}>
                <h2>Create a specialist</h2>
                <p>Hosted on {selected?.name}.</p>
                <label>
                  Name
                  <input value={agentName} onChange={e => setAgentName(e.target.value)} required maxLength={40} />
                </label>
                <label>
                  Role and instructions
                  <textarea value={role} onChange={e => setRole(e.target.value)} required maxLength={4000} />
                </label>
                <button className="primary" disabled={busy}>
                  {busy ? 'Creating…' : 'Create agent'}
                </button>
              </form>
            )}
            {modal === 'history' && (
              <>
                <h2>Conversation history</h2>
                <p>
                  {agent && title(agent)} · {selected?.name}
                </p>
                <div className="history-list">
                  {names.map(s => (
                    <button
                      key={s.id}
                      onClick={() => {
                        void open(computer, space.agentId, s.id)
                        setModal('')
                      }}
                    >
                      <strong>{s.title || 'Untitled conversation'}</strong>
                      <small>{s.preview || s.id}</small>
                    </button>
                  ))}
                </div>
                {historyOffset !== null && (
                  <button disabled={historyLoading} onClick={() => void history(historyOffset)}>
                    {historyLoading ? 'Loading…' : 'Load older conversations'}
                  </button>
                )}
                {archiveOffset !== null && (
                  <button disabled={historyLoading} onClick={() => void archivedHistory()}>
                    {historyLoading ? 'Loading…' : 'Load older imported updates'}
                  </button>
                )}
              </>
            )}
            {modal === 'files' && <Explorer key={computer + ':' + space.agentId} computer={computer} agent={space.agentId} local={selected?.kind === 'local'} />}
            {modal === 'connections' && <TrustedConnections computers={computers} current={computer} />}
            {modal === 'import' && <HermesLibrary key={computer} computer={computer} name={selected?.name || 'this computer'} computers={computers} localSetup={() => setModal('local')} fallback={<>
              {pendingImport?.computer===computer&&<div className="connection-card"><strong>Review {pendingImport.name}</strong>{pendingImport.preview.profiles.map((p:any)=><p key={p.source}>{p.source}: {p.newProfile?'new profile':p.target} · {p.added} added · {p.changed} changed · {p.conflicts} conflicts preserved</p>)}<p className="small-note">Credentials are excluded. Imported scripts do not run during transfer.</p>{pendingImport.preview.warnings.map((w:string)=><p className="small-note" key={w}>{w}</p>)}<button className="primary" disabled={busy} onClick={()=>{const current=pendingImport;setBusy(true);void current.apply().then((r:any)=>{setPendingImport(null);setNotice(`Imported ${r.profiles.length} profiles. Conflicting edits were preserved.`);return roster(current.computer)}).catch((e:Error)=>setNotice(e.message)).finally(()=>setBusy(false))}}>Apply reviewed export</button><button onClick={()=>setPendingImport(null)}>Cancel</button></div>}
              <div className="import-dropzone" onDragOver={e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }} onDrop={e => { e.preventDefault(); if (!busy && e.dataTransfer.files[0]) void importFile(e.dataTransfer.files[0]) }}><p>Drop a Hermes export here, or choose a file.</p><label className="file-input">{busy ? 'Importing…' : 'Choose a Hermes export'}<input type="file" accept=".json,.zip" disabled={busy} onChange={e => e.target.files?.[0] && void importFile(e.target.files[0])} /></label></div>
              <p className="small-note">Choose a destination-bound Studio export. Existing agents and cloud edits are preserved.</p>
              {names.map((n,i) => <p className="small-note" key={i}>{n.title}</p>)}
            </>} />}
            {modal === 'local' && <LocalSetup computers={computers} select={id => { void refreshComputers(); setComputer(id); setModal('') }} />}
            {modal === 'computers' && <ComputerManager initialComputer={computer} localSetup={() => setModal('local')} select={id => { setComputer(id); setModal('') }} refresh={refreshComputers} />}
            {modal === 'settings' && (
              <>
                <h2>Settings & subscriptions</h2>
                <p>
                  {agent && title(agent)} · {selected?.name}
                </p>
                <Suspense fallback={<p>Opening Hermes settings…</p>}><ModelPicker key={computer + ':' + space.agentId + ':' + conversation.runtimeId}
                  computer={computer} agent={space.agentId} runtime={conversation.runtimeId}
                  model={conversation.model || agent?.model || ''} provider={conversation.provider || agent?.provider || ''}
                  changed={value => updateChat(computer, space.agentId, c => ({ ...c, ...value }))} /></Suspense>
                <details><summary>Computer task limits</summary>
                <h3>Computer task limits</h3>
                <label>
                  Concurrent agent turns
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={limits.maxConcurrent}
                    onChange={e => setLimits(v => ({ ...v, maxConcurrent: Number(e.target.value) }))}
                  />
                </label>
                <label>
                  Cross-computer delegation hops
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={limits.maxPeerHops}
                    onChange={e => setLimits(v => ({ ...v, maxPeerHops: Number(e.target.value) }))}
                  />
                </label>
                <button
                  onClick={async () => {
                    try {
                      await rpc(computer, 'settings.update', limits)
                      setNotice('Computer task limits saved.')
                    } catch (e) {
                      setNotice((e as Error).message)
                    }
                  }}
                >
                  Save task limits
                </button>
                <p className="small-note">
                  Existing per-profile turn limits are retained. Additional turns share this computer's available
                  resources.
                </p>
                </details>
                <div className="settings-tabs" role="tablist" aria-label="Provider settings">
                  {[['accounts','Subscriptions'],['keys','API keys'],['endpoints','Custom endpoints']].map(([id,label]) => <button key={id} role="tab" aria-selected={settingsTab === id} onClick={() => setSettingsTab(id)}>{label}</button>)}
                </div>
                {settingsTab === 'keys' && <ProviderKeys key={computer + ':' + space.agentId} computer={computer} agent={space.agentId} />}
                {settingsTab === 'endpoints' && <Suspense fallback={<p>Opening endpoints…</p>}><Endpoints key={computer + ':' + space.agentId} computer={computer} agent={space.agentId} /></Suspense>}
                {settingsTab === 'accounts' && <>
                <h3>Connect a subscription</h3>
                <div className="provider-buttons">
                  <button disabled={busy} onClick={() => void authenticate('openai-codex')}>
                    ChatGPT / Codex
                  </button>
                  <button disabled={busy} onClick={() => void authenticate('anthropic')}>
                    Claude
                  </button>
                </div>
                {flow && (
                  <div className="auth-flow">
                    <p>{flow.message || flow.status}</p>
                    {flow.url && (
                      <a href={flow.url} target="_blank" rel="noreferrer">
                        Open provider sign-in ↗
                      </a>
                    )}
                    {flow.code && <code>{flow.code}</code>}
                    {flow.status === 'acknowledgment_required' && (
                      <button onClick={() => void authenticate('anthropic', true)}>
                        Continue with Max extra usage
                      </button>
                    )}
                    {flow.flow === 'pkce' && (
                      <form
                        onSubmit={async e => {
                          e.preventDefault()
                          const code = new FormData(e.currentTarget).get('code')
                          try {
                            setFlow(
                              await rpc(computer, 'providers.submit', {
                                agentId: space.agentId,
                                flowId: flow.flowId,
                                code
                              })
                            )
                          } catch (e) {
                            setNotice((e as Error).message)
                          }
                        }}
                      >
                        <label>
                          Authorization code
                          <input name="code" type="password" required />
                        </label>
                        <button>Complete connection</button>
                      </form>
                    )}
                    <button
                      disabled={!flow.flowId}
                      onClick={async () => {
                        try {
                          setFlow(
                            await rpc(computer, 'providers.status', { agentId: space.agentId, flowId: flow.flowId })
                          )
                        } catch (e) {
                          setNotice((e as Error).message)
                        }
                      }}
                    >
                      Check connection
                    </button>
                  </div>
                )}
                <div className="provider-list">
                  {providers?.providers
                    ?.filter((p: any) => ['openai-codex', 'anthropic'].includes(p.id))
                    .map((p: any) => (
                      <p key={p.id}>
                        <strong>{p.name}</strong> · {p.connected ? 'Connected' : 'Not connected'}
                        {p.expiresAt && <small> · Expires {new Date(p.expiresAt).toLocaleString()}</small>}
                        {p.notice && <small className="small-note">{p.notice}</small>}
                      </p>
                    ))}
                </div>
                </>}
              </>
            )}
            {notice && (
              <div className="notice" role="status">
                {notice}
              </div>
            )}
          </section>
        </div>
      )}
      {!modal && notice && (
        <div className="toast" role="status">
          {notice}
          <button onClick={() => setNotice('')}>×</button>
        </div>
      )}
    </main>
  )
}
createRoot(document.getElementById('root')!).render(<App />)
