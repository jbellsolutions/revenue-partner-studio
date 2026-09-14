import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { test, beforeEach } from 'vitest'
import { configureStudioBinding } from './studio-policy'

import {
  beginOrgoTailscaleSetup,
  BOT_ORGO_LEGACY_WORKSPACE_NAMES,
  BOT_ORGO_MCP_TRUST,
  BOT_ORGO_WORKSPACE_NAME,
  BOT_REMOTE_DESKTOP_HERMES,
  BOT_REMOTE_DESKTOP_INSTALL,
  BOT_REMOTE_HERMES_REF,
  buildKorgoSkillsBundle,
  buildKorgoSkillsInstallCommands,
  buildOrgoAgentMcpInstallCommands,
  buildOrgoAgentMcpProbeCommand,
  buildOrgoMaintenanceInstallCommands,
  buildOrgoMaintenanceProbeCommand,
  buildOrgoWallpaperApplyCommand,
  buildOrgoWallpaperInstallCommands,
  createOrgoComputer,
  doctorOrgoComputer,
  ensureHermesInstalledOnOrgo,
  ensureKorgoSkillsOnOrgo,
  ensureOrgoAgentMcpServer,
  ensureOrgoComputerRunning,
  ensureOrgoDesktopWallpaper,
  ensureOrgoMaintenanceInstalled,
  extractTailscaleAuthUrl,
  findOrCreateOrgoWorkspace,
  findOrCreateSharedHermesComputer,
  listOrgoComputers,
  listOrgoWorkspaces,
  ORGO_AGENT_MCP_COMMAND,
  ORGO_AGENT_MCP_REMOTE_PATH,
  ORGO_AGENT_MCP_SERVER_NAME,
  ORGO_AGENT_MCP_STAGING_PATH,
  ORGO_AGENT_MCP_UPLOAD_CHUNK_SIZE,
  ORGO_RUNTIME_POLICY_END,
  ORGO_RUNTIME_POLICY_START,
  ORGO_SILK_WALLPAPER_PATH,
  ORGO_WALLPAPER_PROBE_COMMAND,
  ORGO_WALLPAPER_STAGING_PATH,
  ORGO_WALLPAPER_UPLOAD_CHUNK_SIZE,
  orgoAgentMcpEntry,
  orgoMcpEntries,
  orgoMcpEntry,
  orgoProcessEnv,
  parseTailscaleStatus,
  persistOrgoEnvironmentOnRemote,
  pickOrgoWorkspaceByName,
  pickSharedHermesComputer,
  readBundledOrgoMaintenanceAssets,
  resolveHermesAgentTemplateRef,
  resolveOrgoAgentMcpAssetPath,
  TAILSCALE_AUTH_LOG_PATH,
  TAILSCALE_AUTH_POLL_COMMAND,
  TAILSCALE_INSTALL_TIMEOUT_SECONDS,
  TAILSCALE_STATUS_SUMMARY_URL
} from './orgo-broker'
import { BOT_TEMPLATE_REF } from './product'

const COMPUTER_ID = 'ef2f6e29-3864-494b-a82c-15280c5d9f9e'
beforeEach(() => configureStudioBinding(() => COMPUTER_ID))
const WORKSPACE_ID = 'ws-shared'

function json(data: unknown, status = 200) {
  return Response.json(data, { status })
}

async function withDesktopProduct<T>(product: 'bot' | 'hermes', run: () => Promise<T>): Promise<T> {
  const previous = process.env.HERMES_DESKTOP_PRODUCT
  process.env.HERMES_DESKTOP_PRODUCT = product

  try {
    return await run()
  } finally {
    if (previous === undefined) {
      delete process.env.HERMES_DESKTOP_PRODUCT
    } else {
      process.env.HERMES_DESKTOP_PRODUCT = previous
    }
  }
}

const withBotProduct = <T>(run: () => Promise<T>) => withDesktopProduct('bot', run)
const withHermesProduct = <T>(run: () => Promise<T>) => withDesktopProduct('hermes', run)

test('MCP entry references the process env instead of copying the API key', () => {
  const entry = orgoMcpEntry(COMPUTER_ID)

  assert.equal(entry.trust, 'untrusted')
  assert.equal(entry.env.ORGO_API_KEY, '${env:ORGO_API_KEY}')
  assert.equal(entry.env.ORGO_DEFAULT_COMPUTER_ID, COMPUTER_ID)
  assert.equal(entry.command, 'npx')
  assert.deepEqual(orgoProcessEnv({ apiKey: 'orgo-secret', computerId: COMPUTER_ID }), {
    ORGO_API_KEY: 'orgo-secret',
    ORGO_DEFAULT_COMPUTER_ID: COMPUTER_ID
  })
})

