import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { Store } from '../server/store.ts'
import { createGateway } from '../server/gateway.ts'
const A = '10000000-0000-4000-8000-000000000001',
  B = '10000000-0000-4000-8000-000000000002'
const origin = 'http://studio.test',
  password = 'a-test-password-long-enough'
async function fixture(t: any, allowedOrigins: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-gateway-'))
  const store = new Store(join(dir, 'state.db'))
  const a = store.addComputer(A, 'Same name'),
    b = store.addComputer(B, 'Same name')
  const gateway = createGateway({ store, password, origin, allowedOrigins, setupDir: dir })
  gateway.server.listen(0, '127.0.0.1')
  await once(gateway.server, 'listening')
  const url = 'http://127.0.0.1:' + (gateway.server.address() as any).port
  t.after(async () => {
    await gateway.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const login = await fetch(url + '/api/login', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  })
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const post = (route: string, body: any, override = {}) =>
    fetch(url + route, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', ...override },
      body: JSON.stringify(body)
    })
  async function ws(route: string, headers: any) {
    const socket = new WebSocket(url.replace('http:', 'ws:') + route, { headers })
    const messages: any[] = []
    socket.on('message', r => messages.push(JSON.parse(r.toString())))
    await once(socket, 'open')
    return { socket, messages }
  }
  return { gateway, url, cookie, post, ws, a, b, store, dir }
}
async function until(fn: () => any) {
  for (let i = 0; i < 200; i++) {
    const result = fn()
    if (result) return result
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('Expected event not received')
}
test('owner authentication, CSRF and connector identity are enforced', async t => {
  const f = await fixture(t)
  assert.equal((await fetch(f.url + '/api/computers')).status, 401)
  assert.equal((await f.post('/api/computers', { id: A, name: 'x' }, { Origin: 'https://untrusted.test' })).status, 403)
  assert.equal(
    (await f.post('/api/computers/' + A + '/rpc', { method: 'agents.list', params: { computerId: B } })).status,
    409
  )
  const socket = new WebSocket(f.url.replace('http:', 'ws:') + '/connect?computerId=' + B, {
    headers: { Authorization: 'Bearer ' + f.a.token }
  })
  socket.on('error', () => {})
  const [response] = await once(socket, 'unexpected-response') // first argument is request
  assert.ok(response)
  socket.terminate()
  assert.equal(f.gateway.connectors.size, 0)
})
test('identical agent names route to the owning computer and stable request IDs survive relay', async t => {
  const f = await fixture(t)
  const ca = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  const cb = await f.ws('/connect?computerId=' + B, { Authorization: 'Bearer ' + f.b.token })
  for (const [client, id] of [
    [ca, A],
    [cb, B]
  ] as const)
    client.socket.on('message', raw => {
      const m = JSON.parse(raw.toString())
      if (m.type === 'request')
        client.socket.send(
          JSON.stringify({
            type: 'response',
            computerId: id,
            id: m.id,
            result: { computer: id, requestId: m.requestId, agent: m.params.agentId }
          })
        )
    })
  const results = await Promise.all(
    [A, B].map(id =>
      f
        .post('/api/computers/' + id + '/rpc', {
          method: 'chat.send',
          params: { agentId: 'default' },
          requestId: 'stable-task'
        })
        .then(r => r.json())
    )
  )
  assert.deepEqual(
    results.map(r => r.computer),
    [A, B]
  )
  assert.ok(results.every(r => r.requestId === 'stable-task'))
  // A computer may not satisfy another computer's pending response.
  const p = f.gateway.rpc(A, 'status', {})
  const req = await until(() => ca.messages.find(m => m.type === 'request' && m.method === 'status'))
  cb.socket.send(JSON.stringify({ type: 'response', computerId: B, id: req.id, result: { computer: B } }))
  assert.equal((await p).computer, A)
})
test('event replay is ordered, targeted, and separated from other computers', async t => {
  const f = await fixture(t)
  const ca = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  const va = await f.ws('/api/events?computerId=' + A, { Cookie: f.cookie, Origin: origin })
  const vb = await f.ws('/api/events?computerId=' + B, { Cookie: f.cookie, Origin: origin })
  const replay = await until(() => ca.messages.find(m => m.type === 'replay'))
  ca.socket.send(JSON.stringify({ type: 'event', computerId: A, seq: 3, kind: 'message.delta' }))
  for (const seq of [1, 2])
    ca.socket.send(
      JSON.stringify({ type: 'replay.event', viewerId: replay.viewerId, computerId: A, seq, kind: 'message.delta' })
    )
  ca.socket.send(JSON.stringify({ type: 'replay.complete', viewerId: replay.viewerId, computerId: A }))
  await until(() => va.messages.filter(m => m.type === 'event').length === 3)
  assert.deepEqual(
    va.messages.filter(m => m.type === 'event').map(m => m.seq),
    [1, 2, 3]
  )
  assert.equal(vb.messages.filter(m => m.type === 'event').length, 0)
  const closed = once(va.socket, 'close')
  await f.post('/api/logout', {})
  await closed
})
test('duplicate connectors cannot replace an authenticated live owner', async t => {
  const f = await fixture(t)
  const first = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  const second = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  const [code] = await once(second.socket, 'close')
  assert.equal(code, 1008)
  assert.equal(first.socket.readyState, WebSocket.OPEN)
})
test('an online Mac can prepare a repair without replacing its connection or credential', async t => {
  const f = await fixture(t)
  f.store.db.prepare("UPDATE computers SET kind='local',platform='darwin' WHERE id=?").run(A)
  writeFileSync(join(f.dir, 'runtime.sha256'), 'a'.repeat(64))
  writeFileSync(join(f.dir, 'connect-local.py'), '# test installer fixture\n')
  const connection = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  const response = await f.post('/api/connections/local', { computerId: A })
  assert.equal(response.status, 201)
  const repair = await response.json()
  assert.equal(repair.computerId, A)
  assert.equal(f.store.computers().length, 2)
  assert.equal(f.store.connector(A, f.a.token), true)
  assert.equal(connection.socket.readyState, WebSocket.OPEN)
  const download = await fetch(f.url + repair.download, { headers: { Cookie: f.cookie } })
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('content-type'), 'application/zip')
  assert.ok((await download.arrayBuffer()).byteLength > 0)
  // Orgo identities cannot be repurposed as Mac repair destinations.
  assert.notEqual((await f.post('/api/connections/local', { computerId: B })).status, 201)
  assert.equal(f.store.connector(B, f.b.token), true)
})
test('metadata and login persist across a gateway process restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'studio-store-'))
  const path = join(dir, 's.db')
  let store = new Store(path)
  const computer = store.addComputer(A, 'Orgo')
  const login = store.login()
  store.close()
  store = new Store(path)
  assert.equal(store.connector(A, computer.token), true)
  assert.equal(store.authenticated(login), true)
  assert.equal(store.computers()[0].id, A)
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

test('empty connector timeout errors return a readable failure rather than an empty success', async t => {
  const f = await fixture(t)
  const connection = await f.ws('/connect?computerId=' + A, { Authorization: 'Bearer ' + f.a.token })
  connection.socket.on('message', raw => {
    const m = JSON.parse(raw.toString())
    if (m.type === 'request')
      connection.socket.send(JSON.stringify({ type: 'response', computerId: A, id: m.id, error: '' }))
  })
  const response = await f.post('/api/computers/' + A + '/rpc', {
    method: 'providers.keys',
    requestId: 'timeout',
    params: { agentId: 'default' }
  })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /computer could not complete/)
})

