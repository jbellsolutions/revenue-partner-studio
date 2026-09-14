import { describe, expect, it } from 'vitest'

import { formatMessageTimestamp, MESSAGE_TIMESTAMP_GAP_MS, shouldShowMessageTimestamp } from './timestamp'

const labels = {
  today: (time: string) => `Today at ${time}`,
  yesterday: (time: string) => `Yesterday at ${time}`
}

describe('formatMessageTimestamp', () => {
  it('returns an empty string for missing values', () => {
    expect(formatMessageTimestamp(undefined, labels)).toBe('')
    expect(formatMessageTimestamp('not-a-date', labels)).toBe('')
  })

  it('uses the today label for timestamps earlier today', () => {
    const now = new Date()
    const earlierToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30)
    expect(formatMessageTimestamp(earlierToday, labels)).toMatch(/^Today at /)
  })

  it('uses the yesterday label for timestamps the prior day', () => {
    const now = new Date()
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 0)
    yesterday.setDate(yesterday.getDate() - 1)
    expect(formatMessageTimestamp(yesterday, labels)).toMatch(/^Yesterday at /)
  })

  it('falls back to an absolute format for older timestamps', () => {
    const old = new Date(2020, 0, 15, 9, 30)
    const out = formatMessageTimestamp(old, labels)
    expect(out).not.toMatch(/^Today at /)
    expect(out).not.toMatch(/^Yesterday at /)
    expect(out.length).toBeGreaterThan(0)
  })
})

describe('shouldShowMessageTimestamp', () => {
  it('shows the first valid message timestamp', () => {
    expect(shouldShowMessageTimestamp(Date.now())).toBe(true)
    expect(shouldShowMessageTimestamp(0)).toBe(false)
  })

  it('keeps short same-day exchanges in one visual cluster', () => {
    const previous = new Date(2026, 7, 18, 17, 30).getTime()

    expect(shouldShowMessageTimestamp(previous + MESSAGE_TIMESTAMP_GAP_MS - 1, previous)).toBe(false)
    expect(shouldShowMessageTimestamp(previous + MESSAGE_TIMESTAMP_GAP_MS, previous)).toBe(true)
  })

  it('shows a separator when the calendar day changes', () => {
    const previous = new Date(2026, 7, 18, 23, 59).getTime()
    const current = new Date(2026, 7, 19, 0, 1).getTime()

    expect(shouldShowMessageTimestamp(current, previous)).toBe(true)
  })
})