test('delegated Orgo agent MCP entry is pinned to the provisioned computer', () => {
  const entry = orgoAgentMcpEntry(COMPUTER_ID)

  assert.equal(entry.trust, 'untrusted')
  assert.equal(entry.command, '/usr/local/lib/hermes-agent/venv/bin/python')
  assert.deepEqual(entry.args, [ORGO_AGENT_MCP_REMOTE_PATH])
  assert.equal(entry.env.ORGO_API_KEY, undefined)
  assert.equal(entry.env.ORGO_DEFAULT_COMPUTER_ID, COMPUTER_ID)
  assert.equal(entry.env.ORGO_AGENT_MAX_STEPS, '30')
  assert.equal(entry.timeout, 960)
})

test('delegated Orgo agent server is bundled from the Hermes source tree in development', () => {
  const assetPath = resolveOrgoAgentMcpAssetPath(process.cwd()) || ''
  const source = fs.readFileSync(assetPath, 'utf8')

  assert.match(assetPath, /hermes_cli\/orgo_agent_mcp\.py$/)
  assert.match(source, /from mcp\.server\.mcpserver import MCPServer/)
  assert.match(source, /from mcp\.server\.fastmcp import FastMCP/)
  assert.match(source, /from mcp\.server\.mcpserver\.exceptions import ToolError/)
  assert.match(source, /from mcp\.server\.fastmcp\.exceptions import ToolError/)
})

test('every synced profile receives low-level and delegated Orgo MCP servers', () => {
  const entries = orgoMcpEntries(COMPUTER_ID)

  assert.deepEqual(Object.keys(entries).sort(), ['orgo', ORGO_AGENT_MCP_SERVER_NAME].sort())
  assert.equal(entries.orgo?.env.ORGO_DEFAULT_COMPUTER_ID, COMPUTER_ID)
  assert.equal(entries[ORGO_AGENT_MCP_SERVER_NAME]?.env.ORGO_DEFAULT_COMPUTER_ID, COMPUTER_ID)
})

test('the Bot trusts only its app-provisioned, computer-pinned Orgo servers', async () => {
  await withBotProduct(async () => {
    const entries = orgoMcpEntries(COMPUTER_ID)

    assert.equal(BOT_ORGO_MCP_TRUST, 'full')
    assert.equal(entries.orgo?.trust, 'full')
    assert.equal(entries[ORGO_AGENT_MCP_SERVER_NAME]?.trust, 'full')
  })

  await withHermesProduct(async () => {
    const entries = orgoMcpEntries(COMPUTER_ID)

    assert.equal(entries.orgo?.trust, 'untrusted')
    assert.equal(entries[ORGO_AGENT_MCP_SERVER_NAME]?.trust, 'untrusted')
  })
})

test('delegated Orgo agent server upload is chunked and installed atomically', () => {
  const commands = buildOrgoAgentMcpInstallCommands(Buffer.alloc(ORGO_AGENT_MCP_UPLOAD_CHUNK_SIZE).toString('base64'))
  const installCommand = commands.find(command => command.includes('| base64 -d | python3')) || ''
  const encodedScript = installCommand.match(/printf %s "([^"]+)" \| base64 -d \| python3/)?.[1] || ''
  const script = Buffer.from(encodedScript, 'base64').toString('utf8')

  assert.equal(commands.length > 3, true)
  assert.match(commands[0] || '', new RegExp(ORGO_AGENT_MCP_STAGING_PATH))
  assert.match(script, new RegExp(ORGO_AGENT_MCP_REMOTE_PATH))
  assert.match(script, /os\.replace\(temporary, target\)/)
})

test('delegated Orgo agent dependency command is valid shell', () => {
  const command = buildOrgoAgentMcpInstallCommands('c2VydmVy')
    .find(candidate => candidate.includes('mcp>=1.28.1,<3'))

  assert.ok(command)
  assert.doesNotMatch(command, /mcp==1\.28\.1/)
  assert.match(command, /\/root\/\.hermes\/bin\/uv/)
  assert.match(command, /ensurepip/)
  const parsed = spawnSync('bash', ['-n'], { input: command, encoding: 'utf8' })

  assert.equal(parsed.status, 0, parsed.stderr)
})

test('maintenance assets install atomically to fixed paths and enable the host supervisor', () => {
  const commands = buildOrgoMaintenanceInstallCommands({
    'orgo-remote-maintenance': Buffer.from('#!/bin/bash\n'),
    'orgo-maintenance-loop': Buffer.from('#!/bin/bash\n'),
    'orgo-maintenance-supervisor.conf': Buffer.from('[program:orgo-maintenance]\n'),
    'orgo-maintenance.service': Buffer.from('[Service]\n'),
    'orgo-maintenance.timer': Buffer.from('[Timer]\n')
  })

  const decoded = commands
    .filter(command => command.includes('| base64 -d | python3'))
    .map(command => {
      const encoded = command.match(/printf %s "([^"]+)" \| base64 -d \| python3/)?.[1] || ''

      return Buffer.from(encoded, 'base64').toString('utf8')
    })
    .join('\n')

  assert.match(decoded, /\/usr\/local\/sbin\/orgo-remote-maintenance/)
  assert.match(decoded, /\/usr\/local\/sbin\/orgo-maintenance-loop/)
  assert.match(decoded, /\/etc\/supervisor\/conf\.d\/orgo-maintenance\.conf/)
  assert.match(decoded, /\/etc\/systemd\/system\/orgo-maintenance\.timer/)
  assert.match(decoded, /os\.replace\(temporary, target\)/)
  assert.match(decoded, /0o755/)
  assert.equal(commands.some(command => command.includes('/tmp/orgo-maintenance')), false)
  assert.equal(commands.some(command => command.includes('/root/.hermes/.maintenance-upload/')), true)
  assert.match(commands.at(-1) || '', /install -d -m 700 \/var\/log\/orgo/)
  assert.match(commands.at(-1) || '', /supervisorctl reread/)
  assert.match(commands.at(-1) || '', /systemctl enable --now orgo-maintenance\.timer/)
})