test('cross-computer tasks require a directional grant and carry receiver-verifiable proof',async t=>{
  const f=await fixture(t)
  const ca=await f.ws('/connect?computerId='+A,{Authorization:'Bearer '+f.a.token})
  const cb=await f.ws('/connect?computerId='+B,{Authorization:'Bearer '+f.b.token})
  const envelope={jsonrpc:'2.0',id:'message',method:'message/send',params:{message:{messageId:'message',role:'user',parts:[{kind:'text',text:'hello'}]}}}
  const send=(id:string)=>ca.socket.send(JSON.stringify({type:'peer.request',computerId:A,id,targetComputerId:B,method:'a2a.receive',requestId:'message',params:{sourceAgentId:'default',agentId:'email',envelope,hops:1}}))
  send('denied');const denied=await until(()=>ca.messages.find(m=>m.id==='denied'))
  assert.match(denied.error,/TRUST_REQUIRED/);assert.equal(cb.messages.some(m=>m.method==='a2a.receive'),false)
  const grant=f.gateway.control.grant({source:A,actor:'default',target:B,agent:'email'})
  send('allowed');const request=await until(()=>cb.messages.find(m=>m.method==='a2a.receive'))
  const claims=JSON.parse(Buffer.from(request.params.authorization.payload,'base64url').toString())
  assert.equal(claims.source,A);assert.equal(claims.actor,'default');assert.equal(claims.target,B);assert.equal(claims.agent,'email');assert.equal(claims.hops,1)
  cb.socket.send(JSON.stringify({type:'response',computerId:B,id:request.id,result:{accepted:true}}))
  assert.equal((await until(()=>ca.messages.find(m=>m.id==='allowed'))).result.accepted,true)
  f.gateway.control.revoke(grant.id);send('revoked')
  assert.match((await until(()=>ca.messages.find(m=>m.id==='revoked'))).error,/TRUST_REQUIRED/)
})

