import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetElapsedTimerRegistryForTests } from '@/components/chat/activity-timer'
import { I18nProvider } from '@/i18n'
import { $activeSessionId, $turnStartedAt } from '@/store/session'

import { compactRunActivityLabel, ResponseLoadingIndicator } from './status'

function renderIndicator() {
  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <ResponseLoadingIndicator />
    </I18nProvider>
  )
}

describe('ResponseLoadingIndicator timer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    __resetElapsedTimerRegistryForTests()
  })

  afterEach(() => {
    cleanup()
    $activeSessionId.set(null)
    $turnStartedAt.set(null)
    __resetElapsedTimerRegistryForTests()
    vi.useRealTimers()
  })

  it('preserves each running session timer while switching between sessions', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const sessionA = renderIndicator()

    act(() => vi.advanceTimersByTime(5_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '5s').length).toBeGreaterThan(0)
    sessionA.unmount()

    $activeSessionId.set('session-b')
    $turnStartedAt.set(Date.now())
    const sessionB = renderIndicator()

    act(() => vi.advanceTimersByTime(3_000))
    expect(screen.getAllByText((_, node) => node?.textContent === '3s').length).toBeGreaterThan(0)
    sessionB.unmount()

    $activeSessionId.set('session-a')
    $turnStartedAt.set(new Date('2026-01-01T00:00:00.000Z').getTime())
    renderIndicator()

    expect(screen.getAllByText((_, node) => node?.textContent === '8s').length).toBeGreaterThan(0)
  })
})

// The status line sits between tool rows and thinking headers, which the
// transcript rests at a fade. Without the mark it reads a shade brighter than
// both — the one line in the column claiming emphasis it hasn't earned.
describe('status line', () => {
  afterEach(cleanup)

  it('is marked as transcript scaffolding', () => {
    $activeSessionId.set('session-a')
    $turnStartedAt.set(Date.now())
    const { container } = renderIndicator()

    expect(container.querySelector('[role="status"]')?.hasAttribute('data-conversation-scaffold')).toBe(true)
  })
})

describe('compactRunActivityLabel', () => {
  it('prefers compaction and drafted tools over streamed message noise', () => {
    expect(compactRunActivityLabel([{ text: 'partial', type: 'text' }], true, 'terminal')).toBe('Summarizing thread')
    expect(compactRunActivityLabel([{ text: 'partial', type: 'text' }], false, 'terminal')).toBe('Running')
  })

  it('shows the current tool target and replaces it with the completed action', () => {
    const pending = {
      args: { query: 'Orgo API' },
      toolCallId: 'tool-1',
      toolName: 'web_search',
      type: 'tool-call'
    }

    expect(compactRunActivityLabel([pending], false)).toBe('Exploring Orgo API')
    expect(compactRunActivityLabel([{ ...pending, result: { ok: true } }], false)).toBe('Explored Orgo API')
  })

  it('samples only the latest line of exposed reasoning', () => {
    expect(
      compactRunActivityLabel(
        [{ text: 'First I should inspect the app.\n- Checking the message renderer now.', type: 'reasoning' }],
        false
      )
    ).toBe('Thinking · Checking the message renderer now.')
  })

  it('waits for a stable thought boundary instead of repainting every token', () => {
    expect(compactRunActivityLabel([{ text: 'Checking the message rend', type: 'reasoning' }], false)).toBe('Thinking')
    expect(compactRunActivityLabel([{ text: 'Checking the message renderer.', type: 'reasoning' }], false)).toBe(
      'Thinking · Checking the message renderer.'
    )
  })

  it('uses the newest meaningful event instead of accumulating a run log', () => {
    const tool = {
      args: { path: '/workspace/settings.json' },
      result: { content: '{}' },
      toolCallId: 'tool-1',
      toolName: 'read_file',
      type: 'tool-call'
    }

    expect(
      compactRunActivityLabel(
        [tool, { text: 'The setting exists, so I can compose the answer.', type: 'reasoning' }],
        false
      )
    ).toBe('Thinking · The setting exists, so I can compose the answer.')
    expect(compactRunActivityLabel([tool, { text: 'Here is the answer', type: 'text' }], false)).toBe('Writing reply')
    expect(compactRunActivityLabel([{ text: 'On it.', type: 'text' }], false, '', true)).toBe('')
  })

  it('keeps long activity and likely credentials out of the bubble', () => {
    const command = `API_KEY=sk-${'a'.repeat(40)} npm run an-extremely-long-validation-command -- --with-many-flags ${'x'.repeat(80)}`

    const label = compactRunActivityLabel(
      [{ args: { command }, toolCallId: 'tool-1', toolName: 'terminal', type: 'tool-call' }],
      false
    )

    expect(label).toContain('API_KEY=[hidden]')
    expect(label).not.toContain(`sk-${'a'.repeat(40)}`)
    expect(label.length).toBeLessThanOrEqual(92)
  })
})
