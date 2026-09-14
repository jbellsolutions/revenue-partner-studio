import { describe, expect, it, vi } from 'vitest'

import { createBotSessionNavigationQueue } from './session-navigation'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void

  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })

  return { promise, resolve, reject }
}

describe('Bot session navigation queue', () => {
  it('surfaces an explicit open failure and still allows the next selection', async () => {
    const enqueue = createBotSessionNavigationQueue()
    const failed = vi.fn().mockRejectedValue(new Error('Receiver is unreachable'))
    const next = vi.fn().mockResolvedValue(undefined)

    await expect(enqueue(failed, () => true)).rejects.toThrow('Receiver is unreachable')
    await expect(enqueue(next, () => true)).resolves.toBe(true)
    expect(next).toHaveBeenCalledOnce()
  })

  it('serializes a cold profile open and skips superseded queued selections', async () => {
    const enqueue = createBotSessionNavigationQueue()
    const cold = deferred()
    const calls: string[] = []
    let selected = 'cold'

    const first = enqueue(
      async () => {
        calls.push('cold')
        await cold.promise
      },
      () => selected === 'cold'
    )

    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(['cold'])

    selected = 'middle'

    const middle = enqueue(
      async () => {
        calls.push('middle')
      },
      () => selected === 'middle'
    )

    selected = 'latest'

    const latest = enqueue(
      async () => {
        calls.push('latest')
      },
      () => selected === 'latest'
    )

    expect(calls).toEqual(['cold'])
    cold.resolve()

    await expect(first).resolves.toBe(false)
    await expect(middle).resolves.toBe(false)
    await expect(latest).resolves.toBe(true)
    expect(calls).toEqual(['cold', 'latest'])
  })

  it('does not paint a delayed failure after the user has selected another agent', async () => {
    const enqueue = createBotSessionNavigationQueue()
    const cold = deferred()
    let current = true

    const first = enqueue(
      () => cold.promise,
      () => current
    )

    await Promise.resolve()
    await Promise.resolve()
    current = false
    cold.reject(new Error('Old profile failed'))

    await expect(first).resolves.toBe(false)
    await expect(
      enqueue(
        async () => undefined,
        () => true
      )
    ).resolves.toBe(true)
  })
})
