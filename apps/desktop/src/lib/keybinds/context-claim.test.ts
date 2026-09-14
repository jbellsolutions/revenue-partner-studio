import { afterEach, describe, expect, it, vi } from 'vitest'

import { KEYBIND_BEFORE_RUN_EVENT, keybindActionAllowed } from './context-claim'

describe('contextual keybind claims', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('allows an action when no contextual surface claims it', () => {
    expect(keybindActionAllowed('profile.switch.1', 'mod+1')).toBe(true)
  })

  it('delivers action metadata and blocks before the handler when claimed', () => {
    const seen: unknown[] = []

    const claim = (event: Event) => {
      seen.push((event as CustomEvent).detail)
      event.preventDefault()
    }

    window.addEventListener(KEYBIND_BEFORE_RUN_EVENT, claim)

    try {
      expect(keybindActionAllowed('profile.switch.3', 'mod+3')).toBe(false)
      expect(seen).toEqual([{ actionId: 'profile.switch.3', combo: 'mod+3' }])
    } finally {
      window.removeEventListener(KEYBIND_BEFORE_RUN_EVENT, claim)
    }
  })
})
