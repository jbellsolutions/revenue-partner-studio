import { useEffect, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { Button } from '@/components/ui/button'
import { OpenComputerButton } from './open-computer'
import { ComputerWindows } from './workspace-controls'

/** A desktop connection owns no remote agents. Disconnecting only closes the viewer. */
export function StudioComputerWindow() {
  const screen = useRef<HTMLDivElement>(null)
  const rfb = useRef<RFB | null>(null)
  const attempts = useRef(0)
  const [revision, setRevision] = useState(0)
  const [name, setName] = useState('Orgo computer')
  const [state, setState] = useState('Connecting')
  const [error, setError] = useState('')
  const [control, setControl] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const reconnect = () => {attempts.current = 0; setRevision(value => value + 1)}

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {if (event.key === 'Escape') setExpanded(false)}
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [])

  useEffect(() => {
    let disposed = false
    let failed = false
    let connection: RFB | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    setState('Connecting'); setError(''); setControl(false)
    const fail = (message: string) => {
      if (disposed || failed) return
      failed = true
      clearTimeout(timeout)
      connection?.disconnect()
      rfb.current = null
      setControl(false)
      if (attempts.current < 3) {
        const delay = 1000 * 2 ** attempts.current++
        setState('Reconnecting'); setError('Connection interrupted. Reconnecting to the same computer…')
        retry = setTimeout(() => {if (!disposed) setRevision(value => value + 1)}, delay)
      } else {setState('Disconnected'); setError(message + ' Use Reconnect to try again.')}
    }
    timeout = setTimeout(() => fail('The desktop did not respond.'), 30000)
    void (async () => {
      try {
        const result = await window.hermesDesktop?.orgoDesktop.getSession('default')
        if (disposed || failed) return
        if (!result?.ok) throw new Error(result && !result.ok ? result.error.message : 'Desktop connection is unavailable.')
        setName(result.computerName)
        document.title = result.computerName + ' — Studio'
        const {default: RFBClass} = await import('@novnc/novnc')
        if (disposed || failed || !screen.current) return
        connection = new RFBClass(screen.current, result.websocketUrl, {credentials: {password: result.password}, shared: true})
        connection.addEventListener('credentialsrequired', () => {if (!disposed && !failed) connection?.sendCredentials({password: result.password})})
        rfb.current = connection
        connection.scaleViewport = true
        connection.resizeSession = false
        connection.viewOnly = true
        connection.addEventListener('connect', () => {
          if (!disposed && !failed) {clearTimeout(timeout); setState('Connected'); setError('')}
        })
        connection.addEventListener('disconnect', () => fail('The desktop connection closed.'))
        connection.addEventListener('securityfailure', () => fail('Desktop authentication failed.'))
      } catch (e) {fail(e instanceof Error ? e.message : String(e))}
    })()
    const online = () => {if (!disposed) reconnect()}
    window.addEventListener('online', online)
    return () => {
      disposed = true; clearTimeout(timeout); clearTimeout(retry)
      window.removeEventListener('online', online)
      connection?.disconnect(); rfb.current = null
    }
  }, [revision])

  return <main className="flex h-dvh min-w-0 flex-col overflow-hidden bg-background text-foreground">
    <header className="shrink-0 border-b px-5 pb-3 pt-10" style={{WebkitAppRegion: 'drag'} as React.CSSProperties}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><h1 className="text-base font-semibold">{name}</h1><p className="text-xs text-muted-foreground" role="status">{state} · {control ? 'Manual control · Existing agents keep running' : 'View only'} · Same computer on reopen</p></div>
        <div className="flex flex-wrap gap-2" style={{WebkitAppRegion: 'no-drag'} as React.CSSProperties}>
          <Button size="sm" variant="secondary" disabled={state !== 'Connected'} onClick={() => {const next = !control; if (rfb.current) rfb.current.viewOnly = !next; setControl(next)}}>{control ? 'Return to view only' : 'Control desktop'}</Button>
          <Button size="sm" variant="ghost" onClick={reconnect}>Reconnect</Button>
          <Button size="sm" variant="ghost" onClick={() => {void window.hermesDesktop?.orgoDesktop.fitWindow().catch(e => setError(String(e)))}}>Fit app window</Button>
        </div>
      </div>
    </header>
    <div className="flex min-h-0 min-w-0 flex-1">
      <aside aria-label="Workspace navigation" className="w-52 max-w-[20%] shrink-0 overflow-y-auto border-r p-3">
        <p className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Workspace settings</p>
        <ComputerWindows />
        <div className="mt-3"><OpenComputerButton /></div>
      </aside>
      <section aria-label="Workspace" className="min-h-0 min-w-0 flex-1 overflow-y-auto p-6">
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Workspace</p>
        <h2 className="mt-2 text-xl font-semibold">{name}</h2>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-muted-foreground">This computer’s agents and conversations remain in AI Guy. Studio is connected to its desktop, shown at the top right.</p>
      </section>
      <aside aria-label="Computer panel" className="shrink-0 overflow-y-auto border-l bg-background p-4"
        style={expanded ? {position:'fixed',top:100,right:24,bottom:24,left:'max(180px, 20vw)',zIndex:20,borderWidth:1,borderRadius:12} : {width:'30vw',maxWidth:360,minWidth:200}}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Computer screen</h2>
          <span className="text-xs text-muted-foreground">{state === 'Connected' ? 'Live' : state}</span>
        </div>
        <section className="relative w-full min-w-0 overflow-hidden rounded-lg border bg-black" aria-label="Live Orgo desktop"
          style={{height:expanded ? '65vh' : undefined,aspectRatio:expanded ? undefined : '16 / 10',maxHeight:expanded ? undefined : 240}}>
          <div className="absolute inset-0 overflow-hidden" ref={screen} />
          {state !== 'Connected' && <div className="pointer-events-none absolute inset-0 grid place-content-center p-3 text-center text-xs text-white" role="alert">{error || state + '…'}</div>}
        </section>
        <p className="mt-3 truncate text-xs text-muted-foreground">{name}</p>
        <Button className="mt-3 w-full" size="sm" variant="secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Return to workspace' : 'Expand screen'}</Button>
      </aside>
    </div>
  </main>
}
