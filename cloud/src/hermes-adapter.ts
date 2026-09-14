import { rpc } from './api'
import { invalidateModels } from './model-catalog'

/** Browser transport for the inherited Hermes workflows. Never uses a global gateway. */
export function hermesAdapter(computer: string, profile: string, runtimeId?: string) {
  const call = (method: string, params: Record<string, unknown> = {}) =>
    rpc(computer, method, { ...params, agentId: profile, ...(runtimeId ? { runtimeId } : {}) })
  return {
    key: JSON.stringify([computer, profile, runtimeId || '']),
    models: (refresh = false) => call('models.options', { refresh }),
    selectModel: (provider: string, model: string) => call('models.select', { provider, model }),
    modelStatus: () => call('models.status'),
    keys: () => call('providers.keys'),
    async saveAndCheck(provider: string, apiKey: string, saved: () => void = () => {}) {
      await call('providers.configure', { provider, apiKey: apiKey.trim() })
      invalidateModels(computer, profile)
      saved()
      return call('providers.check', { provider })
    },
    checkKey: (provider: string) => call('providers.check', { provider }),
    skill: (id: string, enabled: boolean) => call('skills.update', { id, enabled })
  }
}