test('maintenance scheduler falls back to Supervisor when systemctl exists without active systemd', () => {
  const assets = {
    'orgo-remote-maintenance': Buffer.from('#!/bin/bash\n'),
    'orgo-maintenance-loop': Buffer.from('#!/bin/bash\n'),
    'orgo-maintenance-supervisor.conf': Buffer.from('[program:orgo-maintenance]\n'),
    'orgo-maintenance.service': Buffer.from('[Service]\n'),
    'orgo-maintenance.timer': Buffer.from('[Timer]\n')
  }

  const activation = buildOrgoMaintenanceInstallCommands(assets).at(-1) || ''
  const probe = buildOrgoMaintenanceProbeCommand(assets)

  for (const command of [activation, probe]) {
    assert.match(command, /test -d \/run\/systemd\/system/)
    assert.match(command, /systemctl show-environment/)
    assert.match(command, /supervisorctl/)
  }
})

test('maintenance assets load from packaged app resources', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgo-maintenance-assets-'))

  try {
    const directory = path.join(root, 'orgo', 'maintenance')

    const names = [
      'orgo-remote-maintenance',
      'orgo-maintenance-loop',
      'orgo-maintenance-supervisor.conf',
      'orgo-maintenance.service',
      'orgo-maintenance.timer'
    ]

    fs.mkdirSync(directory, { recursive: true })

    for (const name of names) {fs.writeFileSync(path.join(directory, name), name)}

    const assets = readBundledOrgoMaintenanceAssets('/unused', root)

    assert.deepEqual(Object.keys(assets).sort(), names.sort())
    assert.equal(assets['orgo-remote-maintenance'].toString(), 'orgo-remote-maintenance')
  } finally {
    fs.rmSync(root, { force: true, recursive: true })
  }
})

test('Korgo skills bundle includes complete skill directories but excludes secrets and unrelated files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'korgo-skills-'))

  try {
    fs.mkdirSync(path.join(root, 'writing', 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(root, 'not-a-skill'), { recursive: true })
    fs.writeFileSync(path.join(root, 'writing', 'SKILL.md'), '# Writing\n')
    fs.writeFileSync(path.join(root, 'writing', 'scripts', 'run.py'), 'print("ok")\n')
    fs.writeFileSync(path.join(root, 'writing', '.env'), 'SECRET=do-not-copy\n')
    fs.writeFileSync(path.join(root, 'not-a-skill', 'notes.md'), 'ignore me\n')

    const bundle = buildKorgoSkillsBundle(root)

    const manifest = JSON.parse(zlib.gunzipSync(bundle).toString('utf8')) as {
      files: Record<string, string>
      version: number
    }

    assert.equal(manifest.version, 1)
    assert.deepEqual(Object.keys(manifest.files).sort(), ['writing/SKILL.md', 'writing/scripts/run.py'])
    assert.equal(Buffer.from(manifest.files['writing/SKILL.md'] || '', 'base64').toString(), '# Writing\n')

    const commands = buildKorgoSkillsInstallCommands(bundle.toString('base64'))
    const finalCommand = commands.at(-1) || ''
    const encodedScript = finalCommand.match(/printf %s "([^"]+)" \| base64 -d \| python3/)?.[1] || ''
    const script = Buffer.from(encodedScript, 'base64').toString('utf8')

    assert.equal(commands.length >= 3, true)
    assert.match(script, /\.hermes.*skills/)
    assert.match(script, /relative\.is_absolute\(\)/)
    assert.match(script, /os\.replace/)
    assert.doesNotMatch(script, /rmtree|unlink\(.*skills/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Korgo skills sync skips upload when the remote marker already matches', async () => {
  const commands: string[] = []
  const bundle = Buffer.from('skills-bundle')

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    return json({ success: true, exit_code: 0, output: 'ready' })
  }) as typeof fetch

  const result = await ensureKorgoSkillsOnOrgo('orgo-secret', COMPUTER_ID, () => bundle, fetchImpl)

  assert.equal(result.syncedNow, false)
  assert.equal(result.sha256, '3badce4301e6ecc9f3d5dcc855def07d9cd55a82b4138f6c757ded139f42df81')
  assert.equal(commands.length, 1)
  assert.match(commands[0] || '', /korgo-local-sync\.sha256/)
})

