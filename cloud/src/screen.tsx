import { memo, useEffect, useRef, useState } from 'react'
import { rpc } from './api'
export const Screen = memo(function Screen({
  computer,
  agent,
  enabled,
  agentName,
  computerName,
  diagnostics = false,
  onRepair
}: {
  computer: string
  agent: string
  enabled: boolean
  agentName: string
  computerName: string
  diagnostics?: boolean
  onRepair?: () => void
}) {
  const surface = useRef<HTMLDivElement>(null),
    rfb = useRef<any>(null),
    frame = useRef<HTMLElement>(null)
  const [controlling, setControlling] = useState(false)
  const [error, setError] = useState(''),
    [status, setStatus] = useState('Starting'),
    [paused, setPaused] = useState(false),
    [attempt, setAttempt] = useState(0),
    [stopped, setStopped] = useState(false)
  const failures = useRef(0)
  const [screenInfo, setScreenInfo] = useState<any>(null)
  useEffect(() => {
    let disposed = false
    let reconnect: ReturnType<typeof setTimeout> | undefined
    setStatus(previous => enabled ? previous === 'Waiting for capacity' ? previous : 'Starting' : 'Unavailable')
    if (!enabled || stopped) return
    void (async () => {
      try {
        if (diagnostics) {
          const health = await rpc(computer, 'screen.status', { agentId: agent })
          if (disposed) return
          setScreenInfo(health)
          if (health.state === 'repair_needed') {
            setStatus('Repair needed'); setError(health.message); return
          }
        }
        const [info, module] = await Promise.all([
          rpc(computer, 'screen.open', { agentId: agent }),
          import('@novnc/novnc')
        ])
        if (disposed || !surface.current) return
        if (info.queued) {
          setStatus('Waiting for capacity')
          setError(
            `All ${info.capacity?.specialists || 4} specialist screens are assigned. Your place in the queue: ${info.position}. Chat stays available.`
          )
          reconnect = setTimeout(() => setAttempt(v => v + 1), 2000)
          return
        }
        const url = new URL(info.url, location.origin)
        url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
        const client = new module.default(surface.current, url.href, { credentials: { password: info.password || '' } })
        rfb.current = client
        client.showDotCursor = true
        client.scaleViewport = true
        client.resizeSession = false
        client.viewOnly = !info.paused
        client.qualityLevel = 6
        client.compressionLevel = 2
        setPaused(!!info.paused)
        client.addEventListener('connect', () => { if (!disposed) { failures.current = 0; setError(''); setStatus('Live') } })
        client.addEventListener('credentialsrequired', () => client.sendCredentials({ password: info.password || '' }))
        client.addEventListener(
          'securityfailure',
          () => { if (!disposed) { failures.current = 3; setStatus('Repair needed'); setError('Desktop authentication failed. Repair the computer connection to refresh its credentials.') } }
        )
        client.addEventListener('disconnect', () => {
          if (!disposed) {
            failures.current += 1
            setStatus(failures.current >= 3 ? 'Repair needed' : 'Disconnected')
            if (failures.current < 3) reconnect = setTimeout(() => setAttempt(v => v + 1), 1500)
          }
        })
      } catch (e) {
        if (!disposed) {
          setError(String((e as Error).message))
          failures.current += 1
          setStatus(failures.current >= 3 ? 'Repair needed' : 'Disconnected')
          if (failures.current < 3) reconnect = setTimeout(() => setAttempt(v => v + 1), 2000)
        }
      }
    })()
    return () => {
      disposed = true
      clearTimeout(reconnect)
      rfb.current?.disconnect()
      rfb.current = null
    }
  }, [computer, agent, enabled, attempt, stopped, diagnostics])
  useEffect(
    () => () => {
      void rpc(computer, 'screen.cancel_wait', { agentId: agent }).catch(() => {})
    },
    [computer, agent]
  )
  async function control() {
    if (controlling) return
    setControlling(true)
    try {
      const next = !paused
      const current = rfb.current
      await rpc(computer, next ? 'screen.pause' : 'screen.resume', { agentId: agent })
      if (rfb.current !== current) return
      setPaused(next)
      if (rfb.current) rfb.current.viewOnly = !next
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setControlling(false)
    }
  }
  return (
    <section ref={frame} className="studio-screen-section">
      <div className="studio-screen-heading">
        <strong>{computerName}</strong>{' '}
        <span>
          <i className={status === 'Live' ? 'dot live' : 'dot'} />
          {status === 'Live' && paused ? 'You have control' : status}
        </span>
      </div>
      <div className="studio-screen-frame">
        <div ref={surface} className={'screen-canvas' + (paused ? ' interactive' : ' watching')} />
        {status !== 'Live' && (
          <div className="screen-placeholder">
            <span className="screen-glyph">▱</span>
            <strong>
              {status === 'Starting'
                ? 'Connecting to your screen'
                : enabled
                  ? status === 'Waiting for capacity'
                    ? 'Waiting for a screen'
                    : status === 'Repair needed' ? 'Screen needs repair' : 'Screen disconnected'
                  : 'Screen setup needed'}
            </strong>
            <p>
              {error ||
                (enabled ? 'Your conversation stays connected.' : 'This computer needs its managed screen connector.')}
            </p>
            {enabled && (
              <button
                onClick={() => {
                  failures.current = 0
                  setError('')
                  setStopped(false)
                  setAttempt(v => v + 1)
                }}
              >
                Reconnect screen
              </button>
            )}
            {status === 'Repair needed' && onRepair && <button onClick={onRepair}>Repair computer connection</button>}
            {status === 'Waiting for capacity' && !stopped && (
              <button
                onClick={() => {
                  setStopped(true)
                  setStatus('Unavailable')
                  void rpc(computer, 'screen.cancel_wait', { agentId: agent }).catch(e => setError(e.message))
                }}
              >
                Cancel waiting
              </button>
            )}
          </div>
        )}
      </div>
      {error && status === 'Live' && (
        <p className="connection-error" role="alert">
          {error}
        </p>
      )}
      {status === 'Waiting for capacity' && screenInfo?.occupied && <details className="screen-owners"><summary>Which agents have screens?</summary>
        {screenInfo.occupied.filter((owner: any) => owner.agentId !== 'default').map((owner: any) => <p key={owner.agentId}>
          {owner.agentId.replaceAll('-', ' ')} · {owner.humanControl ? 'Human control' : owner.working ? 'Working' : owner.viewer ? 'Being watched' : owner.legacyOwnership ? 'Ownership needs review' : 'Finishing screen lease'}
        </p>)}
      </details>}
      <p className="studio-screen-caption">
        {agentName} ·{' '}
        {status !== 'Live'
          ? 'Screen reconnecting'
          : paused
            ? 'You have control · automation paused'
            : 'Watching agent workspace'}
      </p>
      <div className="studio-screen-controls">
        <button disabled={status !== 'Live' || controlling} onClick={() => void control()}>
          {controlling ? 'Updating control…' : paused ? 'Resume agent' : 'Take control'}
        </button>
        <button
          disabled={status !== 'Live'}
          onClick={() =>
            void (document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen())?.catch(
              e => setError(e.message)
            )
          }
        >
          Expand ↗
        </button>
      </div>
    </section>
  )
})
