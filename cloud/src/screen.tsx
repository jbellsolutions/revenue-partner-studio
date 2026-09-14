import { memo, useEffect, useRef, useState } from 'react'
import { rpc } from './api'
export const Screen = memo(function Screen({
  computer,
  agent,
  enabled,
  agentName,
  computerName
}: {
  computer: string
  agent: string
  enabled: boolean
  agentName: string
  computerName: string
}) {
  const surface = useRef<HTMLDivElement>(null),
    rfb = useRef<any>(null),
    frame = useRef<HTMLElement>(null)
  const [controlling, setControlling] = useState(false)
  const [error, setError] = useState(''),
    [status, setStatus] = useState('Connecting'),
    [paused, setPaused] = useState(false),
    [attempt, setAttempt] = useState(0),
    [stopped, setStopped] = useState(false)
  useEffect(() => {
    let disposed = false
    let reconnect: ReturnType<typeof setTimeout> | undefined
    setError('')
    setStatus(enabled ? 'Connecting' : 'Unavailable')
    setPaused(false)
    if (!enabled || stopped) return
    void (async () => {
      try {
        const [info, module] = await Promise.all([
          rpc(computer, 'screen.open', { agentId: agent }),
          import('@novnc/novnc')
        ])
        if (disposed || !surface.current) return
        if (info.queued) {
          setStatus('Waiting')
          setError(
            `All four specialist screens are in use. Your place in the queue: ${info.position}. Chat stays available.`
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
        client.addEventListener('connect', () => !disposed && setStatus('Live'))
        client.addEventListener('credentialsrequired', () => client.sendCredentials({ password: info.password || '' }))
        client.addEventListener(
          'securityfailure',
          () => !disposed && setError('Desktop authentication failed. Reconnect to refresh it.')
        )
        client.addEventListener('disconnect', () => {
          if (!disposed) {
            setStatus('Disconnected')
            reconnect = setTimeout(() => setAttempt(v => v + 1), 1500)
          }
        })
      } catch (e) {
        if (!disposed) {
          setError(String((e as Error).message))
          setStatus('Unavailable')
          reconnect = setTimeout(() => setAttempt(v => v + 1), 2000)
        }
      }
    })()
    return () => {
      disposed = true
      clearTimeout(reconnect)
      rfb.current?.disconnect()
      rfb.current = null
    }
  }, [computer, agent, enabled, attempt, stopped])
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
          {status}
        </span>
      </div>
      <div className="studio-screen-frame">
        <div ref={surface} className={'screen-canvas' + (paused ? ' interactive' : ' watching')} />
        {status !== 'Live' && (
          <div className="screen-placeholder">
            <span className="screen-glyph">▱</span>
            <strong>
              {status === 'Connecting'
                ? 'Connecting to your screen'
                : enabled
                  ? status === 'Waiting'
                    ? 'Waiting for a screen'
                    : 'Screen disconnected'
                  : 'Screen setup needed'}
            </strong>
            <p>
              {error ||
                (enabled ? 'Your conversation stays connected.' : 'This computer needs its managed screen connector.')}
            </p>
            {enabled && (
              <button
                onClick={() => {
                  setStopped(false)
                  setAttempt(v => v + 1)
                }}
              >
                Reconnect screen
              </button>
            )}
            {status === 'Waiting' && !stopped && (
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
