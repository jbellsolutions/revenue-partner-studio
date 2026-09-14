/**
 * Encrypted-at-rest persistence for the Composio BYOK connector broker.
 *
 * Patterned after native-token-store.ts: the file on disk is an opaque
 * safeStorage blob (mode 0600 under userData). The API key never leaves this
 * privileged process in plaintext — not logs, not crash dumps, not renderer
 * IPC. Kept free of `import 'electron'` so the round trip unit-tests with the
 * electron vitest project.
 */

export interface StoredSecret {
  encoding?: string
  value?: string
}

export interface ComposioStoreIo {
  encrypt: (plaintext: string) => StoredSecret | null
  decrypt: (secret: unknown) => string
  readStoreText: () => string
  writeStoreText: (text: string) => void
  rememberLog?: (message: string) => void
}

export interface ComposioProfileSession {
  sessionId: string
  toolkitKey: string
}

export interface ComposioStoredState {
  apiKey: string
  userId: string
  keyHint: string
  sessions: Record<string, ComposioProfileSession>
}

const EMPTY_STATE: ComposioStoredState = {
  apiKey: '',
  userId: '',
  keyHint: '',
  sessions: {}
}

function readEnvelope(io: ComposioStoreIo): StoredSecret | null {
  try {
    const parsed = JSON.parse(io.readStoreText())

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    if (typeof parsed.encoding === 'string' && typeof parsed.value === 'string') {
      return parsed as StoredSecret
    }

    return null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code

    if (code !== 'ENOENT') {
      io.rememberLog?.('[composio] failed to read connector store; treating as empty')
    }

    return null
  }
}

function parseState(plaintext: string): ComposioStoredState | null {
  try {
    const parsed = JSON.parse(plaintext)

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }

    const apiKey = typeof parsed.apiKey === 'string' ? parsed.apiKey : ''
    const userId = typeof parsed.userId === 'string' ? parsed.userId : ''
    const keyHint = typeof parsed.keyHint === 'string' ? parsed.keyHint : ''
    const sessions: Record<string, ComposioProfileSession> = {}

    if (parsed.sessions && typeof parsed.sessions === 'object' && !Array.isArray(parsed.sessions)) {
      for (const [profile, value] of Object.entries(parsed.sessions)) {
        const row = value as ComposioProfileSession

        if (!profile || !row || typeof row.sessionId !== 'string' || typeof row.toolkitKey !== 'string') {
          continue
        }

        sessions[profile] = { sessionId: row.sessionId, toolkitKey: row.toolkitKey }
      }
    }

    return { apiKey, userId, keyHint, sessions }
  } catch {
    return null
  }
}

export function loadComposioState(io: ComposioStoreIo): ComposioStoredState | null {
  const envelope = readEnvelope(io)

  if (!envelope) {
    return null
  }

  const plaintext = io.decrypt(envelope)

  if (!plaintext) {
    io.rememberLog?.('[composio] failed to decrypt connector store; keeping stored entry for retry')

    return null
  }

  return parseState(plaintext)
}

export function persistComposioState(state: ComposioStoredState | null, io: ComposioStoreIo): void {
  if (!state) {
    io.writeStoreText(JSON.stringify({}))

    return
  }

  const secret = io.encrypt(JSON.stringify(state))

  if (!secret) {
    throw new Error('Secure connector storage returned no encrypted payload; refusing to overwrite the saved key.')
  }

  io.writeStoreText(JSON.stringify(secret))
}

export function emptyComposioState(): ComposioStoredState {
  return { ...EMPTY_STATE, sessions: {} }
}

export function createComposioStore(io: ComposioStoreIo) {
  return {
    load: () => loadComposioState(io),
    save: (state: ComposioStoredState) => persistComposioState(state, io),
    clear: () => persistComposioState(null, io)
  }
}

export type ComposioStore = ReturnType<typeof createComposioStore>
