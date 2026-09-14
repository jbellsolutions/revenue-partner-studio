/** Managed screens run on the bound Linux host. This module only tunnels them. */
import { normalizeOrgoComputerId } from './orgo-desktop'

export const SCREEN_CONTROL = '/root/.hermes/orgo-computer/control'
interface ScreenSsh {
  exec(command: string, options?: { timeoutMs?: number }): Promise<string>
  forward(localPort: number, remotePort: number): Promise<unknown>
}
interface ScreenInfo {
  computerId: string
  profile: string
  display: string
  wsPort: number
  paused: boolean
}

function profileName(profile: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(profile)) {
    throw new Error('Invalid agent screen profile.')
  }

  return profile
}

export async function screenCommand(
  ssh: ScreenSsh, computerId: string, profile: string, operation: 'ensure' | 'pause' | 'resume'
): Promise<ScreenInfo | null> {
  const id = normalizeOrgoComputerId(computerId)
  const name = profileName(profile)

  // Only an explicitly absent capability permits the legacy main-screen path.
  // A timeout, failed service, or wrong binding must never silently retarget.
  const output = await ssh.exec(
    `if test -x ${SCREEN_CONTROL}; then ORGO_DEFAULT_COMPUTER_ID=${id} ${SCREEN_CONTROL} ${operation} ${name}; else echo ORGO_SCREEN_UNSUPPORTED; fi`,
    { timeoutMs: 90_000 }
  )

  if (output.trim() === 'ORGO_SCREEN_UNSUPPORTED') {return null}
  const result = JSON.parse(output) as ScreenInfo

  if (result.computerId !== id || result.profile !== name ||
      !/^:(99|100|101|102)$/.test(result.display) ||
      result.wsPort !== 6100 + Number(result.display.slice(1)) || typeof result.paused !== 'boolean') {
    throw new Error('Cloud screen identity did not match the selected computer and agent.')
  }

  return result
}

const forwards = new WeakMap<ScreenSsh, Map<string, Promise<number>>>()

/** Older hosts have the standard Orgo VNC service but no managed-screen control.
 * Reuse their authenticated SSH connection, not the public desktop proxy. */
export async function legacyScreenSession(
  ssh: ScreenSsh, computerId: string, password: string, pickPort: () => Promise<number>
): Promise<{ websocketUrl: string }> {
  const id = normalizeOrgoComputerId(computerId)

  if (!password) {throw new Error('A desktop credential is required.')}
  let cache = forwards.get(ssh)

  if (!cache) { cache = new Map(); forwards.set(ssh, cache) }
  const key = `${id}:legacy`
  let pending = cache.get(key)

  if (!pending) {
    pending = (async () => {
      const localPort = await pickPort()
      await ssh.forward(localPort, 6080)

      return localPort
    })()
    cache.set(key, pending)
    pending.catch(() => cache?.delete(key))
  }

  return { websocketUrl: `ws://127.0.0.1:${await pending}/websockify?token=${encodeURIComponent(password)}` }
}

export async function managedScreenSession(
  ssh: ScreenSsh, computerId: string, profile: string, pickPort: () => Promise<number>
): Promise<{ websocketUrl: string; managedScreen: true; paused: boolean; screenProfile: string } | null> {
  const info = await screenCommand(ssh, computerId, profile, 'ensure')

  if (!info) {return null}
  let cache = forwards.get(ssh)

  if (!cache) { cache = new Map(); forwards.set(ssh, cache) }
  const key = `${computerId}:${profile}`
  let pending = cache.get(key)

  if (!pending) {
    pending = (async () => {
      const localPort = await pickPort()
      await ssh.forward(localPort, info.wsPort)

      return localPort
    })()
    cache.set(key, pending)
    pending.catch(() => cache?.delete(key))
  }

  return { websocketUrl: `ws://127.0.0.1:${await pending}`, managedScreen: true,
    paused: info.paused, screenProfile: info.profile }
}

/** Existing Hermes computers share the actual Orgo desktop. Their presence of a
 * screen controller does not establish that their agents use Studio's displays. */
export async function workspaceScreenSession(
  ssh: ScreenSsh, computerId: string, profile: string, password: string,
  pickPort: () => Promise<number>, workspace: 'hermes' | 'studio'
) {
  if (workspace === 'hermes') {
    return { ...await legacyScreenSession(ssh, computerId, password, pickPort), sharedScreen: true as const }
  }
  return managedScreenSession(ssh, computerId, profile, pickPort)
}