test('Korgo skills sync uploads, installs, and verifies a changed bundle', async () => {
  const commands: string[] = []
  let probeCount = 0

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command.includes('korgo-local-sync.sha256')) {
      probeCount += 1

      return probeCount === 1
        ? json({ success: false, exit_code: 1, output: 'changed' })
        : json({ success: true, exit_code: 0, output: 'verified' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  const result = await ensureKorgoSkillsOnOrgo(
    'orgo-secret',
    COMPUTER_ID,
    () => Buffer.from('skills-bundle'),
    fetchImpl
  )

  assert.equal(result.syncedNow, true)
  assert.equal(probeCount, 2)
  assert.match(commands[1] || '', /korgo-skills-sync\.b64/)
  assert.match(commands.at(-2) || '', /base64 -d \| python3/)
})

test('delegated Orgo agent server skips upload when its hash matches', async () => {
  const commands: string[] = []
  const serverBytes = Buffer.from('print("server")')

  const expectedProbe = buildOrgoAgentMcpProbeCommand(
    'ff005961596f9819dc9b55356b9abebabbd866adf2a359a02b1491b2c42baa24'
  )

  assert.match(expectedProbe, /from mcp\.server\.mcpserver import MCPServer/)
  assert.match(expectedProbe, /from mcp\.server\.fastmcp import FastMCP/)

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    return json({ success: true, exit_code: 0, output: 'ready' })
  }) as typeof fetch

  const result = await ensureOrgoAgentMcpServer('orgo-secret', COMPUTER_ID, () => serverBytes, fetchImpl)

  assert.equal(result.installedNow, false)
  assert.deepEqual(commands, [expectedProbe])
})

test('delegated Orgo agent server uploads and verifies when missing', async () => {
  const commands: string[] = []
  let probeCount = 0

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command.includes(`sha256sum ${ORGO_AGENT_MCP_REMOTE_PATH}`)) {
      probeCount += 1

      return probeCount === 1
        ? json({ success: false, exit_code: 1, output: 'missing' })
        : json({ success: true, exit_code: 0, output: 'verified' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  const result = await ensureOrgoAgentMcpServer(
    'orgo-secret',
    COMPUTER_ID,
    () => Buffer.from('print("server")'),
    fetchImpl
  )

  assert.equal(result.installedNow, true)
  assert.equal(probeCount, 2)
  assert.match(commands[1] || '', new RegExp(ORGO_AGENT_MCP_STAGING_PATH))
  assert.match(commands[2] || '', new RegExp(`>> ${ORGO_AGENT_MCP_STAGING_PATH}`))
  assert.match(commands.at(-3) || '', /\| base64 -d \| python3/)
  assert.match(commands.at(-2) || '', /mcp>=1\.28\.1,<3/)
  assert.doesNotMatch(commands.at(-2) || '', /mcp==1\.28\.1/)
  assert.match(commands.at(-1) || '', /from mcp\.server\.mcpserver import MCPServer/)
  assert.match(commands.at(-1) || '', /from mcp\.server\.fastmcp import FastMCP/)
})

test('delegated Orgo agent server removes staging data after an upload failure', async () => {
  const commands: string[] = []

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command.includes(`sha256sum ${ORGO_AGENT_MCP_REMOTE_PATH}`)) {
      return json({ success: false, exit_code: 1, output: 'missing' })
    }

    if (command.startsWith('printf %s') && command.includes(`>> ${ORGO_AGENT_MCP_STAGING_PATH}`)) {
      return json({ success: false, exit_code: 1, output: 'write failed' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  await assert.rejects(
    ensureOrgoAgentMcpServer('orgo-secret', COMPUTER_ID, () => Buffer.from('server'), fetchImpl),
    /write failed/
  )
  assert.equal(commands.at(-1), `rm -f ${ORGO_AGENT_MCP_STAGING_PATH}`)
})

test('lists workspaces and computers without exposing the key in parsed results', async () => {
  const calls: string[] = []

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)

    if (url.endsWith('/workspaces')) {
      return json({ workspaces: [{ id: WORKSPACE_ID, name: 'Bots' }] })
    }

    if (url.endsWith(`/workspaces/${WORKSPACE_ID}`)) {
      return json({
        id: WORKSPACE_ID,
        name: 'Bots',
        desktops: [{ id: COMPUTER_ID, name: 'Shared', status: 'stopped', workspace_id: WORKSPACE_ID }]
      })
    }

    return json({}, 404)
  }) as typeof fetch

  const workspaces = await listOrgoWorkspaces('orgo-secret', fetchImpl)
  const computers = await listOrgoComputers('orgo-secret', WORKSPACE_ID, fetchImpl)

  assert.deepEqual(workspaces, [{ id: WORKSPACE_ID, name: 'Bots', status: undefined }])
  assert.equal(computers[0]?.id, COMPUTER_ID)
  assert.equal(JSON.stringify(computers).includes('orgo-secret'), false)
  assert.equal(calls.some(url => url.includes('/computers')), false)
})

test('reuses the canonical shared computer when workspace summaries omit template metadata', () => {
  const computer = pickSharedHermesComputer(
    [
      {
        id: COMPUTER_ID,
        name: 'Shared computer',
        status: 'running'
      }
    ],
    BOT_TEMPLATE_REF
  )

  assert.equal(computer?.id, COMPUTER_ID)
})

test('pins the Bot product to its tested Orgo template', async () => {
  let requested = false

  const result = await withBotProduct(() =>
    resolveHermesAgentTemplateRef('orgo-secret', (async () => {
      requested = true

      return json({ templates: [{ ref: 'system/hermes-agent@9.9.9' }] })
    }) as typeof fetch)
  )

  assert.equal(result, BOT_TEMPLATE_REF)
  assert.equal(requested, false)
})

test('ensure-running starts a stopped computer then waits for running', async () => {
  const statuses = ['stopped', 'starting', 'running']

  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)

    if (url.endsWith('/start')) {
      return json({ success: true })
    }

    return json({ id: COMPUTER_ID, name: 'Shared', status: statuses.shift() || 'running' })
  }) as typeof fetch

  const computer = await ensureOrgoComputerRunning('orgo-secret', COMPUTER_ID, fetchImpl, async () => undefined)
  assert.equal(computer.status, 'running')
})

