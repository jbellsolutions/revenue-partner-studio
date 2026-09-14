import type { PluginStorage } from '@hermes/plugin-sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { $boardSlug, bindApi, cancelTask } from './api'

afterEach(() => vi.useRealTimers())

it('pins cancellation to the captured board without nudging or reclaiming', async () => {
  vi.useFakeTimers()
  const rest = vi.fn(async () => ({ ok: true, status: 'cancelled', worker_stopped: true }))
  const storage: PluginStorage = { get: <T,>(_key: string, fallback: T) => fallback, set: vi.fn(), remove: vi.fn() }
  const dispose = bindApi(rest as Parameters<typeof bindApi>[0], storage, () => () => {})

  try {
    $boardSlug.set('different-board')
    await cancelTask('task / 1', 'original-board')
    await vi.advanceTimersByTimeAsync(1000)
    expect(rest).toHaveBeenCalledExactlyOnceWith('/tasks/task%20%2F%201/cancel?board=original-board', {
      method: 'POST',
      body: {}
    })
  } finally {
    dispose()
    $boardSlug.set('')
  }
})