test('connection check requires an existing directional grant, verifies both agents, and never grants access', async t => {
  const f=await fixture(t)
  const a=await f.ws('/connect?computerId='+A,{Authorization:'Bearer '+f.a.token})
  const b=await f.ws('/connect?computerId='+B,{Authorization:'Bearer '+f.b.token})
  for(const c of [a,b])c.socket.on('message',raw=>{
    const m=JSON.parse(String(raw))
    if(m.type==='request')c.socket.send(JSON.stringify({type:'response',id:m.id,computerId:c===a?A:B,result:{agents:[{id:'default'}]}}))
  })
  const params={source:A,actor:'default',target:B,agent:'default'}
  assert.equal((await f.post('/api/grants/check',params)).status,403)
  const grant=await (await f.post('/api/grants',params)).json()
  assert.equal((await f.post('/api/grants/check',params)).status,200)
  assert.equal((await f.post('/api/grants/check',{...params,source:B,target:A})).status,403)
  await f.post('/api/grants/revoke',{id:grant.id})
  assert.equal((await f.post('/api/grants/check',params)).status,403)
  assert.equal(f.gateway.control.grants().length,1)
})

test('custom app origin and previous origin work without trusting public site or sibling origins', async t => {
  const app = 'https://app.example.test'
  const f = await fixture(t, [app])
  const login = await f.post('/api/login', { password }, { Origin: app })
  assert.equal(login.status, 200)
  assert.ok(!login.headers.get('set-cookie')?.includes('Domain='), 'cookies must remain host scoped')
  assert.notEqual((await f.post('/api/computers', {}, { Origin: app })).status, 403)
  for (const bad of ['https://example.test', app + '.evil.test', app + '/', 'null'])
    assert.equal((await f.post('/api/login', { password }, { Origin: bad })).status, 403)
  const viewer = await f.ws('/api/events?computerId=' + A, { Origin: app, Cookie: f.cookie })
  viewer.socket.close()
})

test('repair is owner-only, computer scoped, separate from installation, and excludes Mac recovery',async t=>{
  const f=await fixture(t);const checked:string[]=[];let installs=0
  f.gateway.recovery!.check=async id=>{checked.push(id)}
  f.gateway.computers.connect=async()=>{installs++;return {state:'connected'}}
  assert.equal((await f.post('/api/connections/repair',{computerId:A},{Cookie:''})).status,401)
  assert.equal((await f.post('/api/connections/repair',{computerId:A},{Origin:'https://untrusted.test'})).status,403)
  assert.equal((await f.post('/api/connections/repair',{computerId:A})).status,202)
  assert.deepEqual(checked,[A]);assert.equal(installs,0)
  assert.equal((await f.post('/api/connections/repair',{computerId:'missing'})).status,400)
  f.store.db.prepare("UPDATE computers SET kind='local' WHERE id=?").run(B)
  assert.equal((await f.post('/api/connections/repair',{computerId:B})).status,400)
  assert.equal((await f.post('/api/connections/ssh',{computerId:A,configuration:null},{Cookie:''})).status,401)
  assert.equal((await f.post('/api/connections/ssh',{computerId:A,configuration:null},{Origin:'https://untrusted.test'})).status,403)
  assert.equal((await f.post('/api/connections/ssh',{computerId:A,configuration:null})).status,200)
})
