import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type {
  DesktopComposioAuthorizeResult,
  DesktopComposioConnection,
  DesktopComposioKeyStatus,
  DesktopComposioStatus,
  DesktopComposioToolkit
} from '@/global'
import { getProfiles } from '@/hermes'
import { useI18n } from '@/i18n'
import { ExternalLink, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'

import { syncConnectorsToRoster } from './provision'

const SEARCH_DEBOUNCE_MS = 280

function connectorsApi() {
  return window.hermesDesktop?.connectors
}

function ToolkitLogo({ logo, name }: { logo: string | null; name: string }) {
  const [failed, setFailed] = useState(false)
  const initial = name.trim().slice(0, 1).toUpperCase() || '?'

  useEffect(() => {
    setFailed(false)
  }, [logo])

  if (!logo || failed || !/^https:\/\//i.test(logo)) {
    return (
      <div
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-md bg-(--ui-bg-quaternary) text-[13px] font-semibold text-(--ui-text-secondary)"
      >
        {initial}
      </div>
    )
  }

  return (
    <img
      alt=""
      className="size-8 shrink-0 rounded-md object-contain"
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={logo}
    />
  )
}

function actionLabel(status: DesktopComposioStatus, copy: ReturnType<typeof useI18n>['t']['connectors']): string {
  if (status === 'connected') {
    return copy.disconnect
  }

  if (status === 'pending' || status === 'error') {
    return copy.reconnect
  }

  return copy.connect
}

export function ConnectorsPanel({ active = true }: { active?: boolean }) {
  const { t } = useI18n()
  const copy = t.connectors
  const [keyStatus, setKeyStatus] = useState<DesktopComposioKeyStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [editingKey, setEditingKey] = useState(false)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [catalog, setCatalog] = useState<DesktopComposioToolkit[] | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [connections, setConnections] = useState<DesktopComposioConnection[]>([])
  const [loading, setLoading] = useState(false)
  const [savingKey, setSavingKey] = useState(false)
  const [busySlug, setBusySlug] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS)

    return () => window.clearTimeout(handle)
  }, [search])

  const loadStatus = useCallback(async () => {
    const api = connectorsApi()

    if (!api) {
      setKeyStatus({ configured: false, hint: null })

      return { configured: false, hint: null }
    }

    const status = await api.keyStatus()
    setKeyStatus(status)

    return status
  }, [])

  const refreshAll = useCallback(async () => {
    const status = await loadStatus()

    if (!status.configured) {
      setCatalog([])
      setConnections([])

      return
    }

    const api = connectorsApi()

    if (!api) {
      return
    }

    setLoading(true)
    setError(null)

    try {
      const [catalogResult, yours] = await Promise.all([
        api.catalog({ search: debouncedSearch || undefined }),
        api.connections()
      ])

      setCatalog(catalogResult.items)
      setCursor(catalogResult.nextCursor)
      setConnections(yours)
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.loadFailed)
    } finally {
      setLoading(false)
    }
  }, [copy.loadFailed, debouncedSearch, loadStatus])

  useEffect(() => {
    if (!active) {
      return
    }

    void refreshAll()
  }, [active, refreshAll])

  const saveKey = async () => {
    const api = connectorsApi()
    const key = keyDraft.trim()

    if (!api || !key) {
      return
    }

    setSavingKey(true)
    setError(null)

    try {
      setKeyStatus(await api.saveKey(key))
      setKeyDraft('')
      setEditingKey(false)
      await syncConnectorsToRoster()
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.keyInvalid)
    } finally {
      setSavingKey(false)
    }
  }

  const removeKey = async () => {
    const api = connectorsApi()

    if (!api) {
      return
    }

    setKeyStatus(await api.removeKey())
    setCatalog([])
    setConnections([])
    setKeyDraft('')
    setEditingKey(false)
  }

  const provision = async () => {
    try {
      const roster = await getProfiles()
      await syncConnectorsToRoster(roster.profiles)
    } catch (err) {
      notifyError(err, copy.syncFailed)
    }
  }

  const connect = async (slug: string) => {
    const api = connectorsApi()

    if (!api) {
      return
    }

    setBusySlug(slug)
    setError(null)

    try {
      let result: DesktopComposioAuthorizeResult = await api.authorize(slug)

      if (result.status === 'pending') {
        result = await api.poll(slug)
      }

      if (result.status === 'connected') {
        await provision()
      } else if (result.status === 'error') {
        setError(copy.connectFailed)
      }

      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.connectFailed)
    } finally {
      setBusySlug(null)
    }
  }

  const disconnect = async (slug: string) => {
    const api = connectorsApi()

    if (!api) {
      return
    }

    setBusySlug(slug)
    setError(null)

    try {
      await api.disconnect(slug)
      await provision()
      await refreshAll()
    } catch (err) {
      setError(err instanceof Error ? err.message : copy.disconnectFailed)
    } finally {
      setBusySlug(null)
    }
  }

  const connectionBySlug = useMemo(() => {
    const map = new Map<string, DesktopComposioConnection>()

    for (const row of connections) {
      map.set(row.slug, row)
    }

    return map
  }, [connections])

  const visible = useMemo(() => {
    const items = [...(catalog ?? [])]
    const seen = new Set(items.map(item => item.slug))

    for (const row of connections) {
      if (seen.has(row.slug)) {
        continue
      }

      items.unshift({
        slug: row.slug,
        name: row.name,
        description: row.description || row.statusReason || '',
        logo: row.logo,
        category: row.category,
        featured: false,
        isNoAuth: false
      })
    }

    const q = search.trim().toLowerCase()

    if (!q) {
      return items
    }

    return items.filter(item => `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(q))
  }, [catalog, connections, search])

  const configured = Boolean(keyStatus?.configured)
  const showKeyForm = keyStatus !== null && (!configured || editingKey)

  const onRowAction = (slug: string, status: DesktopComposioStatus) => {
    if (status === 'connected') {
      void disconnect(slug)

      return
    }

    void connect(slug)
  }

  return (
    <div className="grid gap-3">
      {keyStatus === null ? <Skeleton className="h-20 rounded-xl" /> : null}

      {configured && !editingKey ? (
        <div className="flex flex-wrap items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          {copy.composioReady}
          {keyStatus?.hint ? <span>{keyStatus.hint}</span> : null}
          <Button onClick={() => setEditingKey(true)} size="sm" variant="text">
            {copy.changeKey}
          </Button>
          <Button onClick={() => setConfirmRemove(true)} size="sm" variant="text">
            {t.common.remove}
          </Button>
        </div>
      ) : null}

      {showKeyForm ? (
        <form
          className="grid gap-2 rounded-xl border border-(--ui-stroke-tertiary) p-3"
          onSubmit={event => {
            event.preventDefault()
            void saveKey()
          }}
        >
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">{configured ? copy.replaceKeyTitle : copy.keyTitle}</div>
            {configured ? (
              <Button
                onClick={() => {
                  setKeyDraft('')
                  setEditingKey(false)
                }}
                size="sm"
                type="button"
                variant="text"
              >
                {t.common.cancel}
              </Button>
            ) : null}
          </div>
          <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
            {configured ? copy.replaceKeyHelp : copy.keyHelp}
          </p>
          <div className="flex gap-2">
            <Input
              aria-label={copy.keyLabel}
              autoComplete="off"
              onChange={event => {
                setKeyDraft(event.target.value)

                if (error) {
                  setError(null)
                }
              }}
              placeholder={copy.keyPlaceholder}
              type="password"
              value={keyDraft}
            />
            <Button disabled={!keyDraft.trim() || savingKey} type="submit">
              {savingKey ? copy.savingKey : t.common.save}
            </Button>
          </div>
          <a
            className="inline-flex items-center gap-1 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary) underline-offset-2 hover:text-foreground hover:underline"
            href="https://dashboard.composio.dev"
            onClick={event => {
              event.preventDefault()
              void window.hermesDesktop?.openExternal('https://dashboard.composio.dev')
            }}
            rel="noreferrer"
          >
            {copy.getKey}
            <ExternalLink className="size-3" />
          </a>
        </form>
      ) : null}

      {error ? (
        <div
          className="rounded-lg bg-destructive/12 px-3 py-2 text-[length:var(--conversation-caption-font-size)] text-destructive"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      <input
        aria-label={copy.search}
        className="h-9 w-full rounded-lg border border-(--ui-stroke-tertiary) bg-transparent px-3 text-sm text-foreground placeholder:text-(--ui-text-tertiary) focus:outline-none"
        onChange={event => setSearch(event.target.value)}
        placeholder={copy.search}
        value={search}
      />

      <div className="min-h-64 overflow-hidden rounded-xl border border-(--ui-stroke-tertiary)">
        {!configured && keyStatus !== null ? (
          <EmptyState description={copy.keyRequired} title={copy.emptyTitle} />
        ) : catalog === null || (loading && catalog.length === 0) ? (
          <div className="grid gap-0">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton className="h-14 rounded-none" key={index} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState description={copy.noMatches} title={copy.emptyTitle} />
        ) : (
          visible.map((item, index) => {
            const connected = connectionBySlug.get(item.slug)
            const status = connected?.status || 'available'
            const busy = busySlug === item.slug

            return (
              <div
                className={cn(
                  'flex items-center gap-3 bg-(--ui-chat-bubble-background) px-4 py-3',
                  index > 0 && 'border-t border-(--ui-stroke-tertiary)'
                )}
                key={item.slug}
              >
                <ToolkitLogo logo={item.logo} name={item.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className="truncate">{item.name}</span>
                    {status === 'connected' ? <span aria-hidden="true" className="size-1.5 rounded-full bg-emerald-500" /> : null}
                  </div>
                  <div className="truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                    {item.description}
                  </div>
                </div>
                <Button
                  className="w-[92px]"
                  disabled={!configured || busy}
                  onClick={() => onRowAction(item.slug, status)}
                  size="sm"
                  variant={status === 'connected' ? 'secondary' : 'outline'}
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : actionLabel(status, copy)}
                </Button>
              </div>
            )
          })
        )}
      </div>

      {configured && cursor ? (
        <Button
          disabled={loading}
          onClick={() => {
            const api = connectorsApi()

            if (!api) {
              return
            }

            setLoading(true)
            void api
              .catalog({ search: debouncedSearch || undefined, cursor })
              .then(result => {
                setCatalog(current => [...(current ?? []), ...result.items])
                setCursor(result.nextCursor)
              })
              .catch(err => setError(err instanceof Error ? err.message : copy.loadFailed))
              .finally(() => setLoading(false))
          }}
          variant="secondary"
        >
          {copy.showMore}
        </Button>
      ) : null}

      <ConfirmDialog
        confirmLabel={t.common.remove}
        description={copy.removeKeyHelp}
        destructive
        onClose={() => setConfirmRemove(false)}
        onConfirm={removeKey}
        open={confirmRemove}
        title={copy.removeKeyTitle}
      />
    </div>
  )
}