test('doctor reports auth, status, and VNC readiness', async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input)

    if (url.endsWith('/start')) {
      return json({ success: true })
    }

    if (url.endsWith('/vnc-password')) {
      return json({ password: 'vncsecret' })
    }

    if (url.endsWith('/bash')) {
      return json({ success: true, exit_code: 0, output: 'hermes 0.17.0' })
    }

    return json({
      id: COMPUTER_ID,
      name: 'Shared',
      status: 'running',
      instance_id: '8b517302'
    })
  }) as typeof fetch

  const result = await doctorOrgoComputer('orgo-secret', COMPUTER_ID, fetchImpl)
  assert.equal(result.ok, true)
  assert.equal(result.apiAuth, true)
  assert.equal(result.vncAvailable, true)
  assert.equal(result.mcpReady, true)
  assert.equal(result.hermesInstalled, true)
})

test('skips the installer when Hermes is already on PATH', async () => {
  const commands: string[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)

    if (url.endsWith('/bash')) {
      const body = JSON.parse(String(init?.body || '{}')) as { command?: string }
      commands.push(String(body.command || ''))

      return json({ success: true, exit_code: 0, output: 'hermes 0.17.0' })
    }

    return json({ id: COMPUTER_ID, name: 'Shared', status: 'running', instance_id: '8b517302' })
  }) as typeof fetch

  const result = await ensureHermesInstalledOnOrgo('orgo-secret', COMPUTER_ID, fetchImpl)
  assert.equal(result.installedNow, false)
  assert.equal(commands.some(command => command.includes('install.sh')), false)
})

test('parses Tailscale status and one-time login URLs', () => {
  assert.deepEqual(
    parseTailscaleStatus(
      JSON.stringify({
        BackendState: 'Running',
        Self: { DNSName: 'hermes-bots-ef2f6e29.example.ts.net.', Online: true }
      })
    ),
    {
      installed: true,
      connected: true,
      dnsName: 'hermes-bots-ef2f6e29.example.ts.net',
      backendState: 'Running',
      authUrl: ''
    }
  )
  assert.equal(
    extractTailscaleAuthUrl('To authenticate, visit: https://login.tailscale.com/a/abc_123'),
    'https://login.tailscale.com/a/abc_123'
  )
})

test('starts Tailscale and returns the VM authorization challenge', async () => {
  const commands: string[] = []
  const installTimeouts: number[] = []

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)

    if (url.endsWith('/bash')) {
      const body = JSON.parse(String(init?.body || '{}')) as { command?: string; timeout?: number }
      const command = String(body.command || '')
      commands.push(command)

      if (command.includes('nohup tailscale up')) {
        return json({ success: true, exit_code: 0, output: 'started' })
      }

      if (command === TAILSCALE_AUTH_POLL_COMMAND) {
        return json({
          success: true,
          exit_code: 0,
          output: '{"BackendState":"NeedsLogin"}\nhttps://login.tailscale.com/a/setup123'
        })
      }

      if (command.includes('tailscale.com/install.sh')) {
        installTimeouts.push(Number(body.timeout))

        if (installTimeouts.length === 1) {
          return json({ success: false, exit_code: 1, output: 'context canceled' })
        }
      }

      if (command.includes('tailscale status')) {
        return json({ success: true, exit_code: 0, output: '{"BackendState":"NeedsLogin"}' })
      }

      return json({ success: true, exit_code: 0, output: '' })
    }

    return json({ id: COMPUTER_ID, name: 'Shared', status: 'running', instance_id: '8b517302' })
  }) as typeof fetch

  const status = await beginOrgoTailscaleSetup('orgo-secret', COMPUTER_ID, fetchImpl, async () => undefined)
  assert.equal(status.authUrl, 'https://login.tailscale.com/a/setup123')
  assert.equal(commands.some(command => command.includes('command -v tailscaled')), true)
  assert.equal(commands.some(command => command.includes('/usr/sbin/tailscaled')), true)
  assert.equal(commands.some(command => command.includes('--tun=userspace-networking')), true)
  assert.equal(commands.some(command => command.includes('--ssh')), true)
  assert.equal(commands.some(command => command.includes('nohup tailscale up --json --ssh')), true)
  assert.equal(commands.some(command => command.includes("pkill -f '^tailscale (up|login)( |$)'")), true)
  assert.equal(commands.some(command => command.includes(TAILSCALE_AUTH_LOG_PATH)), true)
  assert.equal(commands.some(command => command.includes('timeout 12s tailscale up')), false)
  assert.equal(commands.some(command => command.includes('timeout 3s tailscale status')), true)
  assert.equal(commands.some(command => command.includes('pkill -x tailscaled')), true)
  assert.equal(commands.some(command => command.includes('nohup "$tailscaled_bin"')), true)
  assert.deepEqual(installTimeouts, [TAILSCALE_INSTALL_TIMEOUT_SECONDS, TAILSCALE_INSTALL_TIMEOUT_SECONDS])
})

