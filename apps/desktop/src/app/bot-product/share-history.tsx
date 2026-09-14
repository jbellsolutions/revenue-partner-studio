import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Loader } from '@/components/ui/loader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useI18n } from '@/i18n/context'

interface ShareHistoryProps {
  profile: string
  sessionId: string
  onClose: () => void
  onOpenThread: (profile: string, id: string) => Promise<unknown>
}
interface ComputerTarget {
  name: string
  computerId: string
  current: boolean
  unreadable: boolean
}

export function ShareHistory({ profile, sessionId, onClose, onOpenThread }: ShareHistoryProps) {
  const { t } = useI18n()
  const copy = t.botWorkspace
  const [requestId] = useState(() => crypto.randomUUID())
  const [computers, setComputers] = useState<ComputerTarget[]>([])
  const [computerId, setComputerId] = useState('')
  const [agents, setAgents] = useState<string[]>([])
  const [targetProfile, setTargetProfile] = useState('')
  const [text, setText] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [targetsLoading, setTargetsLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ state: string; sessionId?: string } | null>(null)
  useEffect(() => {
    let disposed = false
    void Promise.all([
      window.hermesDesktop.orgoDesktop.previewHistory({ profile, sessionId }),
      window.hermesDesktop.orgoDesktop.listInstances()
    ])
      .then(([preview, instances]) => {
        if (disposed) {
          return
        }

        const unique = new Map<string, ComputerTarget>()

        for (const instance of instances) {
          if (instance.computerId && !instance.unreadable && (!unique.has(instance.computerId) || instance.current)) {
            unique.set(instance.computerId, instance)
          }
        }

        setComputers([...unique.values()])
        setComputerId(instances.find(instance => instance.current)?.computerId || '')
        setText(preview.text)
        setTruncated(preview.truncated)
      })
      .catch((e: Error) => {
        if (!disposed) {
          setError(e.message)
        }
      })
      .finally(() => {
        if (!disposed) {
          setLoading(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [profile, sessionId])
  useEffect(() => {
    let disposed = false
    setAgents([])
    setTargetProfile('')

    if (!computerId) {
      return
    }

    setTargetsLoading(true)
    setError('')
    void window.hermesDesktop.orgoDesktop
      .historyTargets(computerId)
      .then(response => {
        if (!disposed) {
          setAgents(response.profiles)
        }
      })
      .catch((e: Error) => {
        if (!disposed) {
          setError(e.message)
        }
      })
      .finally(() => {
        if (!disposed) {
          setTargetsLoading(false)
        }
      })

    return () => {
      disposed = true
    }
  }, [computerId])

  const send = async () => {
    setAttempted(true)
    setBusy(true)
    setError('')

    try {
      setResult(
        await window.hermesDesktop.orgoDesktop.shareHistory({
          sourceProfile: profile,
          sourceSessionId: sessionId,
          targetComputerId: computerId,
          targetProfile,
          text,
          requestId
        })
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const target = computers.find(computer => computer.computerId === computerId)
  const completed = result?.state === 'TASK_STATE_COMPLETED'

  const open = async () => {
    try {
      if (target?.current && result?.sessionId) {
        await onOpenThread(targetProfile, result.sessionId)
      } else if (target) {
        await window.hermesDesktop.orgoDesktop.openInstance(target.name)
      }

      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog
      onOpenChange={value => {
        if (!value && !busy) {
          onClose()
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{copy.shareHistory}</DialogTitle>
          <DialogDescription>{copy.shareNotice}</DialogDescription>
        </DialogHeader>
        {loading ? (
          <Loader />
        ) : (
          <>
            <Select disabled={attempted} onValueChange={setComputerId} value={computerId}>
              <SelectTrigger aria-label={copy.targetComputer}>
                <SelectValue placeholder={copy.targetComputer} />
              </SelectTrigger>
              <SelectContent>
                {computers.map(computer => (
                  <SelectItem key={computer.computerId} value={computer.computerId}>
                    {computer.name || copy.primary}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select disabled={attempted || targetsLoading} onValueChange={setTargetProfile} value={targetProfile}>
              <SelectTrigger aria-label={copy.targetAgent}>
                <SelectValue placeholder={copy.targetAgent} />
              </SelectTrigger>
              <SelectContent>
                {agents
                  .filter(agent => !(target?.current && agent === profile))
                  .map(agent => (
                    <SelectItem key={agent} value={agent}>
                      {agent}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {truncated && <p className="text-xs text-muted-foreground">{copy.partialHistory}</p>}
            <Textarea
              aria-label={copy.sharePreview}
              disabled={attempted}
              maxLength={20000}
              onChange={event => setText(event.target.value)}
              rows={10}
              value={text}
            />
          </>
        )}
        {busy && <Loader />}
        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}
        {result && (
          <p className="text-sm" role="status">
            {completed ? copy.shared : copy.deliveryPending}
          </p>
        )}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} variant="ghost">
            {t.common.close}
          </Button>
          {completed ? (
            <Button onClick={() => void open()}>{copy.openShared}</Button>
          ) : (
            <Button
              disabled={attempted || loading || targetsLoading || !targetProfile || !computerId || !text.trim()}
              onClick={() => void send()}
            >
              {copy.shareNow}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
