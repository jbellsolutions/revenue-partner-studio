import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { ControlStore } from '../server/control-store.ts'
import { Transfers } from '../server/transfers.ts'
import { setupZip, localSetup, localDownload } from '../server/local-setup.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const A = '10000000-0000-4000-8000-000000000001',
  B = '10000000-0000-4000-8000-000000000002'
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise(r => setTimeout(r, 5))
  }
  throw Error('Expected state did not arrive')
}
test('transfer waits for review and reconciles accepted bytes after a lost reply and service restart', async () => {
  const store = new Store(':memory:'),
    control = new ControlStore(store, Buffer.alloc(32, 1))
  store.addComputer(A, 'Same')
  store.addComputer(B, 'Same')
  let offset = 0,
    loseReply = true,
    commits = 0
  const calls: string[] = []
  const rpc = async (computer: string, method: string, p: any) => {
    calls.push(method)
    if (method === 'library.export') {
      assert.equal(computer, A)
      return { exportId: 'snapshot', size: 4, sha256: 'checksum', manifest: { computerId: B } }
    }
    if (method === 'library.preview') {
      assert.equal(computer, B)
      return { profiles: [{ source: 'default', newProfile: true }] }
    }
    if (method === 'import.begin') return { uploadId: 'upload', offset }
    if (method === 'library.chunk') return { data: 'ZGF0YQ==', sha256: 'chunk' }
    if (method === 'import.chunk') {
      offset = 4
      if (loseReply) {
        loseReply = false
        throw Error('Connection interrupted')
      }
      return { offset }
    }
    if (method === 'import.commit') {
      commits++
      return { profiles: ['imported'] }
    }
    throw Error('Unexpected method ' + method)
  }
  let transfers = new Transfers(control, rpc)
  try {
    const j = transfers.start({ source: A, target: B, profiles: ['default'] })
    assert.throws(() => transfers.apply(j.id))
    await until(() => transfers.get(j.id).state === 'review')
    assert.equal(
      calls.some(m => m.startsWith('import.')),
      false
    )
    transfers.apply(j.id)
    await until(() => transfers.get(j.id).state === 'waiting')
    assert.equal(offset, 4)
    assert.equal(commits, 0)
    transfers.close()
    transfers = new Transfers(control, rpc)
    await transfers.run(j.id)
    assert.equal(transfers.get(j.id).state, 'complete')
    assert.equal(commits, 1)
    assert.equal(calls.filter(m => m === 'import.chunk').length, 1)
    assert.equal(transfers.apply(j.id).state, 'complete')
  } finally {
    transfers.close()
    store.close()
  }
})
test('Mac download is owner-scoped, expiring, executable, and carries its own pairing details', () => {
  const directory = mkdtempSync(join(tmpdir(), 'studio-setup-'))
  const store = new Store(':memory:'),
    control = new ControlStore(store, Buffer.alloc(32, 1))
  try {
    writeFileSync(join(directory, 'runtime.sha256'), 'a'.repeat(64))
    writeFileSync(join(directory, 'connect-local.py'), 'print("installer")')
    const result = localSetup(control, 'https://studio.test', directory, { name: 'My Mac' })
    assert.equal((result as any).code, undefined)
    const zip = localDownload(control, directory, result.job),
      file = join(directory, 'download.zip')
    writeFileSync(file, zip)
    const info = JSON.parse(
      execFileSync(
        'python3',
        [
          '-c',
          `import json,zipfile,sys\nz=zipfile.ZipFile(sys.argv[1]);print(json.dumps({'mode':z.getinfo('Connect Revenue Partner Studio/Connect Revenue Partner Studio.command').external_attr>>16,'config':json.loads(z.read('Connect Revenue Partner Studio/connection.json'))}))`,
          file
        ],
        { encoding: 'utf8' }
      )
    )
    assert.equal(info.mode, 0o100700)
    assert.equal(info.config.computerId, result.computerId)
    assert.ok(control.exchange(result.computerId, info.config.pair, 'darwin').token)
    const job = control.job(result.job)
    job.private.created = 0
    control.saveJob(job.id, job.computer, job.state, job.detail, job.private)
    assert.throws(() => localDownload(control, directory, result.job), /expired/)
    assert.ok(setupZip([]).length)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('selected skills fail closed on old companions and cannot silently become a full profile transfer', async () => {
  const store = new Store(':memory:'),
    control = new ControlStore(store, Buffer.alloc(32, 1))
  store.addComputer(A, 'Same')
  store.addComputer(B, 'Same')
  let capable = false,
    exported = false
  const transfers = new Transfers(control, async (c, m, p) => {
    if (m === 'status') return { capabilities: { librarySkills: capable } }
    if (m === 'library.export') {
      exported = true
      assert.deepEqual(p.selection.skillIds, ['writing/email'])
      return { manifest: { scope: 'profiles' } }
    }
    throw Error('Must not copy or preview an unexpected snapshot')
  })
  try {
    const p = {
      source: A,
      target: B,
      scope: 'skills',
      sourceProfile: 'default',
      targetAgent: 'email',
      profiles: ['default'],
      skillIds: ['writing/email']
    }
    const j = transfers.start(p)
    await until(() => transfers.get(j.id).state === 'failed')
    assert.equal(exported, false)
    capable = true
    transfers.retry(j.id)
    await until(() => transfers.get(j.id).state === 'failed')
    assert.equal(exported, true)
    assert.match(transfers.get(j.id).detail, /different import selection/)
    assert.equal(transfers.get(j.id).snapshot, undefined)
    assert.throws(() => transfers.start({ ...p, skillIds: ['../secrets'] }))
  } finally {
    transfers.close()
    store.close()
  }
})