test('waits for one authorization process instead of starting competing logins', async () => {
  const commands: string[] = []
  let pollCount = 0

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)

    if (url.endsWith('/bash')) {
      const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
      commands.push(command)

      if (command.includes('nohup tailscale up')) {
        return json({ success: true, exit_code: 0, output: 'started' })
      }

      if (command === TAILSCALE_AUTH_POLL_COMMAND) {
        pollCount += 1

        return pollCount === 13
          ? json({
              success: true,
              exit_code: 0,
              output: '{"BackendState":"NeedsLogin"}\nhttps://login.tailscale.com/a/delayed123'
            })
          : json({ success: true, exit_code: 0, output: '{"BackendState":"NeedsLogin"}' })
      }

      if (command.includes('tailscale status')) {
        return json({ success: true, exit_code: 0, output: '{"BackendState":"NeedsLogin"}' })
      }

      return json({ success: true, exit_code: 0, output: '' })
    }

    return json({ id: COMPUTER_ID, name: 'Shared', status: 'running', instance_id: '8b517302' })
  }) as typeof fetch

  const status = await beginOrgoTailscaleSetup('orgo-secret', COMPUTER_ID, fetchImpl, async () => undefined)
  assert.equal(status.authUrl, 'https://login.tailscale.com/a/delayed123')
  assert.equal(pollCount, 13)
  assert.equal(commands.filter(command => command.includes(`rm -f ${TAILSCALE_AUTH_LOG_PATH}`)).length, 1)
  assert.equal(commands.some(command => command.includes('tailscale up --json --ssh')), true)
  assert.equal(commands.some(command => command.includes('--force-reauth')), false)
  assert.equal(commands.some(command => command.includes('timeout 12s')), false)
})

test('reports a missing Tailscale authorization URL instead of silently stalling', async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith('/bash')) {
      return json({ id: COMPUTER_ID, name: 'Shared', status: 'running', instance_id: '8b517302' })
    }

    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')

    if (command === TAILSCALE_AUTH_POLL_COMMAND) {
      return json({ success: true, exit_code: 0, output: '{"BackendState":"NeedsLogin","AuthURL":""}' })
    }

    return json({ success: true, exit_code: 0, output: command.includes('nohup tailscale up') ? 'started' : '' })
  }) as typeof fetch

  await assert.rejects(
    beginOrgoTailscaleSetup('orgo-secret', COMPUTER_ID, fetchImpl, async () => undefined),
    error => {
      assert.match(String(error), /Tailscale registration did not return a sign-in link/)
      assert.equal(String(error).includes('"BackendState"'), false)
      assert.equal(String(error).length < 240, true)

      return true
    }
  )
})

test('reports a live Tailscale coordination outage without blaming the user plan', async () => {
  let statusRequestHadAuthorization = false

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)

    if (url === TAILSCALE_STATUS_SUMMARY_URL) {
      statusRequestHadAuthorization = new Headers(init?.headers).has('Authorization')

      return json({
        components: [{ name: 'Coordination service', status: 'partial_outage' }]
      })
    }

    if (!url.endsWith('/bash')) {
      return json({ id: COMPUTER_ID, name: 'Shared', status: 'running', instance_id: '8b517302' })
    }

    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')

    return json({
      success: true,
      exit_code: 0,
      output:
        command === TAILSCALE_AUTH_POLL_COMMAND
          ? '{"BackendState":"NeedsLogin","AuthURL":""}'
          : command.includes('nohup tailscale up')
            ? 'started'
            : ''
    })
  }) as typeof fetch

  await assert.rejects(
    beginOrgoTailscaleSetup('orgo-secret', COMPUTER_ID, fetchImpl, async () => undefined),
    error => {
      assert.match(String(error), /currently reporting a coordination-service outage/)
      assert.match(String(error), /not related to your Tailscale plan/)
      assert.match(String(error), /status\.tailscale\.com/)

      return true
    }
  )
  assert.equal(statusRequestHadAuthorization, false)
})

