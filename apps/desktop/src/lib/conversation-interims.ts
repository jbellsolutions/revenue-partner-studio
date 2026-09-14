import { type ChatMessage, chatMessageText } from '@/lib/chat-messages'

/**
 * Desktop-side durability for real, model-authored mid-turn commentary.
 *
 * Current Hermes backends persist tool-call assistant rows before executing a
 * tool. Older remote backends did not, even though they still emitted the
 * corresponding `message.interim` event. Keep a small transcript overlay so a
 * conversational "On it…" bubble does not disappear when Desktop reconnects
 * to one of those backends. Machine activity never enters this store.
 */

const STORAGE_PREFIX = 'hermes.desktop.conversationInterims.v1:'
const MAX_TURNS = 80
const MAX_AGE_MS = 45 * 24 * 60 * 60 * 1000

interface PersistedInterimTurn {
  finalText?: string
  interimTexts: string[]
  updatedAt: number
  userOccurrence: number
  userSignature: string
}

interface PersistedInterimStore {
  turns: PersistedInterimTurn[]
  version: 1
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

const entryKey = (storedSessionId: string) => `${STORAGE_PREFIX}${storedSessionId}`
const normalize = (value: string) => value.replace(/\s+/g, ' ').trim()

function messageSignature(message: ChatMessage): string {
  return `${normalize(chatMessageText(message))}\n${(message.attachmentRefs ?? []).join('\n')}`
}

function loadTurns(storedSessionId: string): PersistedInterimTurn[] {
  const store = storage()

  if (!store) {
    return []
  }

  try {
    const raw = store.getItem(entryKey(storedSessionId))
    const parsed = raw ? (JSON.parse(raw) as PersistedInterimStore) : null

    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.turns)) {
      return []
    }

    const oldest = Date.now() - MAX_AGE_MS

    return parsed.turns
      .filter(
        turn =>
          turn &&
          typeof turn.userSignature === 'string' &&
          typeof turn.userOccurrence === 'number' &&
          typeof turn.updatedAt === 'number' &&
          turn.updatedAt >= oldest &&
          Array.isArray(turn.interimTexts)
      )
      .slice(-MAX_TURNS)
  } catch {
    return []
  }
}

function saveTurns(storedSessionId: string, turns: PersistedInterimTurn[]): void {
  try {
    storage()?.setItem(
      entryKey(storedSessionId),
      JSON.stringify({ turns: turns.slice(-MAX_TURNS), version: 1 } satisfies PersistedInterimStore)
    )
  } catch {
    // Best effort: old/corrupt storage must never interfere with chat.
  }
}

function lastUserTurn(messages: ChatMessage[]): {
  finalText?: string
  interimTexts: string[]
  userOccurrence: number
  userSignature: string
} | null {
  let userIndex = -1

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user' && !messages[index]?.hidden) {
      userIndex = index

      break
    }
  }

  if (userIndex < 0) {
    return null
  }

  const userSignature = messageSignature(messages[userIndex])
  let userOccurrence = 0

  for (let index = 0; index <= userIndex; index += 1) {
    const message = messages[index]

    if (message?.role === 'user' && !message.hidden && messageSignature(message) === userSignature) {
      userOccurrence += 1
    }
  }

  const assistants = messages
    .slice(userIndex + 1)
    .filter(message => message.role === 'assistant' && !message.hidden && normalize(chatMessageText(message)))

  const interimTexts = assistants.filter(message => message.interim).map(message => normalize(chatMessageText(message)))
  const finalText = [...assistants].reverse().find(message => !message.interim)

  return {
    ...(finalText ? { finalText: normalize(chatMessageText(finalText)) } : {}),
    interimTexts: [...new Set(interimTexts)],
    userOccurrence,
    userSignature
  }
}

/** Capture the current turn after an interim seal or final completion. */
export function rememberConversationInterims(storedSessionId: null | string, messages: ChatMessage[]): void {
  if (!storedSessionId) {
    return
  }

  const turn = lastUserTurn(messages)

  if (!turn || turn.interimTexts.length === 0) {
    return
  }

  const turns = loadTurns(storedSessionId)

  const existingIndex = turns.findIndex(
    item => item.userSignature === turn.userSignature && item.userOccurrence === turn.userOccurrence
  )

  const next: PersistedInterimTurn = { ...turn, updatedAt: Date.now() }

  if (existingIndex >= 0) {
    turns[existingIndex] = next
  } else {
    turns.push(next)
  }

  saveTurns(storedSessionId, turns)
}

function stableId(turn: PersistedInterimTurn, text: string, index: number): string {
  const input = `${turn.userSignature}\u0000${turn.userOccurrence}\u0000${text}\u0000${index}`
  let hash = 2166136261

  for (let cursor = 0; cursor < input.length; cursor += 1) {
    hash ^= input.charCodeAt(cursor)
    hash = Math.imul(hash, 16777619)
  }

  return `persisted-interim-${(hash >>> 0).toString(36)}`
}

/**
 * Reinsert locally-captured commentary into an authoritative REST transcript.
 * The saved final answer is the safety anchor: if it no longer exists after
 * an edit/rewind, the overlay is ignored instead of attaching to the wrong
 * repeated prompt.
 */
export function restoreConversationInterims(storedSessionId: null | string, messages: ChatMessage[]): ChatMessage[] {
  if (!storedSessionId) {
    return messages
  }

  const turns = loadTurns(storedSessionId)

  if (turns.length === 0) {
    return messages
  }

  let restored = messages

  for (const turn of turns) {
    if (!turn.finalText) {
      continue
    }

    let occurrence = 0
    let userIndex = -1

    for (let index = 0; index < restored.length; index += 1) {
      const message = restored[index]

      if (message?.role === 'user' && !message.hidden && messageSignature(message) === turn.userSignature) {
        occurrence += 1

        if (occurrence === turn.userOccurrence) {
          userIndex = index

          break
        }
      }
    }

    if (userIndex < 0) {
      continue
    }

    const nextUserOffset = restored
      .slice(userIndex + 1)
      .findIndex(message => message.role === 'user' && !message.hidden)

    const turnEnd = nextUserOffset < 0 ? restored.length : userIndex + 1 + nextUserOffset

    const finalOffset = restored
      .slice(userIndex + 1, turnEnd)
      .findIndex(
        message =>
          message.role === 'assistant' && !message.hidden && normalize(chatMessageText(message)) === turn.finalText
      )

    if (finalOffset < 0) {
      continue
    }

    const finalIndex = userIndex + 1 + finalOffset

    const existingTexts = new Set(
      restored.slice(userIndex + 1, finalIndex + 1).map(message => normalize(chatMessageText(message)))
    )

    const missingTexts = turn.interimTexts.filter(text => text !== turn.finalText && !existingTexts.has(text))

    if (missingTexts.length === 0) {
      continue
    }

    const restoredInterims: ChatMessage[] = missingTexts.map((text, index) => ({
      id: stableId(turn, text, index),
      role: 'assistant',
      parts: [{ type: 'text', text }],
      interim: true,
      timestamp: restored[finalIndex]?.timestamp
    }))

    restored = [...restored.slice(0, finalIndex), ...restoredInterims, ...restored.slice(finalIndex)]
  }

  return restored
}

export function clearConversationInterims(storedSessionId: null | string): void {
  if (!storedSessionId) {
    return
  }

  try {
    storage()?.removeItem(entryKey(storedSessionId))
  } catch {
    // Best effort, like every other operation in this compatibility overlay.
  }
}
