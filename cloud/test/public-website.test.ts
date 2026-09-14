import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createGateway } from '../server/gateway.ts'
import { Store } from '../server/store.ts'

async function fixture(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-website-'))
  const website = join(dir, 'website'), app = join(dir, 'app')
  mkdirSync(join(website, 'assets'), { recursive: true })
  mkdirSync(join(website, 'downloads'))
  mkdirSync(app)
  writeFileSync(join(website, 'index.html'), '<h1>Fixture-only demo</h1>')
  writeFileSync(join(website, 'third-party-notices.txt'), 'Public dependency attribution')
  writeFileSync(join(website, 'assets', 'demo.js'), 'console.log("simulation")')
  writeFileSync(join(website, 'downloads', 'prep.docx'), 'public preparation document')
  writeFileSync(join(app, 'index.html'), '<h1>Private app login</h1>')
  writeFileSync(join(dir, 'private.txt'), 'private state must never be served')
  symlinkSync(join(dir, 'private.txt'), join(website, 'assets', 'escape.txt'))
  const store = new Store(join(dir, 'state.sqlite'))
  const gateway = createGateway({ store, password: 'test-owner-password-long-enough', origin: 'https://app.studio.test',
    publicDir: app, setupDir: dir, website: { url: 'https://studio.test', directory: website } })
  gateway.server.listen(0, '127.0.0.1')
  await once(gateway.server, 'listening')
  const port = (gateway.server.address() as any).port
  t.after(async () => { await gateway.close(); rmSync(dir, { recursive: true, force: true }) })
  const cookie = `studio_session=${store.login()}`
  const get = (path: string, host = 'studio.test', method = 'GET', headers = {}) => new Promise<any>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, res => {
      const chunks: Buffer[] = []
      res.on('data', x => chunks.push(x))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject); req.end()
  })
  return { get, port, store, cookie, gateway }
}

test('website serves public routes, downloads and HEAD with no-network demo policy', async t => {
  const f = await fixture(t)
  for (const path of ['/', '/demo', '/demo/', '/build', '/prep']) {
    const r = await f.get(path)
    assert.equal(r.status, 200)
    assert.match(r.body, /Fixture-only demo/)
    assert.match(r.headers['content-security-policy'], /connect-src 'none'/)
    assert.equal(r.headers['set-cookie'], undefined)
  }
  const download = await f.get('/downloads/prep.docx')
  assert.equal(download.status, 200)
  assert.match(download.headers['content-type'], /wordprocessingml/)
  const head = await f.get('/downloads/prep.docx', 'studio.test', 'HEAD')
  assert.equal(head.body, '')
  assert.equal(head.headers['content-length'], download.headers['content-length'])
  assert.equal((await f.get('/assets/demo.js')).status, 200)
  assert.equal((await f.get('/third-party-notices.txt')).body, 'Public dependency attribution')
})

test('website cannot route to private APIs or setup, even with an owner cookie', async t => {
  const f = await fixture(t)
  for (const host of ['studio.test', 'STUDIO.TEST.', 'www.studio.test'])
    for (const path of ['/api/computers', '/api/qualification', '/%61pi/computers', '/setup/artifacts/secret/runtime.tar.gz', '/connect', '/.env']) {
      const r = await f.get(path, host, 'GET', { Cookie: f.cookie, Origin: 'https://app.studio.test' })
      assert.equal(r.status, 404, `${host}${path}`)
      assert.equal(r.headers['set-cookie'], undefined)
    }
  assert.equal((await f.get('/api/login', 'studio.test', 'POST', { Origin: 'https://app.studio.test' })).status, 405)
  assert.equal((await f.get('/api/computers', 'app.studio.test')).status, 401)
  assert.equal((await f.get('/api/computers', 'app.studio.test', 'GET', { Cookie: f.cookie })).status, 200)
  assert.match((await f.get('/', 'app.studio.test')).body, /Private app login/)
})

test('public host selection and redirects ignore forwarded headers and absolute request targets', async t => {
  const f = await fixture(t)
  const r = await f.get('/demo?step=2', 'www.studio.test')
  assert.equal(r.status, 301)
  assert.equal(r.headers.location, 'https://studio.test/demo?step=2')
  assert.equal((await f.get('https://evil.test/prep', 'www.studio.test')).headers.location, 'https://studio.test/prep')
  assert.equal((await f.get('/api/computers', 'studio.test', 'GET', {
    'X-Forwarded-Host': 'app.studio.test', Cookie: f.cookie
  })).status, 404)
})

test('missing files, malformed paths and filesystem escapes never expose deployment files', async t => {
  const f = await fixture(t)
  for (const path of ['/assets/missing.js', '/assets/escape.txt', '/assets/%2e%2e/%2e%2e/private.txt', '/downloads/../../private.txt']) {
    const r = await f.get(path)
    assert.equal(r.status, 404)
    assert.doesNotMatch(r.body, /private state|Private app login/)
  }
  assert.equal((await f.get('/assets/%zz')).status, 400)
})

test('public website rejects browser and connector WebSockets before gateway authorization', async t => {
  const f = await fixture(t)
  const computer = '10000000-0000-4000-8000-000000000001'
  const connector = f.store.addComputer(computer, 'test computer')
  for (const route of ['/api/events', `/connect?computerId=${computer}`]) {
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}${route}`, { headers: {
      Host: 'studio.test', Origin: 'https://app.studio.test', Cookie: f.cookie, Authorization: `Bearer ${connector.token}`
    } })
    ws.on('error', () => {})
    const [, response] = await once(ws, 'unexpected-response')
    assert.equal(response.statusCode, 403)
    response.resume(); ws.terminate()
  }
  assert.equal(f.gateway.connectors.size, 0)
})