test('writes the Orgo key to the remote secret env rather than MCP config', async () => {
  let command = ''

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  await persistOrgoEnvironmentOnRemote('orgo-secret', COMPUTER_ID, fetchImpl)
  assert.match(command, /ORGO_API_KEY/)
  assert.equal(command.includes('orgo-secret'), false)
  assert.match(command, /chmod/)
  assert.match(command, /SOUL\.md/)
  assert.match(command, /upsert_soul/)
  assert.match(command, /os\.replace\(temporary, soul\)/)
  assert.equal(command.includes(ORGO_RUNTIME_POLICY_START), true)
  assert.equal(command.includes(ORGO_RUNTIME_POLICY_END), true)

  // Execute the exact shell argument transport, replacing only the remote root
  // with a temporary directory inside Python before executing the received code.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orgo-env-'))
  const soul = path.join(root, 'SOUL.md')
  fs.writeFileSync(soul, 'My existing agent.\n')
  fs.writeFileSync(path.join(root, '.env'), 'EXISTING=value\nORGO_API_KEY=old\n')
  const shim = path.join(root, 'python3')
  fs.writeFileSync(shim, '#!/bin/sh\nexec /usr/bin/python3 -c \'import os,sys; exec(sys.argv[2].replace("/root/.hermes", os.environ["ORGO_TEST_ROOT"]))\' "$@"\n', { mode: 0o700 })

  try {
    for (let run = 0; run < 2; run += 1) {
      const result = spawnSync('/bin/sh', ['-c', command], {
        env: { ...process.env, PATH: root + ':' + process.env.PATH, ORGO_TEST_ROOT: root },
        encoding: 'utf8'
      })

      assert.equal(result.status, 0, result.stderr)
    }

    assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'),
      'EXISTING=value\nORGO_API_KEY=orgo-secret\nORGO_DEFAULT_COMPUTER_ID=' + COMPUTER_ID + '\n')
    const updated = fs.readFileSync(soul, 'utf8')
    assert.ok(updated.startsWith('My existing agent.\n\n'))
    assert.equal(updated.split(ORGO_RUNTIME_POLICY_START).length, 2)
    assert.equal(updated.split(ORGO_RUNTIME_POLICY_END).length, 2)
    assert.equal(fs.statSync(path.join(root, '.env')).mode & 0o777, 0o600)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('agent import probe preserves Python newlines through the shell', () => {
  const probe = buildOrgoAgentMcpProbeCommand('a'.repeat(64))
  const invocation = probe.slice(probe.lastIndexOf(' && ') + 4)

  const compile = invocation.replace(ORGO_AGENT_MCP_COMMAND,
    "python3 -c 'import sys; compile(sys.argv[2], \"probe\", \"exec\")'")

  const result = spawnSync('/bin/sh', ['-c', compile], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('wallpaper probe checks the silk asset md5 before installing', () => {
  assert.match(ORGO_WALLPAPER_PROBE_COMMAND, /desktop-silk-wallpaper\.png/)
  assert.match(ORGO_WALLPAPER_PROBE_COMMAND, /7febc8b0943cddc162bb544de31008bb/)
})

test('wallpaper apply command supports GNOME, XFCE, and PCManFM desktops', () => {
  const command = buildOrgoWallpaperApplyCommand()

  assert.match(command, new RegExp(ORGO_SILK_WALLPAPER_PATH.replace(/\//g, '\\/')))
  assert.match(command, /picture-options 'scaled'/)
  assert.match(command, /xfconf-query -c xfce4-desktop/)
  assert.match(command, /xfdesktop --reload/)
  assert.match(command, /pcmanfm --set-wallpaper/)
})

test('wallpaper install stages bounded chunks and writes both target paths', () => {
  const commands = buildOrgoWallpaperInstallCommands('aGVsbG8=')
  const finalCommand = commands.at(-1) || ''
  const encodedScript = finalCommand.match(/printf %s "([^"]+)" \| base64 -d \| python3/)?.[1] || ''
  const script = Buffer.from(encodedScript, 'base64').toString('utf8')

  assert.equal(commands.length, 3)
  assert.match(commands[0] || '', new RegExp(ORGO_WALLPAPER_STAGING_PATH))
  assert.match(commands[1] || '', /aGVsbG8=/)
  assert.match(script, /desktop-silk-wallpaper\.png/)
  assert.match(script, /orgo-background\.png/)
})

test('wallpaper upload commands stay below the Orgo request limit', () => {
  const commands = buildOrgoWallpaperInstallCommands(Buffer.alloc(944_614).toString('base64'))
  const chunkCommands = commands.slice(1, -1)

  assert.equal(chunkCommands.length > 1, true)
  assert.equal(
    chunkCommands.every(command => command.length <= ORGO_WALLPAPER_UPLOAD_CHUNK_SIZE + 128),
    true
  )
})

test('ensureOrgoDesktopWallpaper skips upload when the silk asset is already present', async () => {
  const commands: string[] = []

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command === ORGO_WALLPAPER_PROBE_COMMAND) {
      return json({ success: true, exit_code: 0, output: '' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  const result = await ensureOrgoDesktopWallpaper('orgo-secret', COMPUTER_ID, () => Buffer.from('unused'), fetchImpl)

  assert.equal(result.installedNow, false)
  assert.equal(result.applied, true)
  assert.equal(commands.length, 2)
  assert.match(commands[1] || '', /gsettings set org\.gnome\.desktop\.background picture-uri/)
})

test('ensureOrgoDesktopWallpaper uploads the bundled asset when missing', async () => {
  const commands: string[] = []
  let probeCount = 0

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command === ORGO_WALLPAPER_PROBE_COMMAND) {
      probeCount += 1

      return probeCount === 1
        ? json({ success: false, exit_code: 1, output: 'missing' })
        : json({ success: true, exit_code: 0, output: 'verified' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  const result = await ensureOrgoDesktopWallpaper(
    'orgo-secret',
    COMPUTER_ID,
    () => Buffer.from('wallpaper-bytes'),
    fetchImpl
  )

  assert.equal(result.installedNow, true)
  assert.equal(result.applied, true)
  assert.equal(commands.length, 6)
  assert.match(commands[1] || '', new RegExp(ORGO_WALLPAPER_STAGING_PATH))
  assert.match(commands[2] || '', /d2FsbHBhcGVyLWJ5dGVz/)
  assert.match(commands[3] || '', /\| base64 -d \| python3/)
  assert.match(commands[4] || '', /xfconf-query/)
  assert.equal(commands[5], ORGO_WALLPAPER_PROBE_COMMAND)
})

test('ensureOrgoDesktopWallpaper removes staging data when a chunk fails', async () => {
  const commands: string[] = []

  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const command = String((JSON.parse(String(init?.body || '{}')) as { command?: string }).command || '')
    commands.push(command)

    if (command === ORGO_WALLPAPER_PROBE_COMMAND) {
      return json({ success: false, exit_code: 1, output: 'missing' })
    }

    if (command.startsWith('printf %s') && command.includes(`>> ${ORGO_WALLPAPER_STAGING_PATH}`)) {
      return json({ success: false, exit_code: 1, output: 'write failed' })
    }

    return json({ success: true, exit_code: 0, output: '' })
  }) as typeof fetch

  await assert.rejects(
    ensureOrgoDesktopWallpaper('orgo-secret', COMPUTER_ID, () => Buffer.from('wallpaper-bytes'), fetchImpl),
    /write failed/
  )
  assert.match(commands.at(-1) || '', new RegExp(`rm -f ${ORGO_WALLPAPER_STAGING_PATH}`))
})

test('Studio never adopts original-product workspaces', () => {
  assert.equal(BOT_ORGO_WORKSPACE_NAME, 'Revenue Partner Studio')
  assert.deepEqual(BOT_ORGO_LEGACY_WORKSPACE_NAMES, [])
  assert.equal(pickOrgoWorkspaceByName([{id:'original',name:'Orgo AI Guy Bot'}], BOT_ORGO_WORKSPACE_NAME), undefined)
})

test('Studio blocks account provisioning before the network write', async () => {
  let writes=0
  const fetchImpl=(async (_url: unknown,init?:RequestInit) => {
    if(init?.method==='POST') writes++
    return json({projects:[],desktops:[]})
  }) as typeof fetch
  await assert.rejects(createOrgoComputer('test', {workspaceId:WORKSPACE_ID}, fetchImpl), /cannot provision/)
  await assert.rejects(findOrCreateOrgoWorkspace('test',BOT_ORGO_WORKSPACE_NAME,[],fetchImpl), /cannot provision/)
  await assert.rejects(findOrCreateSharedHermesComputer('test',{workspaceId:WORKSPACE_ID,name:'Shared computer',templateRef:BOT_TEMPLATE_REF},fetchImpl), /cannot provision/)
  assert.equal(writes,0)
})

test('Studio checks only its installed runtime and never installs a replacement', async () => {
  const commands:string[]=[]
  let installed=false
  const fetchImpl=(async (_url:unknown,init?:RequestInit) => {
    commands.push(JSON.parse(String(init?.body)).command)
    return json({success:installed,output:installed?'Hermes Studio':'missing'})
  }) as typeof fetch
  await assert.rejects(ensureHermesInstalledOnOrgo('test',COMPUTER_ID,fetchImpl), /Automatic upstream updates are disabled/)
  installed=true
  const result=await ensureHermesInstalledOnOrgo('test',COMPUTER_ID,fetchImpl)
  assert.equal(result.installed,true)
  assert.equal(result.installedNow,false)
  assert.equal(result.updatedNow,false)
  assert.deepEqual(commands,Array(2).fill('/opt/hermes-orgo-studio/venv/bin/hermes --version'))
})

test('Studio never installs the inherited remote maintenance scheduler', async () => {
  let called=false
  const fetchImpl=(async () => {called=true;return json({})}) as typeof fetch
  const result=await ensureOrgoMaintenanceInstalled('test',COMPUTER_ID,()=>{throw new Error('must not read inherited assets')},fetchImpl)
  assert.equal(result.installedNow,false)
  assert.equal(called,false)
})
