import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Setup } from './setup.mjs'
const binding = {
  projectId: '10000000-0000-4000-8000-000000000001',
  environmentId: '10000000-0000-4000-8000-000000000002',
  computerId: '10000000-0000-4000-8000-000000000003'
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rps-setup-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const saved = {},
    calls = []
  const io = {
    preflight: async () => [{ name: 'test prerequisites', ok: true }],
    configure: async () => calls.push('configure'),
    session: async () => async (route, body) => {
      calls.push({ route, body })
      if (route === '/api/orgo') return { configured: false }
      if (route === '/api/computers') return { computers: [] }
      if (route === '/api/connections/install') return { id: 'same-job', state: 'installing' }
    }
  }
  for (const name of ['Service', 'Volume', 'Domain', 'Deployment']) {
    io['find' + name] = async () => saved[name]
    io['create' + name] = async () => {
      calls.push(name)
      saved[name] =
        name === 'Service'
          ? { id: 'service' }
          : name === 'Domain'
            ? { url: 'https://private.example.test' }
            : { id: name }
    }
  }
  io.deploy = io.createDeployment
  return { dir, saved, calls, io, setup: new Setup(dir, io) }
}
test('approval and missing credentials produce no side effects', async t => {
  const f = fixture(t)
  await assert.rejects(f.setup.install(binding), /approval/)
  assert.deepEqual(f.calls, [])
  await f.setup.install(binding, true)
  await assert.rejects(f.setup.connect('test-owner-key'), /Approve transfer/)
  assert.ok(!f.calls.some(c => c.body?.key))
  await assert.rejects(f.setup.connect(), /credentials are missing/)
})
test('resume reuses resources, password and original destination', async t => {
  const f = fixture(t)
  await f.setup.install(binding, true)
  const password = readFileSync(join(f.dir, 'owner-password'), 'utf8')
  const resumed = new Setup(f.dir, f.io)
  await resumed.install(binding)
  assert.equal(readFileSync(join(f.dir, 'owner-password'), 'utf8'), password)
  assert.equal(f.calls.filter(c => c === 'Service').length, 1)
  assert.equal(f.calls.filter(c => c === 'Volume').length, 1)
  await assert.rejects(resumed.install({ ...binding, computerId: binding.projectId }), /another destination/)
  assert.equal(statSync(join(f.dir, 'owner-password')).mode & 0o777, 0o600)
  assert.ok(!readFileSync(join(f.dir, 'state.json'), 'utf8').includes(password))
})
test('lost acknowledgment reconciles an already created resource', async t => {
  const f = fixture(t)
  f.io.createService = async () => {
    f.saved.Service = { id: 'service' }
    throw Error('lost acknowledgment')
  }
  await assert.rejects(f.setup.install(binding, true), /lost/)
  await new Setup(f.dir, f.io).install(binding)
  assert.equal(f.saved.Service.id, 'service')
})
test('unknown failed creation is not retried and duplicated', async t => {
  const f = fixture(t)
  let attempts = 0
  f.io.createService = async () => {
    attempts++
    throw Error('network failure')
  }
  await assert.rejects(f.setup.install(binding, true))
  await assert.rejects(new Setup(f.dir, f.io).install(binding), /uncertain result/)
  assert.equal(attempts, 1)
})
test('approved connection resumes the gateway installation job', async t => {
  const f = fixture(t)
  await f.setup.install(binding, true)
  const a = await f.setup.connect('synthetic-key', true),
    b = await f.setup.connect('synthetic-key', true)
  assert.equal(a.state, b.state)
  assert.equal(f.setup.state.connection.id, 'same-job')
  assert.ok(!readFileSync(join(f.dir, 'state.json'), 'utf8').includes('synthetic-key'))
})
test('real-task verification reconciles an accepted task after lost acknowledgment', async t => {
  const f = fixture(t)
  await f.setup.install(binding, true)
  let task,
    sends = 0,
    sessions = 0
  f.io.session = async () => async (route, body) => {
    if (route === '/api/computers') return { computers: [{ id: binding.computerId, online: true }] }
    assert.equal(body.params.computerId, binding.computerId)
    if (body.method === 'status') return { runtimeConnected: true }
    if (body.method === 'agents.list') return { agents: [{ id: 'default' }] }
    if (body.method === 'sessions.open') {
      sessions++
      return { runtimeId: 'saved-conversation' }
    }
    if (body.method === 'tasks.list') return { deliveries: task ? [task] : [] }
    if (body.method === 'chat.send') {
      sends++
      task = { id: body.requestId, state: 'complete', result: '437' }
      throw Error('acknowledgment lost')
    }
    if (body.method === 'tasks.evidence') return { toolStarts: 1, toolResults: 1 }
    if (body.method === 'screen.open') return { screenSessionId: 'a'.repeat(32), screenId: 'screen-one' }
    if (['screen.pause','screen.resume','screen.release'].includes(body.method)) return { paused: body.method === 'screen.pause', released: body.method === 'screen.release' }
  }
  assert.equal((await f.setup.verify()).chatAndTool, 'not_run')
  await assert.rejects(f.setup.verify(true), /acknowledgment lost/)
  const result = await new Setup(f.dir, f.io).verify()
  assert.equal(result.chatAndTool, 'passed')
  assert.equal(sends, 1)
  assert.equal(sessions, 1)
  assert.equal(result.screenTakeover, 'backend_passed_browser_frame_pending')
})
test('a completed answer without tool evidence never passes installation', async t => {
  const f = fixture(t)
  await f.setup.install(binding, true)
  f.setup.state.test = { agentId: 'default', runtimeId: 'conversation', requestId: 'accepted-test' }
  f.setup.save()
  f.io.session = async () => async (route, body) =>
    route === '/api/computers'
      ? { computers: [{ id: binding.computerId, online: true }] }
      : body.method === 'status'
        ? { runtimeConnected: true }
        : body.method === 'agents.list'
          ? { agents: [{ id: 'default' }] }
          : body.method === 'tasks.list'
            ? { deliveries: [{ id: 'accepted-test', state: 'complete', result: '437' }] }
            : { toolStarts: 0, toolResults: 0 }
  assert.equal((await f.setup.verify()).chatAndTool, 'failed_evidence')
  assert.equal(f.setup.state.steps.realTool, false)
})
test('provider keys require destination approval and are never written to setup state', async t => {
  const f = fixture(t)
  await f.setup.install(binding, true)
  f.io.session = async () => async (_route, body) =>
    body.method === 'providers.check' ? { status: 'verified', message: 'verified' } : { saved: true }
  await assert.rejects(f.setup.provider('openrouter', 'private-provider-key'), /Approve transfer/)
  const result = await f.setup.provider('openrouter', 'private-provider-key', true)
  assert.equal(result.status, 'verified')
  assert.equal(readFileSync(join(f.dir, 'state.json'), 'utf8').includes('private-provider-key'), false)
})
test('guided mode is resumable and support bundle contains only sanitized results', async t => {
  const f = fixture(t)
  assert.equal((await f.setup.guided()).stage, 'destination_required')
  await f.setup.install(binding, true)
  f.setup.state.steps.connected = true
  f.setup.state.lastVerification = { connection: 'passed', chatAndTool: 'passed' }
  f.setup.save()
  const support = f.setup.supportBundle()
  const report = readFileSync(support.report, 'utf8')
  assert.match(report, /"chatAndTool": "passed"/)
  assert.equal(report.includes(binding.computerId), false)
  assert.equal(statSync(support.bundle).mode & 0o777, 0o600)
})
test('update downloads one private backup, deploys once, and reconciles one guarded computer job', async t => {
  const f=fixture(t);await f.setup.install(binding,true)
  let deployed=0,visible=false
  f.io.findUpdateDeployment=async()=>visible?{id:'deployment',status:'SUCCESS'}:null
  f.io.deployUpdate=async()=>{deployed++;visible=true}
  const api=async(route,body)=>{
    if(route==='/api/connections/update')return {id:'update-job',state:'updating'}
    if(route==='/api/orgo')return {jobs:[{id:'update-job',state:'updated'}]}
    if(route==='/api/computers')return {computers:[{id:binding.computerId,online:true}]}
    if(body?.method==='status')return {runtimeConnected:true}
    if(body?.method==='agents.list')return {agents:[{id:'default'}]}
    return {deliveries:[]}
  }
  api.download=async()=>Buffer.concat([Buffer.from('PK'),Buffer.alloc(200,1)])
  f.io.session=async()=>api
  const result=await f.setup.update(true)
  assert.equal(result.stage,'updated');assert.equal(deployed,1)
  const again=await f.setup.update(true);assert.equal(again.stage,'updated');assert.equal(deployed,1)
  assert.ok(statSync(f.setup.state.steps.gatewayBackup.file).size>100)
})
