import { afterEach, expect, it, vi } from 'vitest'

import { $agentThreadOpener, registerAgentThreadOpener, taskWorkerThread } from './agent-thread-navigation'

afterEach(() => $agentThreadOpener.set(null))

it('removes a disposed controller without letting old disposal clear its replacement', () => {
  const first = vi.fn()
  const second = vi.fn()
  const releaseFirst = registerAgentThreadOpener(first)
  const releaseSecond = registerAgentThreadOpener(second)
  releaseFirst()
  expect($agentThreadOpener.get()).toBe(second)
  releaseSecond()
  expect($agentThreadOpener.get()).toBeNull()
})

it('keeps a target on the recorded worker even if the task was reassigned', () => {
  expect(
    taskWorkerThread({
      board: 'team',
      task_id: 'task',
      text: 'result',
      worker: 'analyst',
      worker_session_id: 'saved-thread',
      assignee: 'new-worker'
    })
  ).toEqual({ profile: 'analyst', sessionId: 'saved-thread' })
})
