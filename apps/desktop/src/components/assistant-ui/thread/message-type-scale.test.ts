import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// vitest rewrites import.meta.url for these modules, so resolve from the
// project root instead — the suite always runs from apps/desktop.
const read = (name: string) => readFileSync(`src/components/assistant-ui/thread/${name}`, 'utf8')

describe('message type scale', () => {
  it('sets one body size for both sides of the conversation', () => {
    // The two bubbles are authored in separate files, so the sizes drifted
    // apart by editing one and not the other. Pin them to the same value.
    const user = read('user-message.tsx')
    const assistant = read('assistant-message.tsx')

    expect(user).toContain('text-[10px]')
    expect(assistant).toContain('text-[10px]')
    expect(user).not.toContain('text-[14px]')
    expect(assistant).not.toContain('text-[14px]')
    expect(user).not.toContain('text-[15px]')
    expect(assistant).not.toContain('text-[15px]')
    expect(user).not.toContain('text-[13.5px]')
    expect(assistant).not.toContain('text-[13.5px]')
  })

  it('keeps every assistant bubble variant on the shared size', () => {
    // Plain replies, grouped multi-agent replies and the tool-run bubble each
    // carry their own class string; one left behind reads as a size glitch
    // mid-thread.
    const assistant = read('assistant-message.tsx')

    expect(assistant.match(/text-\[10px\]/g)?.length).toBe(3)
    expect(assistant.match(/px-2 py-0\.5/g)?.length).toBe(3)
    expect(assistant.match(/max-w-\[88%\]/g)?.length).toBe(3)
  })
})
