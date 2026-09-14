import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ShareHistory } from './share-history'

afterEach(cleanup)

it('does not share while previewing and sends only the operator-reviewed excerpt after confirmation', async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn()
  const shareHistory = vi.fn().mockResolvedValue({ state: 'TASK_STATE_COMPLETED', sessionId: 'copied-thread' })
  const open = vi.fn().mockResolvedValue(undefined)
  const close = vi.fn()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { orgoDesktop: {
    previewHistory: vi.fn().mockResolvedValue({ title: 'Thread', text: 'Original preview', truncated: false }),
    listInstances: vi.fn().mockResolvedValue([{ name: '', computerId: 'one', current: true, unreadable: false }]),
    historyTargets: vi.fn().mockResolvedValue({ profiles: ['source', 'receiver'] }),
    shareHistory
  } } })
  render(<ShareHistory onClose={close} onOpenThread={open} profile="source" sessionId="private-thread" />)
  const excerpt = await screen.findByLabelText('Review shared excerpt')
  expect(shareHistory).not.toHaveBeenCalled()
  fireEvent.change(excerpt, { target: { value: 'Only the approved sentence.' } })
  const target = screen.getByRole('combobox', { name: 'Receiving agent' })
  await waitFor(() => expect((target as HTMLButtonElement).disabled).toBe(false))
  fireEvent.keyDown(target, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name: 'receiver' }))
  fireEvent.click(screen.getByText('Share this excerpt'))
  await screen.findByText('History copied to the selected agent’s thread.')
  expect(shareHistory).toHaveBeenCalledTimes(1)
  expect(shareHistory).toHaveBeenCalledWith(expect.objectContaining({ sourceProfile: 'source', sourceSessionId: 'private-thread',
    targetComputerId: 'one', targetProfile: 'receiver', text: 'Only the approved sentence.' }))
  expect(open).not.toHaveBeenCalled()
  open.mockRejectedValueOnce(new Error('Receiver is unreachable'))
  fireEvent.click(screen.getByText('Open destination'))
  expect(open).toHaveBeenCalledWith('receiver', 'copied-thread')
  expect((await screen.findByRole('alert')).textContent).toContain('Receiver is unreachable')
  expect(close).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Open destination'))
  await waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(shareHistory).toHaveBeenCalledOnce()
})
