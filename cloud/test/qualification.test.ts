import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Qualification } from '../server/qualification.ts'
test('trial restarts inspect accepted work and stop after 24 hours', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-trial-'))
  let now = 100000,
    sends = 0
  const tasks: any[] = []
  const gateway: any = {
    rpc: async (_computer: string, method: string, _params: any, id: string) => {
      if (method === 'status') return { runtimeConnected: true }
      if (method === 'agents.list') return { agents: [{ id: 'qa' }] }
      if (method === 'tasks.list') return { deliveries: tasks }
      if (method === 'sessions.open') return { runtimeId: 'runtime' }
      if (method === 'tasks.evidence') return { toolStarts: 1, toolResults: 1 }
      if (method === 'chat.send') {
        sends++
        tasks.push({ id, state: 'complete', result: 'PROOF' })
        throw new Error('lost acknowledgment')
      }
    }
  }
  const targets = [{ computer: 'c', agent: 'qa', proof: '/test-proof', expected: 'PROOF' }]
  let q = new Qualification(gateway, path.join(dir, 'trial.db'), targets, () => now)
  try {
    await q.tick()
    assert.equal(sends, 1)
    await q.close()
    q = new Qualification(gateway, path.join(dir, 'trial.db'), targets, () => now)
    await q.tick()
    assert.equal(sends, 1)
    assert.equal((q.summary().jobs[0] as any).state, 'verified')
    now += 86400000
    await q.tick()
    assert.equal(sends, 1)
    assert.equal(q.summary().state, 'finished-awaiting-review')
  } finally {
    await q.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a completed answer without actual tool execution cannot pass qualification', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'studio-trial-'))
  const tasks: any[] = []
  let sends = 0
  const gateway: any = {
    rpc: async (_computer: string, method: string, _params: any, id: string) => {
      if (method === 'status') return { runtimeConnected: true }
      if (method === 'agents.list') return { agents: [{ id: 'qa' }] }
      if (method === 'tasks.list') return { deliveries: tasks }
      if (method === 'sessions.open') return { runtimeId: 'runtime' }
      if (method === 'tasks.evidence') return { toolStarts: 0, toolResults: 0 }
      if (method === 'chat.send') {
        sends++
        tasks.push({ id, state: 'complete', result: 'PROOF' })
        return { accepted: true }
      }
    }
  }
  const q = new Qualification(gateway, path.join(dir, 'trial.db'), [
    { computer: 'c', agent: 'qa', proof: '/test', expected: 'PROOF' }
  ])
  try {
    await q.tick()
    await q.tick()
    await q.tick()
    assert.equal((q.summary().jobs[0] as any).state, 'failed_validation')
    assert.equal(sends, 1)
  } finally {
    await q.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a named requalification preserves failed evidence and restarts the 24-hour window only once', async () => {
  const dir=mkdtempSync(path.join(tmpdir(),'studio-trial-'))
  let now=1000
  const file=path.join(dir,'trial.db')
  let q=new Qualification({} as any,file,[],()=>now)
  try {
    q.db.prepare('INSERT INTO jobs VALUES(?,?,?,NULL,?,?)').run('trial-1000-0-qa-c','c','qa','failed_validation','Recorded defect')
    await q.close()
    now=2000
    q=new Qualification({} as any,file,[],()=>now,'fixed-isolation')
    assert.equal(q.summary().started,2000)
    assert.equal(q.summary().ends,86402000)
    assert.equal(q.summary().jobs.length,0)
    assert.equal((q.summary().previousWindows[0].jobs[0] as any).state,'failed_validation')
    await q.close()
    now=3000
    q=new Qualification({} as any,file,[],()=>now,'fixed-isolation')
    assert.equal(q.summary().started,2000)
    assert.equal(q.summary().previousWindows.length,1)
  } finally {await q.close();rmSync(dir,{recursive:true,force:true})}
})
