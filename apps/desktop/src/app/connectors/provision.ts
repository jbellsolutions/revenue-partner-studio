import { getProfiles } from '@/hermes'
import { $gateway } from '@/store/gateway'
import { $activeSessionId } from '@/store/session'

import { rosterProfileNames } from './mcp'

export async function syncConnectorsToRoster(profiles?: Array<{ name?: string }>): Promise<void> {
  const api = window.hermesDesktop?.connectors

  if (!api?.syncProfiles) {
    return
  }

  const names = profiles ? rosterProfileNames(profiles) : rosterProfileNames((await getProfiles()).profiles)

  await api.syncProfiles(names)

  await window.hermesDesktop?.orgoDesktop?.syncProfiles?.(names).catch(() => undefined)

  const gateway = $gateway.get()

  if (gateway) {
    await gateway.request('reload.mcp', { confirm: true, session_id: $activeSessionId.get() ?? undefined }).catch(() => undefined)
  }
}
