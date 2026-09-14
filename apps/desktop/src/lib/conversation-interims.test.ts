import { beforeEach, describe, expect, it } from 'vitest'

import { assistantTextPart, type ChatMessage, chatMessageText, textPart } from '@/lib/chat-messages'

import {
  clearConversationInterims,
  rememberConversationInterims,
  restoreConversationInterims
} from './conversation-interims'

const SID = 'stored-conversation'

const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', parts: [textPart(text)] })

const assistant = (id: string, text: string, interim = false): ChatMessage => ({
  id,
  role: 'assistant',
  parts: [assistantTextPart(text)],
  ...(interim ? { interim: true } : {})
})

const texts = (messages: ChatMessage[]) => messages.map(chatMessageText)

describe('conversation interim persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('restores real commentary before its anchored final reply', () => {
    rememberConversationInterims(SID, [
      user('u1', 'check my email'),
      assistant('i1', "On it, pulling yesterday's emails now.", true),
      assistant('i2', 'I found the relevant threads and am checking dates.', true),
      assistant('a1', 'Yesterday was mostly quiet.')
    ])

    const restored = restoreConversationInterims(SID, [
      user('stored-u1', 'check my email'),
      assistant('stored-a1', 'Yesterday was mostly quiet.')
    ])

    expect(texts(restored)).toEqual([
      'check my email',
      "On it, pulling yesterday's emails now.",
      'I found the relevant threads and am checking dates.',
      'Yesterday was mostly quiet.'
    ])
    expect(restored[1].interim).toBe(true)
    expect(restored[2].interim).toBe(true)
  })

  it('does not duplicate interims already persisted by a newer backend', () => {
    const live = [
      user('u1', 'inspect the profile'),
      assistant('i1', "I'm checking the profile now.", true),
      assistant('a1', 'default')
    ]

    rememberConversationInterims(SID, live)

    const restored = restoreConversationInterims(SID, [
      user('stored-u1', 'inspect the profile'),
      assistant('stored-i1', "I'm checking the profile now."),
      assistant('stored-a1', 'default')
    ])

    expect(texts(restored).filter(text => text === "I'm checking the profile now.")).toHaveLength(1)
  })

  it('anchors repeated prompts by occurrence', () => {
    rememberConversationInterims(SID, [
      user('u1', 'check again'),
      assistant('a1', 'first result'),
      user('u2', 'check again'),
      assistant('i2', 'Checking the second run.', true),
      assistant('a2', 'second result')
    ])

    const restored = restoreConversationInterims(SID, [
      user('stored-u1', 'check again'),
      assistant('stored-a1', 'first result'),
      user('stored-u2', 'check again'),
      assistant('stored-a2', 'second result')
    ])

    expect(texts(restored)).toEqual([
      'check again',
      'first result',
      'check again',
      'Checking the second run.',
      'second result'
    ])
  })

  it('ignores a stale overlay when its final-answer anchor is absent', () => {
    rememberConversationInterims(SID, [
      user('u1', 'old prompt'),
      assistant('i1', 'Checking the old state.', true),
      assistant('a1', 'old final')
    ])

    const rewritten = [user('stored-u1', 'old prompt'), assistant('stored-a1', 'rewritten final')]

    expect(restoreConversationInterims(SID, rewritten)).toBe(rewritten)
  })

  it('removes the overlay with the conversation', () => {
    rememberConversationInterims(SID, [
      user('u1', 'inspect'),
      assistant('i1', 'Inspecting.', true),
      assistant('a1', 'done')
    ])
    clearConversationInterims(SID)

    const base = [user('stored-u1', 'inspect'), assistant('stored-a1', 'done')]
    expect(restoreConversationInterims(SID, base)).toBe(base)
  })
})
