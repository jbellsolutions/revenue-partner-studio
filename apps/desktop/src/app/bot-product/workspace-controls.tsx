import { OpenComputerButton } from './open-computer'
import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n/context'
import { $gateway } from '@/store/gateway'
import { $gatewayState } from '@/store/session'

import { ShareHistory } from './share-history'

interface ThreadRow {
  id: string
  title?: string
  profile?: string
  source?: string
}
interface WorkspaceControlsProps {
  profile: string
  request: (method: string, params: Record<string, unknown>) => Promise<{ sessions?: ThreadRow[] }>
  onOpenThread: (profile: string, id: string) => Promise<unknown>
  onNewThread: (profile: string) => void
  onCreateAgent: () => void
}

export function ComputerWindows() {
  const { t } = useI18n()
  const copy = t.botWorkspace

  const [instances, setInstances] = useState<
    Awaited<ReturnType<NonNullable<Window['hermesDesktop']>['orgoDesktop']['listInstances']>>
  >([])

  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [checkedAt, setCheckedAt] = useState('')
  const generation = useRef(0)

  const refresh = useCallback(async (remote = false) => {
    const request = ++generation.current
    setRefreshing(true)
    setError('')

    try {
      const rows = await window.hermesDesktop?.orgoDesktop.listInstances?.(remote)

      if (generation.current === request && rows) {
        setInstances(rows)

        if (remote) {
          setCheckedAt(new Date().toLocaleTimeString())
        }
      }
    } catch (e) {
      if (generation.current === request) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (generation.current === request) {
        setRefreshing(false)
      }
    }
  }, [])

  useEffect(()=>{const update=()=>{void refresh()};window.addEventListener('studio:computers-changed',update);return ()=>window.removeEventListener('studio:computers-changed',update)},[refresh])

  // eslint-disable-next-line no-restricted-syntax -- request generation is not mirrored reactive state
  useEffect(() => {
    void refresh()

    return () => {
      // Invalidate outstanding requests on unmount.
      generation.current += 1
    }
  }, [refresh])

  const open = async (target: string) => {
    setBusy(true)
    setError('')

    try {
      await window.hermesDesktop?.orgoDesktop.openInstance(target)
      await refresh(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const makeDefault = async (name: string) => {
    setBusy(true); setError('')
    try {
      await window.hermesDesktop?.orgoDesktop.setDefaultInstance(name)
      window.dispatchEvent(new Event('studio:computers-changed'))
      await refresh()
    } catch (e) {setError(e instanceof Error ? e.message : String(e))}
    finally {setBusy(false)}
  }

  return (
    <details
      className="px-3 py-2"
      onToggle={event => {
        if (event.currentTarget.open) {
          void refresh(true)
        }
      }}
    >
      <summary className="cursor-pointer text-xs font-medium">
        <span className="inline-flex items-center gap-1">
          {copy.computers}
          <Button
            aria-label={copy.refreshComputers}
            disabled={refreshing || busy}
            onClick={event => {
              event.preventDefault()
              event.stopPropagation()
              void refresh(true)
            }}
            size="xs"
            variant="ghost"
          >
            {refreshing ? <Loader className="size-3" /> : t.common.refresh}
          </Button>
        </span>
      </summary>
      <p className="py-2 text-xs text-muted-foreground">{copy.isolation}</p>
      {checkedAt && <p className="text-xs text-muted-foreground" role="status">{copy.checkedAt}: {checkedAt}</p>}
      <div className="grid gap-1">
        {instances.map(instance => (
          <div key={instance.name} className="grid gap-1 rounded-md border border-border/50 p-1">
          <Button
            disabled={busy || instance.current || instance.unreadable}
            key={instance.name}
            onClick={() => void open(instance.name)}
            size="sm"
            variant="ghost"
          >
            <span className="min-w-0 wrap-anywhere whitespace-normal text-left">
              {instance.name.startsWith('computer-') ? '' : `${instance.name || copy.primary} · `}
              {instance.unreadable ? copy.unreadable : instance.cloudName || instance.computerId || copy.unconfigured}
              {instance.availability === 'available' && ` · ${instance.cloudStatus}`}
              {instance.availability === 'missing' && ` · ${copy.computerMissing}`}
              {instance.availability === 'unknown' && ` · ${copy.computerUnknown}`}
            </span>
          </Button>
          {instance.isDefault ? <span className="px-2 text-xs text-muted-foreground">Default on launch</span> :
            <Button size="xs" variant="ghost" disabled={busy || instance.unreadable || !instance.computerId}
              onClick={() => void makeDefault(instance.name)}
              aria-label={`Make ${instance.cloudName || instance.name || copy.primary} default`}>Make default</Button>}
          </div>
        ))}
        <OpenComputerButton />
        <Button size="sm" variant="ghost" onClick={() => {void window.hermesDesktop?.orgoDesktop.fitWindow().catch(e => setError(String(e)))}}>Fit window</Button>
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>
    </details>
  )
}

export function AgentThreads({ profile, request, onOpenThread, onNewThread, onCreateAgent }: WorkspaceControlsProps) {
  const { t } = useI18n()
  const copy = t.botWorkspace
  const gateway = useStore($gateway)
  const gatewayState = useStore($gatewayState)
  // Boot can report an open socket before publishing the active gateway.
  // Wait for both, then refresh immediately rather than leaving a startup
  // failure visible until the next 15-second poll. Reconnect follows the same
  // path; cached rows remain available while old in-flight reads are discarded.
  const ready = Boolean(gateway) && gatewayState === 'open'
  const [rows, setRows] = useState<ThreadRow[]>([])
  const [loadedProfile, setLoadedProfile] = useState('')
  const [limit, setLimit] = useState(100)
  const [rawCount, setRawCount] = useState(0)
  const [sharing, setSharing] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [refreshKey, setRefreshKey] = useState(0)
  useEffect(() => {
    let disposed = false
    let inFlight = false
    setError('')

    if (!ready) {
      setLoading(false)

      return
    }

    const refresh = async () => {
      if (disposed || inFlight) {
        return
      }

      inFlight = true
      setLoading(true)

      try {
        const response = await request('session.list', { profile, limit })

        if (disposed) {
          return
        }

        setRows(
          (Array.isArray(response.sessions) ? response.sessions : []).filter(
            row => typeof row.id === 'string' && (!row.profile || row.profile === profile)
          )
        )
        setLoadedProfile(profile)
        setRawCount(Array.isArray(response.sessions) ? response.sessions.length : 0)
        setError('')
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e))
        }
      } finally {
        inFlight = false

        if (!disposed) {
          setLoading(false)
        }
      }
    }

    void refresh()
    const timer = window.setInterval(() => void refresh(), 15000)

    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [profile, limit, request, refreshKey, gateway, ready])
  const visibleRows = loadedProfile === profile ? rows.filter(row => row.source !== 'cron') : []

  const open = async (id: string) => {
    setOpening(true)
    setError('')

    try {
      await onOpenThread(profile, id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(false)
    }
  }

  return (
    <section aria-label={copy.threads} className="grid min-w-0 grid-cols-1 gap-1 px-3 py-2">
      <div className="flex min-w-0 items-center justify-between gap-1">
        <span className="min-w-0 truncate text-xs font-medium">
          {copy.threads} · {profile}
        </span>
        <Button disabled={!ready} onClick={() => setRefreshKey(value => value + 1)} size="xs" variant="ghost">
          {t.common.refresh}
        </Button>
      </div>
      <div className="flex gap-1">
        <Button onClick={() => onNewThread(profile)} size="xs" variant="secondary">
          {copy.newThread}
        </Button>
        <Button onClick={onCreateAgent} size="xs" variant="ghost">
          {copy.newAgent}
        </Button>
      </div>
      {loading && !visibleRows.length ? <Loader /> : null}
      {!ready && <p className="text-xs text-muted-foreground" role="status">{t.common.connecting}</p>}
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {ready && !loading && !error && !visibleRows.length && <p className="text-xs text-muted-foreground">{copy.empty}</p>}
      <div className="grid max-h-48 gap-1 overflow-y-auto">
        {visibleRows.map(row => (
          <div className="flex min-w-0 gap-1" key={row.id}>
            <Button
              className="min-w-0 flex-1"
              disabled={opening}
              onClick={() => void open(row.id)}
              size="sm"
              variant="ghost"
            >
              <span className="min-w-0 truncate">{row.title || copy.untitled}</span>
            </Button>
            <Button
              aria-label={`${copy.shareHistory}: ${row.title || copy.untitled}`}
              onClick={() => setSharing(row.id)}
              size="xs"
              variant="ghost"
            >
              {copy.shareHistory}
            </Button>
          </div>
        ))}
      </div>
      {rawCount >= limit && (
        <Button onClick={() => setLimit(value => value + 100)} size="xs" variant="ghost">
          {copy.more}
        </Button>
      )}
      {sharing && (
        <ShareHistory
          key={`${profile}:${sharing}`}
          onClose={() => setSharing(null)}
          onOpenThread={onOpenThread}
          profile={profile}
          sessionId={sharing}
        />
      )}
    </section>
  )
}
