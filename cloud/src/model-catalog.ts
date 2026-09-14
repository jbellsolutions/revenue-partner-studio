import { rpc } from './api'
export type ModelProvider = { slug: string; name: string; authenticated?: boolean; models: string[] }
export type ModelSelection = {
  model: string
  provider: string
  state: 'applied' | 'pending' | 'error'
  activeModel?: string
  activeProvider?: string
  error?: string
}
const entries = new Map<string, { expires: number; promise: Promise<ModelProvider[]> }>()
export function invalidateModels(computer?: string, profile?: string) {
  for (const key of entries.keys()) {
    const [c, p] = JSON.parse(key)
    if ((!computer || c === computer) && (!profile || p === profile)) entries.delete(key)
  }
}
// Only provider metadata is cached, never credentials. Profiles with the same
// name on different computers have independent catalogs and in-flight requests.
export function modelCatalog(computer: string, profile: string, refresh = false): Promise<ModelProvider[]> {
  const key = JSON.stringify([computer, profile]),
    cached = entries.get(key)
  if (!refresh && cached && cached.expires > Date.now()) return cached.promise
  const entry = { expires: Date.now() + 300_000, promise: Promise.resolve([] as ModelProvider[]) }
  entry.promise = rpc(computer, 'models.options', { agentId: profile, refresh })
    .then(r =>
      (r.providers || []).map((p: ModelProvider) => ({
        ...p,
        models: (p.models || []).filter(m => typeof m === 'string')
      }))
    )
    .catch(e => {
      if (entries.get(key) === entry) entries.delete(key)
      throw e
    })
  entries.set(key, entry)
  return entry.promise
}
