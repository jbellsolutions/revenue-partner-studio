import { DatabaseSync } from 'node:sqlite'
import type { createGateway } from './gateway.ts'
type Gateway = ReturnType<typeof createGateway>
type Target = { computer: string; agent: string; proof: string; expected: string; screens?: string[] }
export function failureCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  if (/timeout|timed out|acknowledg/.test(message)) return 'acknowledgment_timeout'
  if (/offline|not connected/.test(message)) return 'offline'
  if (/interrupt|closed|disconnect/.test(message)) return 'connection_interrupted'
  if (/screen identity/.test(message)) return 'screen_identity_mismatch'
  if (/repair needed/.test(message)) return 'screen_repair_needed'
  if (/permission|unauthoriz|forbidden/.test(message)) return 'permission_required'
  return 'unclassified_failure' // Never persist raw provider errors or credentials.
}
export class Qualification {
  db: DatabaseSync
  active = false
  stopped = false
  timer?: ReturnType<typeof setInterval>
  constructor(
    readonly gateway: Gateway,
    file: string,
    readonly targets: Target[],
    readonly now = Date.now,
    revision?: string
  ) {
    this.db = new DatabaseSync(file)
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS trial(id INTEGER PRIMARY KEY CHECK(id=1),started INTEGER,ends INTEGER);
      CREATE TABLE IF NOT EXISTS probes(at INTEGER,computer TEXT,operation TEXT,ms REAL,ok INTEGER,error TEXT);
      CREATE TABLE IF NOT EXISTS windows(started INTEGER PRIMARY KEY,ends INTEGER,revision TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS screen_observations(at INTEGER,computer TEXT,agent TEXT,state TEXT,display TEXT,paused INTEGER);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,computer TEXT,agent TEXT,runtime TEXT,state TEXT,error TEXT);`)
    const initialized=this.db.prepare('SELECT started FROM trial WHERE id=1').get()
    this.db.prepare('INSERT OR IGNORE INTO trial VALUES(1,?,?)').run(now(), now() + 86400000)
    const current = this.db.prepare('SELECT started,ends FROM trial WHERE id=1').get()!
    this.db.prepare('INSERT OR IGNORE INTO windows VALUES(?,?,?)').run(current.started,current.ends,initialized?'initial':revision||'initial')
    const window = this.db.prepare('SELECT revision FROM windows WHERE started=?').get(current.started)!
    // A deliberate, named qualification revision starts a fresh window. Keep
    // every earlier probe, receipt and failure available for the release review.
    if (revision && revision !== window.revision) {
      const started=now()
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare('INSERT INTO windows VALUES(?,?,?)').run(started,started+86400000,revision)
        this.db.prepare('UPDATE trial SET started=?,ends=? WHERE id=1').run(started,started+86400000)
        this.db.exec('COMMIT')
      } catch(error) { this.db.exec('ROLLBACK'); throw error }
    }
  }
  start() {
    this.timer = setInterval(() => void this.tick(), 30000)
    // Connectors need a chance to reattach when the gateway starts listening.
    // The first scheduled observation remains part of the recorded window.
  }
  async measured(computer: string, operation: string, params: Record<string, unknown> = {}, id?: string) {
    const started = performance.now()
    try {
      const result = await this.gateway.rpc(computer, operation, params, id)
      this.db
        .prepare('INSERT INTO probes VALUES(?,?,?,?,1,NULL)')
        .run(this.now(), computer, operation, performance.now() - started)
      return result
    } catch (error) {
      this.db
        .prepare('INSERT INTO probes VALUES(?,?,?,?,0,?)')
        .run(this.now(), computer, operation, performance.now() - started, failureCode(error))
      throw error
    }
  }
  async observeScreens(target: Target) {
    for (const agent of [...new Set(target.screens || [])].slice(0, 16)) {
      try {
        const screen = await this.measured(target.computer, 'screen.status', { agentId: agent })
        if (screen.computerId !== target.computer || screen.profile !== agent)
          throw Error('Screen identity mismatch')
        const state = ['ready', 'starting', 'waiting', 'unassigned', 'repair_needed'].includes(screen.state)
          ? screen.state : 'unknown'
        this.db.prepare('INSERT INTO screen_observations VALUES(?,?,?,?,?,?)')
          .run(this.now(), target.computer, agent, state, screen.display || null, screen.paused ? 1 : 0)
        if (state === 'repair_needed' || state === 'unknown') throw Error('Screen repair needed')
      } catch (error) {
        this.db.prepare('INSERT INTO probes VALUES(?,?,?,?,0,?)')
          .run(this.now(), target.computer, 'screen.health', 0, failureCode(error))
      }
    }
  }
  async tick() {
    if (this.active || this.stopped) return
    const trial = this.db.prepare('SELECT * FROM trial WHERE id=1').get() as { started: number; ends: number }
    if (this.now() >= trial.ends) return
    this.active = true
    try {
      const cycle = Math.floor((this.now() - trial.started) / 10800000)
      for (const target of this.targets) {
        if (this.stopped) break
        try {
          const status = await this.measured(target.computer, 'status')
          if (!status.runtimeConnected) throw new Error('Runtime offline')
          const roster = await this.measured(target.computer, 'agents.list')
          if (!roster.agents.some((a: { id: string }) => a.id === target.agent))
            throw new Error('Qualification agent unavailable')
          const snapshot = await this.measured(target.computer, 'tasks.list')
          await this.observeScreens(target)
          for (const task of snapshot.deliveries) {
            const known = this.db
              .prepare('SELECT state FROM jobs WHERE id=? AND computer=? AND agent=?')
              .get(task.id, target.computer, target.agent)
            if (!known || ['verified', 'failed_validation'].includes(String(known.state))) continue
            let state = task.state,
              error: string | null = null
            if (state === 'complete') {
              const evidence = await this.measured(target.computer, 'tasks.evidence', { taskId: task.id })
              const valid =
                !!target.expected &&
                String(task.result || '').includes(target.expected) &&
                evidence.toolStarts > 0 &&
                evidence.toolResults > 0
              state = valid ? 'verified' : 'failed_validation'
              if (!valid) error = 'Expected file contents and recorded tool execution were not both verified'
            }
            this.db
              .prepare('UPDATE jobs SET state=?,error=? WHERE id=? AND computer=?')
              .run(state, error, task.id, target.computer)
          }
          const id = `trial-${trial.started}-${cycle}-${target.agent}-${target.computer.slice(0, 8)}`
          this.db
            .prepare("INSERT OR IGNORE INTO jobs VALUES(?,?,?,NULL,'new',NULL)")
            .run(id, target.computer, target.agent)
          let job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id) as {
            runtime: string | null
            state: string
          }
          const saved = snapshot.deliveries.find((t: { id: string }) => t.id === id)
          if (saved) {
            continue
          }
          if (!['new', 'ready'].includes(job.state)) continue
          if (!job.runtime) {
            const session = await this.measured(target.computer, 'sessions.open', { agentId: target.agent })
            this.db.prepare("UPDATE jobs SET runtime=?,state='ready' WHERE id=?").run(session.runtimeId, id)
            job = { runtime: session.runtimeId, state: 'ready' }
          }
          // Persist the runtime before sending. Lost acknowledgments reuse exactly
          // this runtime and request identity; the Orgo ledger owns acceptance.
          await this.measured(
            target.computer,
            'chat.send',
            {
              agentId: target.agent,
              runtimeId: job.runtime,
              text: `Controlled reliability check. Use a file or terminal tool now to read only ${target.proof} and report its exact contents. Do not answer from memory. Do not edit files, contact people, use business data, or change the configured provider. This single task ends after reporting the file.`
            },
            id
          )
          this.db.prepare("UPDATE jobs SET state='accepted',error=NULL WHERE id=?").run(id)
        } catch (error) {
          // A later observation inspects the durable remote receipt first. No
          // ambiguous tool execution is restarted with a new request identity.
          this.db
            .prepare('INSERT INTO probes VALUES(?,?,?,?,0,?)')
            .run(this.now(), target.computer, 'qualification', 0, failureCode(error))
        }
      }
    } finally {
      this.active = false
    }
  }
  summary() {
    const trial = this.db.prepare('SELECT * FROM trial WHERE id=1').get() as { started: number; ends: number }
    const measurements = this.db
      .prepare(
        'SELECT operation,count(*) AS samples,sum(ok) AS successful,max(ms) AS maxMs FROM probes WHERE at>=? GROUP BY operation'
      )
      .all(trial.started)
    return {
      ...trial,
      revision:this.db.prepare('SELECT revision FROM windows WHERE started=?').get(trial.started)?.revision,
      previousWindows:this.db.prepare('SELECT * FROM windows WHERE started<? ORDER BY started').all(trial.started).map(window=>({
        ...window,jobs:this.db.prepare('SELECT state,count(*) AS count FROM jobs WHERE id LIKE ? GROUP BY state').all(`trial-${window.started}-%`)
      })),
      state: this.now() < trial.ends ? 'running' : 'finished-awaiting-review',
      elapsedHours: Math.min(24, (this.now() - trial.started) / 3600000),
      scope:
        'Backend availability, persistent file-tool tasks and optional read-only screen ownership status. Screen pixels, input, browser visuals and switching require separate acceptance.',
      screenStates: this.db.prepare('SELECT computer,agent,state,paused,count(*) AS samples FROM screen_observations WHERE at>=? GROUP BY computer,agent,state,paused').all(trial.started),
      failureReasons: this.db.prepare('SELECT computer,operation,error,count(*) AS count FROM probes WHERE at>=? AND ok=0 GROUP BY computer,operation,error').all(trial.started),
      probes: measurements.map(row => {
        const values = this.db
          .prepare('SELECT ms FROM probes WHERE operation=? AND ok=1 AND at>=? ORDER BY ms')
          .all(row.operation,trial.started)
        return { ...row, p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1].ms : null }
      }),
      jobs: this.db.prepare('SELECT state,count(*) AS count FROM jobs WHERE id LIKE ? GROUP BY state').all(`trial-${trial.started}-%`)
    }
  }
  async close() {
    this.stopped = true
    clearInterval(this.timer)
    // The gateway rejects outstanding requests on shutdown; tick drains before
    // this database closes, preventing a shutdown/write race.
    while (this.active) await new Promise(resolve => setTimeout(resolve, 20))
    this.db.close()
  }
}
