import { trustedOrigins } from './origins.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { WebSocket, WebSocketServer } from 'ws'
import { Store, hash } from './store.ts'
import { ControlStore } from './control-store.ts'
import { Computers } from './computers.ts'
import { Transfers } from './transfers.ts'
import {localSetup,localDownload} from './local-setup.ts'
import { publicWebsite, type PublicWebsiteOptions } from './public-website.ts'

type Options = {
  qualificationStatus?: () => unknown
  store: Store
  password: string
  origin: string
  allowedOrigins?: string[]
  publicDir?: string
  website?: PublicWebsiteOptions
  control?: ControlStore
  setupDir?: string
}
type Pending = {
  computer: string
  socket: WebSocket
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}
type Viewer = { id: string; socket: WebSocket; computer: string; cursor: number; replaying: boolean; buffer: any[] }
type Client = WebSocket & { alive?: boolean; sessionToken?: string }
const METHODS = new Set([
  'connection.status', 'screen.status', 'screen.repair', 'screen.capacity', 'profile.settings.get', 'profile.settings.update',
  'models.options', 'models.select', 'models.status', 'skills.update', 'endpoints.configure', 'endpoints.list',
  'explorer.roots','explorer.add','explorer.list','explorer.read','explorer.folders','explorer.choose','library.profiles',
  'status',
  'agents.list',
  'agents.create',
  'agents.describe',
  'agents.update',
  'files.begin',
  'files.chunk',
  'files.commit',
  'files.read',
  'files.list',
  'providers.keys',
  'providers.configure',
  'providers.check',
  'sessions.list',
  'sessions.archives',
  'sessions.open',
  'sessions.history',
  'sessions.message',
  'chat.send',
  'chat.cancel',
  'tasks.list',
  'tasks.evidence',
  'tasks.cancel',
  'tasks.reconcile',
  'tasks.resume',
  'settings.get',
  'settings.update',
  'skills.list',
  'import.apply',
  'import.preview',
  'import.begin',
  'import.chunk',
  'import.commit',
  'screen.open',
  'screen.cancel_wait',
  'screen.authorize',
  'screen.stop',
  'screen.pause',
  'screen.resume',
  'providers.list',
  'providers.begin',
  'providers.status',
  'providers.submit',
  'peers.list',
  'peer.send',
  'peer.status',
  'approvals.list',
  'approvals.resolve'
])
export function createGateway(options: Options) {
  const { store, origin } = options
  const website = publicWebsite(options.website)
  if (website?.matches({ headers: { host: new URL(origin).host } } as IncomingMessage))
    throw new Error('Public website and private Studio must use different hosts.')
  const control=options.control||new ControlStore(store,randomBytes(32))
  if (options.password.length < 16) throw new Error('Studio owner password must contain at least 16 characters.')
  const salt = randomBytes(16),
    passwordHash = scryptSync(options.password, salt, 64)
  const connectors = new Map<string, WebSocket>(),
    viewers = new Set<Viewer>(),
    pending = new Map<string, Pending>()
  const tickets = new Map<
    string,
    { computer: string; agent: string; expires: number; browser?: WebSocket; remote?: WebSocket }
  >()
  const failures = new Map<string, { count: number; since: number }>()
  const sessions = new Map<WebSocket, string>()
  const revoke = (value: string) => {
    for (const [ws, t] of sessions) if (t === value) ws.close(1008, 'Session ended')
  }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 70 * 1024 * 1024, perMessageDeflate: false })
  const token = (req: IncomingMessage) => /(?:^|;\s*)studio_session=([^;]+)/.exec(req.headers.cookie || '')?.[1] || ''
  const authenticated = (req: IncomingMessage) => store.authenticated(token(req))
  const origins = trustedOrigins(origin, options.allowedOrigins)
  const sameOrigin = (req: IncomingMessage) => !!req.headers.origin && origins.has(req.headers.origin)
  const send = (ws: WebSocket, value: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      if (ws.bufferedAmount > 8 * 1024 * 1024) {
        ws.close(1013, 'Reconnect to catch up')
        return
      }
      ws.send(JSON.stringify(value))
    }
  }
  const broadcast = (computer: string, value: unknown) => {
    for (const v of viewers)
      if (v.computer === computer) {
        if (v.replaying && (value as any)?.type === 'event') {
          v.buffer.push(value)
          if (v.buffer.length > 2000) v.socket.close(1013, 'Reconnect to catch up')
        } else send(v.socket, value)
      }
  }
  const directory=()=>control.computers().map((c:any)=>({...c,online:connectors.has(c.id)}))
  const publishDirectory=()=>{for(const v of viewers)send(v.socket,{type:'directory',computerId:v.computer,computers:directory()})}
  const publishPermissions=()=>{for(const [id,ws] of connectors)send(ws,{type:'permissions',computerId:id,proof:control.permissions(id)})}
  const computers=new Computers(control,origin,options.setupDir||path.resolve('dist/setup'),id=>connectors.has(id),publishDirectory)
  computers.start()
  const rpc = (
    computer: string,
    method: string,
    params: unknown,
    requestId = randomBytes(16).toString('hex')
  ): Promise<any> => {
    const socket = connectors.get(computer)
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('This computer is offline. Your request was not sent.'))
    const id = randomBytes(16).toString('hex')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          pending.delete(id)
          reject(new Error('The computer did not acknowledge in time. Check task status before retrying.'))
        },
        ['import.commit','library.export'].includes(method) ? 660000 : method === 'import.apply' ? 120000 : 45000
      )
      pending.set(id, { computer, socket, resolve, reject, timer })
      send(socket, { type: 'request', id, computerId: computer, requestId, method, params })
    })
  }
  const transfers=new Transfers(control,rpc)
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > 64 * 1024 * 1024) throw new Error('Upload exceeds 64 MB; import fewer profiles at a time.')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}')
  }
  const server = createServer(async (req, res) => {
    if (website?.matches(req)) return website.serve(req, res)
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
    )
    const url = new URL(req.url || '/', origin)
    try {
      if (url.pathname === '/health') return json(res, 200, { ok: true, protocol: 1 })
      const artifact=/^\/setup\/artifacts\/([A-Za-z0-9_-]{43})\/(runtime\.tar\.gz|runtime\.sha256)$/.exec(url.pathname)
      if(artifact&&req.method==='GET') {
        const file=computers.artifact(artifact[1],artifact[2])
        res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','no-store')
        res.end(await readFile(file));return
      }
      if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Request origin was not accepted.' })
      if(url.pathname==='/api/pairing/exchange'&&req.method==='POST') {
        const b=await body(req)
        if(typeof b.computerId!=='string'||typeof b.code!=='string'||!['linux','darwin'].includes(b.platform))return json(res,400,{error:'Invalid pairing request.'})
        if(connectors.has(b.computerId))return json(res,409,{error:'This computer already has a live connector.'})
        return json(res,200,control.exchange(b.computerId,b.code,b.platform))
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress || '',
          now = Date.now()
        let rate = failures.get(key)
        if (!rate || now - rate.since > 300000) {
          rate = { count: 0, since: now }
          failures.set(key, rate)
        }
        if (rate.count >= 10) return json(res, 429, { error: 'Too many attempts. Try again in five minutes.' })
        const b = await body(req)
        rate.count++
        if (
          typeof b.password !== 'string' ||
          b.password.length > 1024 ||
          !timingSafeEqual(passwordHash, scryptSync(b.password, salt, 64))
        )
          return json(res, 401, { error: 'Password not recognized.' })
        failures.delete(key)
        res.setHeader(
          'Set-Cookie',
          `studio_session=${store.login()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.startsWith('https:') ? '; Secure' : ''}`
        )
        return json(res, 200, { ok: true })
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authenticated(req)) return json(res, 401, { error: 'Sign in to Studio.' })
        if (url.pathname === '/api/qualification' && req.method === 'GET')
          return json(res, 200, options.qualificationStatus?.() || { state: 'not_started' })
        if (url.pathname === '/api/logout' && req.method === 'POST') {
          store.logout(token(req))
          revoke(token(req))
          res.setHeader('Set-Cookie', 'studio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
          return json(res, 200, { ok: true })
        }
        if (url.pathname === '/api/computers' && req.method === 'GET')
          return json(res, 200, { computers: directory() })
        if(url.pathname==='/api/orgo'&&req.method==='GET')return json(res,200,computers.state())
        if(url.pathname==='/api/orgo'&&req.method==='POST')return json(res,200,await computers.saveKey((await body(req)).key))
        if(url.pathname==='/api/orgo/refresh'&&req.method==='POST'){await computers.refresh();return json(res,200,computers.state())}
        if(url.pathname==='/api/connections/install'&&req.method==='POST')return json(res,202,await computers.connect(String((await body(req)).computerId||'')))
        if(url.pathname==='/api/connections/local'&&req.method==='POST') {
          const b=await body(req)
          // Preparing a repair leaves the live connector and its credential intact.
          // The Mac updater checks accepted work before replacing owned components.
          const result=localSetup(control,origin,options.setupDir||path.resolve('dist/setup'),b)
          publishDirectory();return json(res,201,result)
        }
        const localInstaller=/^\/api\/connections\/local\/([a-f0-9-]{36})\/download$/.exec(url.pathname)
        if(localInstaller&&req.method==='GET'){
          const data=localDownload(control,options.setupDir||path.resolve('dist/setup'),localInstaller[1])
          res.setHeader('Content-Type','application/zip');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Disposition','attachment; filename="Connect Revenue Partner Studio.zip"');res.end(data);return
        }
        if(url.pathname==='/api/grants'&&req.method==='GET')return json(res,200,{grants:control.grants()})
        if(url.pathname==='/api/grants'&&req.method==='POST'){const grant=control.grant(await body(req));publishPermissions();return json(res,201,grant)}
        if(url.pathname==='/api/grants/revoke'&&req.method==='POST'){control.revoke(String((await body(req)).id));publishPermissions();return json(res,200,{ok:true})}
        if(url.pathname==='/api/grants/check'&&req.method==='POST'){
          const b=await body(req),grant=control.permission(b.source,b.actor,b.target,b.agent)
          if(!grant)return json(res,403,{error:'This direction is not allowed. Save a trusted connection first.'})
          if(!connectors.has(b.source)||!connectors.has(b.target))return json(res,409,{error:'Both computers must be connected to check this connection.'})
          const [source,target]=await Promise.all([rpc(b.source,'agents.list',{}),rpc(b.target,'agents.list',{})])
          if(!source.agents.some((a:any)=>a.id===b.actor)||!target.agents.some((a:any)=>a.id===b.agent))return json(res,409,{error:'One of these profiles is no longer available. Choose its current profile.'})
          if(!control.permission(b.source,b.actor,b.target,b.agent))return json(res,403,{error:'This permission expired or was revoked during the check.'})
          return json(res,200,{ok:true,message:'Permission verified; both agents are reachable. No task was sent and no permissions were changed.'})
        }
        if(url.pathname==='/api/transfers'&&req.method==='GET')return json(res,200,{transfers:transfers.list()})
        if(url.pathname==='/api/transfers'&&req.method==='POST')return json(res,202,transfers.start(await body(req)))
        if(url.pathname==='/api/transfers/apply'&&req.method==='POST')return json(res,202,transfers.apply(String((await body(req)).id)))
        if(url.pathname==='/api/transfers/retry'&&req.method==='POST')return json(res,202,transfers.retry(String((await body(req)).id)))
        if (url.pathname === '/api/computers' && req.method === 'POST') {
          const b = await body(req)
          // Older clients can still register a computer, but setup now completes
          // through the installer rather than handing out a reusable secret.
          const c=store.addComputer(String(b.id || ''), String(b.name || ''))
          return json(res, 201, {id:c.id,name:c.name,state:'setup_required'})
        }
        const match = /^\/api\/computers\/([^/]+)\/rpc$/.exec(url.pathname)
        if (match && req.method === 'POST') {
          const computer = decodeURIComponent(match[1])
          if (!store.computers().some(c => c.id === computer)) return json(res, 404, { error: 'Unknown computer.' })
          const b = await body(req)
          if (!METHODS.has(b.method)) return json(res, 400, { error: 'Unsupported operation.' })
          if (b.params?.computerId && b.params.computerId !== computer)
            return json(res, 409, { error: 'Computer identity mismatch.' })
          if (b.method === 'peers.list')
            return json(res, 200, { computers: store.computers().map(c => ({ ...c, online: connectors.has(c.id) })) })
          const result = await rpc(computer, b.method, b.params || {}, b.requestId)
          if (b.method === 'screen.open' && !result.queued) {
            const ticket = randomBytes(24).toString('hex')
            tickets.set(ticket, { computer, agent: b.params.agentId, expires: Date.now() + 30000 })
            return json(res, 200, { ...result, url: `/api/screens/${ticket}` })
          }
          return json(res, 200, result)
        }
        return json(res, 404, { error: 'Not found.' })
      }
      if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed.' })
      const root = path.resolve(options.publicDir || 'dist/public')
      let file = path.resolve(root, '.' + url.pathname)
      if (!file.startsWith(root + path.sep)) file = path.join(root, 'index.html')
      try {
        if (!(await stat(file)).isFile()) throw new Error()
      } catch {
        file = path.join(root, 'index.html')
      }
      const ext = path.extname(file),
        mime: Record<string, string> = {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.png': 'image/png',
          '.svg': 'image/svg+xml',
          '.woff2': 'font/woff2'
        }
      res.setHeader('Content-Type', mime[ext] || 'application/octet-stream')
      res.setHeader('Cache-Control', ext === '.html' ? 'no-cache' : 'public, max-age=3600')
      res.end(await readFile(file))
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : 'Operation failed.' })
    }
  })
  server.on('upgrade', (req, socket, head) => {
    if (website?.matches(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const url = new URL(req.url || '/', origin),
      computer = url.searchParams.get('computerId') || ''
    const bearer = (req.headers.authorization || '').replace(/^Bearer /, '')
    const remote = url.pathname === '/connect' || url.pathname.startsWith('/connect/screen/')
    if (remote ? !store.connector(computer, bearer) : !authenticated(req) || !sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    if (!remote && url.pathname !== '/api/events' && !url.pathname.startsWith('/api/screens/')) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ;(ws as Client).alive = true
      ws.on('pong', () => {
        ;(ws as Client).alive = true
      })
      if (!remote) {
        sessions.set(ws, token(req))
        ws.on('close', () => sessions.delete(ws))
      }
      if (url.pathname === '/connect') {
        if (connectors.has(computer)) {
          ws.close(1008, 'A connector already owns this computer')
          return
        }
        connectors.set(computer, ws)
        store.db.prepare('UPDATE computers SET last_seen=? WHERE id=?').run(Date.now(),computer)
        publishDirectory()
        publishPermissions()
        for (const [id, c] of connectors)
          send(c, {
            type: 'peers',
            computerId: id,
            computers: store.computers().map(item => ({ ...item, online: connectors.has(item.id) }))
          })
        broadcast(computer, { type: 'connection', computerId: computer, online: true })
        send(ws, { type: 'hello', computerId: computer, protocol: 1 })
        for (const v of viewers)
          if (v.computer === computer) {
            v.replaying = true
            v.buffer = []
            send(ws, { type: 'replay', after: v.cursor, viewerId: v.id })
          }
        ws.on('message', raw => {
          try {
            const m = JSON.parse(raw.toString())
            if (m.computerId !== computer) throw new Error('Identity mismatch')
            if (m.type === 'response') {
              const p = pending.get(m.id)
              if (p && p.socket === ws) {
                clearTimeout(p.timer)
                pending.delete(m.id)
                'error' in m
                  ? p.reject(
                      new Error(m.error || 'The computer could not complete this request. Reconnect and try again.')
                    )
                  : p.resolve(m.result)
              }
            }
            if (m.type === 'event') {
              broadcast(computer, m)
            }
            if (m.type === 'replay.event' || m.type === 'replay.complete') {
              for (const v of viewers)
                if (v.computer === computer && v.id === m.viewerId) {
                  if (m.type === 'replay.event') {
                    send(v.socket, { ...m, type: 'event', replay: true })
                  } else {
                    v.replaying = false
                    for (const event of v.buffer) send(v.socket, event)
                    v.buffer = []
                    send(v.socket, { type: 'replay.complete', computerId: computer })
                  }
                }
            }
            if (m.type === 'peer.request') {
              const target = String(m.targetComputerId || '')
              if (
                !store.computers().some(c => c.id === target) ||
                !['agents.list', 'a2a.receive', 'a2a.status'].includes(m.method)
              ) {
                send(ws, { type: 'peer.response', id: m.id, computerId: computer, error: 'Peer route not authorized' })
                return
              }
              let authorization:unknown
              if(m.method==='a2a.receive') {
                const actor=String(m.params?.sourceAgentId||''),agent=String(m.params?.agentId||''),request=String(m.requestId||'')
                const grant=control.permission(computer,actor,target,agent)
                if(!grant){
                  control.audit('delegate:'+actor+'>'+agent,computer,target,request,'denied')
                  send(ws,{type:'peer.response',id:m.id,computerId:computer,error:'TRUST_REQUIRED: Save a trusted connection between these agents in Studio.'});return
                }
                const digest=hash(JSON.stringify({envelope:m.params.envelope,hops:m.params.hops}))
                const previous=store.db.prepare('SELECT * FROM peer_receipts WHERE source=? AND request=?').get(computer,request) as any
                if(previous&&(previous.target!==target||previous.agent!==agent||previous.actor!==actor||previous.digest!==digest)){
                  send(ws,{type:'peer.response',id:m.id,computerId:computer,error:'Peer request identity belongs to different work.'});return
                }
                store.db.prepare('INSERT OR IGNORE INTO peer_receipts(source,request,target,agent,actor,digest,grant_id) VALUES(?,?,?,?,?,?,?)').run(computer,request,target,agent,actor,digest,grant.id)
                authorization=control.sign(target,{source:computer,actor,target,agent,request,grant:grant.id,envelopeHash:hash(JSON.stringify(m.params.envelope)),hops:m.params.hops??0,expires:Date.now()+30000})
                control.audit('delegate:'+actor+'>'+agent,computer,target,request,'allowed')
              }
              void rpc(target, m.method, { ...m.params, sourceComputerId: computer,authorization }, m.requestId)
                .then(result => send(ws, { type: 'peer.response', id: m.id, computerId: computer, result }))
                .catch(e => send(ws, { type: 'peer.response', id: m.id, computerId: computer, error: e.message }))
            }
            if (m.type === 'peers.list')
              send(ws, {
                type: 'peers',
                computerId: computer,
                computers: store.computers().map(c => ({ ...c, online: connectors.has(c.id) }))
              })
          } catch {
            ws.close(1008, 'Invalid connector frame')
          }
        })
        ws.on('close', () => {
          if (connectors.get(computer) === ws) connectors.delete(computer)
          publishDirectory()
          for (const [id, c] of connectors)
            send(c, {
              type: 'peers',
              computerId: id,
              computers: store.computers().map(item => ({ ...item, online: connectors.has(item.id) }))
            })
          broadcast(computer, { type: 'connection', computerId: computer, online: false })
          for (const [id, p] of pending)
            if (p.socket === ws) {
              clearTimeout(p.timer)
              pending.delete(id)
              p.reject(new Error('Connection interrupted. Check the saved task before retrying.'))
            }
        })
      } else if (url.pathname === '/api/events') {
        if (!store.computers().some(c => c.id === computer)) {
          ws.close(1008, 'Unknown computer')
          return
        }
        const v: Viewer = {
          id: randomBytes(16).toString('hex'),
          socket: ws,
          computer,
          replaying: true,
          buffer: [],
          cursor: Math.max(0, Number(url.searchParams.get('after')) || 0)
        }
        viewers.add(v)
        send(ws, { type: 'connection', computerId: computer, online: connectors.has(computer) })
        const remoteSocket = connectors.get(computer)
        if (remoteSocket) send(remoteSocket, { type: 'replay', after: v.cursor, viewerId: v.id })
        ws.on('message', raw => {
          try {
            const m = JSON.parse(raw.toString())
            if (m.type === 'cursor' && Number.isSafeInteger(m.seq)) v.cursor = Math.max(v.cursor, m.seq)
          } catch {}
        })
        ws.on('close', () => viewers.delete(v))
      } else {
        const ticket = url.pathname.split('/').pop() || '',
          entry = tickets.get(ticket)
        if (
          !entry ||
          entry.expires < Date.now() ||
          (remote && entry.computer !== computer) ||
          (remote ? entry.remote : entry.browser)
        ) {
          ws.close(1008, 'Screen ticket expired or already used')
          return
        }
        if (remote) entry.remote = ws
        else {
          entry.browser = ws
          const c = connectors.get(entry.computer)
          if (!c) {
            ws.close(1013, 'Computer offline')
            return
          }
          send(c, { type: 'screen.connect', computerId: entry.computer, agentId: entry.agent, ticket })
        }
        const queue: Buffer[] = []
        let bytes = 0
        ws.on('message', (data, isBinary) => {
          const other = remote ? entry.browser : entry.remote
          if (other?.readyState === WebSocket.OPEN) {
            if (other.bufferedAmount > 4 * 1024 * 1024) {
              ws.close(1013)
              return
            }
            other.send(data, { binary: isBinary })
          } else {
            bytes += Buffer.byteLength(data as Buffer)
            if (bytes > 1024 * 1024) {
              ws.close(1013)
              return
            }
            queue.push(Buffer.from(data as Buffer))
          }
        })
        const flush = setInterval(() => {
          const other = remote ? entry.browser : entry.remote
          if (other?.readyState === WebSocket.OPEN) {
            while (queue.length) other.send(queue.shift()!, { binary: true })
            clearInterval(flush)
          }
        }, 20)
        ws.on('close', () => {
          clearInterval(flush)
          tickets.delete(ticket)
          ;(remote ? entry.browser : entry.remote)?.close()
        })
      }
    })
  })
  const heartbeat = setInterval(() => {
    publishPermissions()
    for (const client of wss.clients) {
      const c = client as Client
      if (sessions.has(c) && !store.authenticated(sessions.get(c)!)) {
        c.close(1008, 'Session expired')
        continue
      }
      if (c.alive === false) {
        c.terminate()
        continue
      }
      c.alive = false
      c.ping()
    }
    for (const [k, t] of tickets) if (t.expires < Date.now() && !t.browser && !t.remote) tickets.delete(k)
  }, 2000)
  return {
    server,
    store,
    rpc,
    connectors,
    control,
    computers,
    close: async () => {
      computers.close()
      transfers.close()
      clearInterval(heartbeat)
      for (const p of pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Gateway stopping'))
      }
      pending.clear()
      for (const ws of wss.clients) ws.terminate()
      await Promise.all([
        new Promise<void>(resolve => wss.close(() => resolve())),
        new Promise<void>(resolve => server.close(() => resolve()))
      ])
      store.close()
    }
  }
}
