import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CronJob } from '@/types/hermes'

const api = vi.hoisted(() => ({
  createCronJob: vi.fn(),
  deleteCronJob: vi.fn(),
  getCronJobRuns: vi.fn(),
  getCronJobs: vi.fn(),
  pauseCronJob: vi.fn(),
  resumeCronJob: vi.fn(),
  triggerCronJob: vi.fn(),
  updateCronJob: vi.fn()
}))

vi.mock('@/hermes', () => api)

import { AgentRoutines, RoutineEditor } from './routines'

const JOB: CronJob = {
  enabled: false,
  id: 'routine-1',
  name: 'Morning briefing',
  prompt: 'Summarize the inbox.',
  schedule: { display: 'Every day at 9:00 AM', expr: '0 9 * * *' },
  state: 'paused'
}

describe('agent details routines', () => {
  beforeEach(() => {
    Object.values(api).forEach(mock => mock.mockReset())
    api.getCronJobs.mockResolvedValue([])
    api.getCronJobRuns.mockResolvedValue([])
    api.createCronJob.mockResolvedValue({ ...JOB, enabled: true, state: 'scheduled' })
    api.pauseCronJob.mockResolvedValue(JOB)
    api.resumeCronJob.mockResolvedValue({ ...JOB, enabled: true, state: 'scheduled' })
    api.triggerCronJob.mockResolvedValue(JOB)
    api.updateCronJob.mockResolvedValue(JOB)
    api.deleteCronJob.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('loads only the active agent routines and opens the inline creator', async () => {
    const onEdit = vi.fn()

    render(<AgentRoutines activeProfile="inbox-triage" onEdit={onEdit} />)

    expect(await screen.findByText(/recurring tasks Inbox Triage runs/)).toBeTruthy()
    expect(api.getCronJobs).toHaveBeenCalledWith('inbox-triage')
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))
    expect(onEdit).toHaveBeenCalledWith(null)
  })

  it('uses green clocks for active routines and grey pause icons for inactive ones', async () => {
    api.getCronJobs.mockResolvedValue([
      { ...JOB, enabled: true, id: 'active', name: 'Active routine', state: 'scheduled' },
      { ...JOB, id: 'paused', name: 'Paused routine' }
    ])

    render(<AgentRoutines activeProfile="default" onEdit={vi.fn()} />)

    const activeIcon = await screen.findByLabelText('Active and scheduled')

    expect(activeIcon.className).toContain('text-emerald-400')
    expect(activeIcon.querySelector('svg')?.getAttribute('class')).toContain('size-3.5')
    expect(screen.getByText('Active routine').closest('button')?.className).toContain('items-center')
    expect(screen.getByText('Active routine').closest('button')?.className).toContain('rounded-2xl')
    expect(screen.getByLabelText('Paused').className).toContain('text-(--ui-text-quaternary)')
    expect(screen.getByRole('button', { name: 'Create Routine' }).querySelector('svg')?.getAttribute('class')).toContain(
      'size-4'
    )
  })

  it('creates a real scheduled job from the compact editor', async () => {
    const onClose = vi.fn()

    render(<RoutineEditor job={null} onClose={onClose} />)

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Daily rescue queue' } })
    fireEvent.change(screen.getByLabelText('Instruction'), { target: { value: 'Rank the accounts needing attention.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create Routine' }))

    await waitFor(() =>
      expect(api.createCronJob).toHaveBeenCalledWith({
        name: 'Daily rescue queue',
        prompt: 'Rank the accounts needing attention.',
        schedule: '0 9 * * *'
      })
    )
    expect(onClose).toHaveBeenCalledWith(true)
  })

  it('keeps activation and test runs as real job actions', async () => {
    render(<RoutineEditor job={JOB} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('switch', { name: 'Active' }))
    await waitFor(() => expect(api.resumeCronJob).toHaveBeenCalledWith('routine-1'))

    fireEvent.click(screen.getByRole('button', { name: 'Test run' }))
    await waitFor(() => expect(api.triggerCronJob).toHaveBeenCalledWith('routine-1'))
  })
})
