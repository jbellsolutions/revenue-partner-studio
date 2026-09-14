#!/usr/bin/env node
// Browser-first setup. Private checkpoints contain bindings and receipts, never keys.
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID, randomBytes } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export function validateBinding(value) {
  for (const key of ['projectId', 'environmentId', 'computerId'])
    if (!uuid.test(value[key] || '')) throw Error(`Supply the selected owner's ${key} in the private configuration.`)
  return Object.fromEntries(['projectId', 'environmentId', 'computerId'].map(k => [k, value[k]]))
}
function writePrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file + '.new', value, { mode: 0o600 })
  chmodSync(file + '.new', 0o600)
  renameSync(file + '.new', file)
}
export class Setup {
  constructor(directory, adapter) {
    this.directory = resolve(directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    chmodSync(this.directory, 0o700)
    this.file = resolve(this.directory, 'state.json')
    this.io = adapter
    this.state = existsSync(this.file)
      ? JSON.parse(readFileSync(this.file, 'utf8'))
      : { schema: 1, id: randomUUID(), steps: {}, intents: {} }
    if (this.state.schema !== 1) throw Error('Unsupported setup checkpoint version.')
    this.save()
  }
  save() {
    writePrivate(this.file, JSON.stringify(this.state, null, 2) + '\n')
  }
  bind(config) {
    const binding = validateBinding(config)
    if (this.state.binding && JSON.stringify(this.state.binding) !== JSON.stringify(binding))
      throw Error('This setup belongs to another destination. Use a new independent folder.')
    this.state.binding = binding
    this.save()
    return binding
  }
  async once(name, inspect, create) {
    const found = await inspect()
    if (found) {
      this.state.steps[name] = found
      delete this.state.intents[name]
      this.save()
      return found
    }
    if (this.state.steps[name]) throw Error(`The saved ${name} is missing. Restore or reconcile it before continuing.`)
    if (this.state.intents[name])
      throw Error(
        `The previous ${name} request had an uncertain result. Inspect the account before clearing its private intent; it will not be duplicated.`
      )
    this.state.intents[name] = new Date().toISOString()
    this.save()
    await create()
    const result = await inspect()
    if (!result) throw Error(`${name} is not visible yet. Resume to reconcile the existing request.`)
    this.state.steps[name] = result
    delete this.state.intents[name]
    this.save()
    return result
  }
  async preflight() {
    const checks = await this.io.preflight()
    return {
      stage: 'preflight',
      ready: checks.every(c => c.ok),
      checks,
      projectName: 'revenue-partner-studio-' + this.state.id.slice(0, 8),
      next: 'The assistant resolves the owner’s Railway project/environment and chosen Orgo computer, explains costs, then runs install with that private configuration.'
    }
  }
  async install(config, approved = false) {
    const binding = this.bind(config)
    if (!approved && !this.state.approved)
      throw Error(
        'Owner approval is required for one private Railway service and its persistent volume. No resources were created.'
      )
    if (!(await this.preflight()).ready)
      throw Error('Preflight is incomplete. Authenticate Railway and install the missing prerequisites first.')
    this.state.approved = true
    this.save()
    const name = 'rps-' + this.state.id.slice(0, 8)
    const service = await this.once(
      'service',
      () => this.io.findService(binding, name),
      () => this.io.createService(binding, name)
    )
    const target = { ...binding, serviceId: service.id }
    await this.once(
      'volume',
      () => this.io.findVolume(target),
      () => this.io.createVolume(target)
    )
    const domain = await this.once(
      'domain',
      () => this.io.findDomain(target),
      () => this.io.createDomain(target)
    )
    const origin = new URL(domain.url)
    if (origin.protocol !== 'https:' || origin.username || origin.password)
      throw Error('Expected a private HTTPS Railway app address.')
    this.state.url = origin.origin
    this.save()
    const passwordFile = resolve(this.directory, 'owner-password')
    if (!existsSync(passwordFile)) writePrivate(passwordFile, randomBytes(32).toString('base64url'))
    if (!this.state.steps.configured) {
      await this.io.configure(target, {
        STUDIO_OWNER_PASSWORD: readFileSync(passwordFile, 'utf8').trim(),
        STUDIO_PUBLIC_URL: this.state.url,
        STUDIO_DATA_DIR: '/data',
        PORT: '8788'
      })
      this.state.steps.configured = true
      this.save()
    }
    await this.once(
      'deployment',
      () => this.io.findDeployment(target, this.state.id),
      () => this.io.deploy(target, this.state.id)
    )
    return {
      stage: 'installed',
      url: this.state.url,
      next: 'Wait for /health, then connect the chosen computer. Owner password is in the private setup directory.'
    }
  }
  async session() {
    if (!this.state.url || !this.state.binding) throw Error('Run installation before connecting.')
    const password = readFileSync(resolve(this.directory, 'owner-password'), 'utf8').trim()
    return this.io.session(this.state.url, password)
  }
  async connect(key, approveTransfer = false) {
    const api = await this.session(),
      computerId = this.state.binding.computerId
    const catalog = await api('/api/orgo')
    if (key) {
      if (!approveTransfer)
        throw Error('Approve transfer of this Orgo key to this private Studio URL before saving it.')
      await api('/api/orgo', { key })
    } else if (!catalog.configured)
      throw Error(
        'Orgo credentials are missing. Supply them privately and approve their destination, or connect the account in this private app’s Settings.'
      )
    const roster = await api('/api/computers')
    if (roster.computers?.some(c => c.id === computerId && c.online)) {
      this.state.steps.connected = true
      this.save()
      return { stage: 'connected', computerId }
    }
    const job = await api('/api/connections/install', { computerId })
    this.state.connection = { id: job.id, state: job.state }
    this.save()
    return {
      stage: 'connecting',
      state: job.state,
      next: 'Resume connect to inspect the same installation job. It preserves existing Hermes state.'
    }
  }
  async verify(approveTest = false) {
    const api = await this.session(),
      computerId = this.state.binding.computerId
    const roster = await api('/api/computers')
    if (!roster.computers?.some(c => c.id === computerId && c.online))
      throw Error('Selected computer is offline. Resume Connect / Repair before verification.')
    const rpc = (method, params = {}, requestId = randomUUID()) =>
      api('/api/computers/' + computerId + '/rpc', { method, params: { ...params, computerId }, requestId })
    const status = await rpc('status'),
      agents = await rpc('agents.list')
    if (!status.runtimeConnected || !agents.agents?.length)
      throw Error('Hermes has not reported its actual profiles yet.')
    const result = {
      stage: 'verification',
      connection: 'passed',
      profiles: 'passed',
      chatAndTool: 'not_run',
      screenTakeover: 'requires_browser_acceptance',
      reopening: 'requires_browser_acceptance'
    }
    if (!approveTest && !this.state.test) return result
    if (!this.state.test) {
      const agent = agents.agents.find(a => a.id === 'default') || agents.agents[0]
      this.state.test = { agentId: agent.id, requestId: 'install-' + this.state.id }
      this.save()
    }
    const t = this.state.test
    if (!t.runtimeId) {
      const session = await rpc('sessions.open', { agentId: t.agentId }, 'install-session-' + this.state.id)
      t.runtimeId = session.runtimeId
      this.save()
    }
    const tasks = await rpc('tasks.list'),
      saved = tasks.deliveries.find(j => j.id === t.requestId)
    if (!saved) {
      await rpc(
        'chat.send',
        {
          agentId: t.agentId,
          runtimeId: t.runtimeId,
          text: 'Installation verification. Use a terminal tool to calculate 19 * 23, then report the result. Do not read private files, contact anyone, change settings, or delegate work. This task ends after reporting the result.'
        },
        t.requestId
      )
      result.chatAndTool = 'accepted_waiting'
      return result
    }
    if (saved.state === 'complete') {
      const evidence = await rpc('tasks.evidence', { taskId: t.requestId })
      const valid = String(saved.result).includes('437') && evidence.toolStarts > 0 && evidence.toolResults > 0
      result.chatAndTool = valid ? 'passed' : 'failed_evidence'
      this.state.steps.realTool = valid
      this.save()
    } else result.chatAndTool = saved.state
    return result
  }
}
export function cliAdapter(cwd = ROOT) {
  const env = {
    ...process.env,
    RAILWAY_CALLER: 'revenue-partner-studio-installer',
    RAILWAY_AGENT_SESSION: 'rps-install'
  }
  // Do not inherit model credentials into CLI child processes.
  for (const key of Object.keys(env)) if (/^(OPENAI|ANTHROPIC|OPENROUTER|ORGO|STUDIO_OWNER)_/.test(key)) delete env[key]
  const run = (args, input, json = true) => {
    const r = spawnSync('railway', args, {
      cwd,
      env,
      encoding: 'utf8',
      input,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024
    })
    if (r.status !== 0)
      throw Error(
        `Railway ${args[0]} did not complete. Inspect the destination in Railway and resume; no automatic destructive recovery is performed.`
      )
    return json ? JSON.parse(r.stdout) : r.stdout
  }
  const flags = b => [
    '--project',
    b.projectId,
    '--environment',
    b.environmentId,
    ...(b.serviceId ? ['--service', b.serviceId] : [])
  ]
  const services = b => run(['service', 'list', ...flags(b), '--json'])
  return {
    preflight: async () => {
      const major = Number(process.versions.node.split('.')[0]),
        minor = Number(process.versions.node.split('.')[1])
      const checks = [{ name: 'Node 22.22 or newer', ok: major > 22 || (major === 22 && minor >= 22) }]
      for (const name of ['git', 'npm', 'railway'])
        checks.push({ name, ok: spawnSync(name, ['--version'], { env, stdio: 'ignore' }).status === 0 })
      try {
        run(['whoami', '--json'])
        checks.push({ name: 'Railway authentication', ok: true })
      } catch {
        checks.push({ name: 'Railway authentication', ok: false })
      }
      return checks
    },
    findService: async (b, n) => services(b).find(s => s.name === n),
    createService: async (b, n) => {
      run(['link', '--project', b.projectId, '--environment', b.environmentId, '--json'])
      run(['add', '--service', n, '--json'])
    },
    findVolume: async b => {
      const service = services(b).find(s => s.id === b.serviceId)
      return service?.volumes?.find(v => v.mountPath === '/data')
    },
    createVolume: async b => run(['volume', ...flags(b), 'add', '--mount-path', '/data', '--json']),
    findDomain: async b => {
      const s = services(b).find(s => s.id === b.serviceId)
      return s?.url ? { url: s.url } : null
    },
    createDomain: async b => run(['domain', ...flags(b), '--port', '8788', '--json']),
    configure: async (b, variables) => {
      for (const [name, value] of Object.entries(variables))
        run(['variable', 'set', name, '--stdin', ...flags(b), '--skip-deploys'], value, false)
      run(
        ['environment', 'edit', '--project', b.projectId, '--environment', b.environmentId, '--json'],
        JSON.stringify({
          services: {
            [b.serviceId]: {
              build: { builder: 'DOCKERFILE', dockerfilePath: 'cloud/Dockerfile', watchPatterns: ['**'] },
              deploy: {
                healthcheckPath: '/health',
                healthcheckTimeout: 120,
                numReplicas: 1,
                sleepApplication: false,
                restartPolicyType: 'ON_FAILURE',
                restartPolicyMaxRetries: 10
              }
            }
          }
        }),
        false
      )
    },
    findDeployment: async (b, id) => {
      const rows = run(['deployment', 'list', ...flags(b), '--json'])
      return rows.find(d =>
        [d.meta?.message, d.meta?.cliMessage, d.meta?.commitMessage, d.message].includes('rps-install-' + id)
      )
    },
    deploy: async (b, id) =>
      run(['up', ...flags(b), '--detach', '--json', '--message', 'rps-install-' + id], undefined, false),
    session: async (url, password) => {
      const origin = new URL(url).origin
      if (!origin.startsWith('https://')) throw Error('HTTPS is required for private setup.')
      const request = async (route, body, cookie) => {
        const response = await fetch(origin + route, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(60000)
        })
        if (!response.ok) {
          let detail = ''
          try {
            detail = (await response.json()).error || ''
          } catch {}
          throw Error(
            `Studio returned ${response.status}${detail ? ': ' + detail.slice(0, 300) : '. Check deployment and account access.'}`
          )
        }
        return response
      }
      const login = await request('/api/login', { password }),
        cookie = login.headers.get('set-cookie')?.split(';')[0]
      if (!cookie) throw Error('Studio did not return an authenticated session.')
      return async (route, body) => {
        if (!route.startsWith('/api/')) throw Error('Invalid setup route.')
        return (await request(route, body, cookie)).json()
      }
    }
  }
}
async function main() {
  const args = process.argv.slice(2),
    stage = args[0] || 'preflight',
    value = key => {
      const i = args.indexOf(key)
      return i < 0 ? undefined : args[i + 1]
    },
    directory = resolve(value('--state-dir') || resolve(ROOT, '.revenue-partner-studio'))
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock = resolve(directory, 'setup.lock')
  let fd
  try {
    fd = openSync(lock, 'wx', 0o600)
  } catch {
    throw Error(
      'Another setup process may be running. Confirm it has stopped before removing its private setup.lock file.'
    )
  }
  try {
    const setup = new Setup(directory, cliAdapter()),
      config = value('--config')
    let result
    if (stage === 'preflight') result = await setup.preflight()
    else if (stage === 'install') {
      if (!config) throw Error('Supply --config with the private destination configuration.')
      result = await setup.install(JSON.parse(readFileSync(config, 'utf8')), args.includes('--approve-resources'))
    } else if (stage === 'connect')
      result = await setup.connect(process.env.ORGO_API_KEY, args.includes('--approve-key-transfer'))
    else if (stage === 'verify') result = await setup.verify(args.includes('--approve-test'))
    else if (stage === 'status')
      result = { ...setup.state, ownerPassword: 'Stored privately; never included in this report.' }
    else throw Error('Use preflight, install, connect, verify or status.')
    console.log(JSON.stringify(result, null, 2))
  } finally {
    closeSync(fd)
    unlinkSync(lock)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
