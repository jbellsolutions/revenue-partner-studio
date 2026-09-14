import { describe, expect, it } from 'vitest'

import {
  BOT_GROUP_CONTEXT_END,
  BOT_GROUP_CONTEXT_START,
  BOT_GROUP_REPLY_END,
  botGroupReplyStart,
  parseBotGroupReplies,
  stripBotGroupContext
} from './bot-group-chat'

describe('stripBotGroupContext', () => {
  it('keeps only the human-authored prompt', () => {
    const text = `ask everyone for a name\n\n${BOT_GROUP_CONTEXT_START}\nprivate routing\n${BOT_GROUP_CONTEXT_END}`

    expect(stripBotGroupContext(text)).toBe('ask everyone for a name')
  })

  it('fails private when an envelope is incomplete', () => {
    expect(stripBotGroupContext(`hello\n\n${BOT_GROUP_CONTEXT_START}\npartial`)).toBe('hello')
  })

  it('does not alter ordinary messages', () => {
    expect(stripBotGroupContext('ordinary message')).toBe('ordinary message')
  })
})

describe('parseBotGroupReplies', () => {
  it('returns one attributed reply per complete block', () => {
    const text = [
      botGroupReplyStart('default', 'Hermes'),
      'I would start with the inbox.',
      BOT_GROUP_REPLY_END,
      botGroupReplyStart('sandbox', 'Sandbox'),
      'I would prototype in isolation.',
      BOT_GROUP_REPLY_END
    ].join('\n')

    expect(parseBotGroupReplies(text)).toEqual([
      { name: 'Hermes', profile: 'default', text: 'I would start with the inbox.' },
      { name: 'Sandbox', profile: 'sandbox', text: 'I would prototype in isolation.' }
    ])
  })

  it('keeps a trailing unfinished block so an interrupted turn still renders', () => {
    expect(parseBotGroupReplies(`${botGroupReplyStart('default', 'Hermes')}\nstill streaming`)).toEqual([
      { name: 'Hermes', profile: 'default', text: 'still streaming' }
    ])
  })

  it('keeps completed replies plus the interrupted tail', () => {
    const text = [
      botGroupReplyStart('dewey', 'Dewey'),
      'inbox is quiet',
      BOT_GROUP_REPLY_END,
      botGroupReplyStart('newbot', 'New Bot'),
      'still writing'
    ].join('\n')

    expect(parseBotGroupReplies(text)).toEqual([
      { name: 'Dewey', profile: 'dewey', text: 'inbox is quiet' },
      { name: 'New Bot', profile: 'newbot', text: 'still writing' }
    ])
  })
})
