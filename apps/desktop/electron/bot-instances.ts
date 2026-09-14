import fs from 'node:fs'
import path from 'node:path'

import { BOT_INSTANCE_ARG, parseBotInstanceName } from './product'

export interface BotInstanceSummary {
  name: string
  computerId: string
  current: boolean
  unreadable: boolean
  cloudName?: string
  cloudStatus?: string
  availability?: 'available' | 'missing' | 'unknown'
}

/** Refresh only facts from the current account; never change a saved binding.
 * A timeout/auth error is unknown, not proof that a computer was deleted. */
export async function refreshBotInstances(
  instances: BotInstanceSummary[],
  lookup: (computerId: string) => Promise<{ id: string; name: string; status: string }>
): Promise<BotInstanceSummary[]> {
  const reads = new Map<string, Promise<Partial<BotInstanceSummary>>>()

  return Promise.all(instances.map(async instance => {
    if (!instance.computerId || instance.unreadable) {
      return instance
    }

    if (!reads.has(instance.computerId)) {
      reads.set(instance.computerId, (async (): Promise<Partial<BotInstanceSummary>> => {
        try {
          const computer = await lookup(instance.computerId)

          if (computer.id !== instance.computerId) {
            return { availability: 'unknown' }
          }

          return { cloudName: computer.name, cloudStatus: computer.status, availability: 'available' }
        } catch (error) {
          return { availability: (error as { code?: string })?.code === 'computer-not-found' ? 'missing' : 'unknown' }
        }
      })())
    }

    return { ...instance, ...await reads.get(instance.computerId) }
  }))
}

export function validateBotInstance(name: unknown): string {
  if (typeof name !== 'string') {
    throw new Error('An instance name is required.')
  }

  return name === '' ? '' : parseBotInstanceName([`${BOT_INSTANCE_ARG}=${name}`])
}

/** Read bindings only. Never decrypt or return another window's credentials. */
export function listBotInstances(root: string, current: string): BotInstanceSummary[] {
  const directory = path.join(root, 'instances')
  const names = new Set(['', current])

  if (fs.existsSync(directory)) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        continue
      }

      try {
        if (validateBotInstance(entry.name) === entry.name) {
          names.add(entry.name)
        }
      } catch {
        /* Ignore unrelated directories, never reinterpret them as paths. */
      }
    }
  }

  return [...names].sort().map(name => {
    const file = path.join(name ? path.join(directory, name) : root, 'orgo-desktop.json')

    try {
      if (!fs.existsSync(file)) {
        return { name, computerId: '', current: name === current, unreadable: false }
      }

      if (fs.lstatSync(file).isSymbolicLink()) {
        throw new Error('Linked configuration')
      }

      const config = JSON.parse(fs.readFileSync(file, 'utf8'))
      const id = config?.profiles?.default?.computerId

      let label = {}
      try {const meta=JSON.parse(fs.readFileSync(path.join(path.dirname(file),'studio-window.json'),'utf8'));if(typeof meta.name==='string') label={cloudName:meta.name}} catch { /* Older windows have no display label. */ }
      return { name, computerId: typeof id === 'string' ? id : '', current: name === current, unreadable: false, ...label }
    } catch {
      return { name, computerId: '', current: name === current, unreadable: true }
    }
  })
}

/** A new process uses its own Electron lock; an existing instance gets focused.
 * Never carry the current instance's home, connection, or auth overrides over. */
export function botInstanceLaunch(name: unknown, executable: string, platform: string, env: NodeJS.ProcessEnv) {
  const instance = validateBotInstance(name)
  const args = instance ? [`${BOT_INSTANCE_ARG}=${instance}`] : ['--studio-primary']

  const osEnvironment =
    /^(?:HOME|USER|LOGNAME|PATH|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XDG_.*|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|SystemRoot|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|COMSPEC|PATHEXT)$/i

  const cleanEnv = Object.fromEntries(Object.entries(env).filter(([key]) => osEnvironment.test(key)))

  return platform === 'darwin'
    ? {
        command: '/usr/bin/open',
        args: ['-na', path.resolve(executable, '../../..'), ...(args.length ? ['--args', ...args] : [])],
        env: cleanEnv
      }
    : { command: executable, args, env: cleanEnv }
}
