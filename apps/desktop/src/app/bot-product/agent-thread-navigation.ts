import { atom } from 'nanostores'

import type { TaskUpdate } from '@/types/hermes'

type AgentThreadOpener = (profile: string, storedSessionId: string) => Promise<unknown>

// One window's Bot controller owns profile selection and navigation intent.
// A result notice offers that same action; it never switches computers or
// opens a transcript merely because a background result arrived.
export const $agentThreadOpener = atom<AgentThreadOpener | null>(null)

export function registerAgentThreadOpener(open: AgentThreadOpener): () => void {
  $agentThreadOpener.set(open)

  return () => {
    if ($agentThreadOpener.get() === open) {
      $agentThreadOpener.set(null)
    }
  }
}

export function taskWorkerThread(update: Partial<TaskUpdate>): { profile: string; sessionId: string } | null {
  const profile = update.worker
  const sessionId = update.worker_session_id

  // Metadata is data, never a URL, pathname or instruction. Older deliveries
  // without an exact worker reference remain readable but cannot be guessed.
  return typeof profile === 'string' &&
    profile === profile.trim() &&
    /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile) &&
    typeof sessionId === 'string' &&
    sessionId === sessionId.trim() &&
    /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(sessionId)
    ? { profile, sessionId }
    : null
}
