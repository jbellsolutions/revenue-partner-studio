import { useCallback, useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  createCronJob,
  deleteCronJob,
  getCronJobRuns,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from '@/hermes'
import { Clock, Pause, Play, Plus, Trash2 } from '@/lib/icons'
import { fmtDayTime, relativeTime } from '@/lib/time'
import { notify, notifyError } from '@/store/notifications'
import type { CronJob, SessionInfo } from '@/types/hermes'

import { jobState, jobTitle } from '../../cron/job-state'

const SCHEDULES = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 9:00 AM', value: '0 9 * * *' },
  { label: 'Weekdays at 9:00 AM', value: '0 9 * * 1-5' },
  { label: 'Every Monday at 9:00 AM', value: '0 9 * * 1' },
  { label: 'Every month at 9:00 AM', value: '0 9 1 * *' }
] as const

const CUSTOM_SCHEDULE = '__custom__'

function scheduleExpression(job: CronJob): string {
  return job.schedule?.expr || job.schedule_display || ''
}

function scheduleLabel(job: CronJob): string {
  return job.schedule_display || job.schedule?.display || job.schedule?.expr || 'No schedule'
}

function formatProfileName(profile: string): string {
  if (profile === 'default') {
    return 'this agent'
  }

  return profile.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase())
}

interface AgentRoutinesProps {
  activeProfile: string
  onEdit: (job: CronJob | null) => void
}

export function AgentRoutines({ activeProfile, onEdit }: AgentRoutinesProps) {
  const [jobs, setJobs] = useState<CronJob[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')

    try {
      setJobs(await getCronJobs(activeProfile))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not load routines.')
    } finally {
      setLoading(false)
    }
  }, [activeProfile])

  useEffect(() => {
    void load()
  }, [load])

  const orderedJobs = useMemo(
    () =>
      [...jobs].sort((left, right) => {
        const leftNext = left.next_run_at ? Date.parse(left.next_run_at) : Number.POSITIVE_INFINITY
        const rightNext = right.next_run_at ? Date.parse(right.next_run_at) : Number.POSITIVE_INFINITY

        return leftNext - rightNext || jobTitle(left).localeCompare(jobTitle(right))
      }),
    [jobs]
  )

  if (loading) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center">
        <Loader className="size-5" label="Loading routines" type="lemniscate-bloom" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
        <p className="text-[0.7rem] leading-4 text-(--ui-text-tertiary)">{error}</p>
        <Button onClick={() => void load()} size="xs" variant="secondary">
          Try again
        </Button>
      </div>
    )
  }

  if (!orderedJobs.length) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-start gap-3 border-t border-(--ui-stroke-secondary) mx-4 pt-5 pb-8">
        <h3 className="text-xs font-medium">Routines</h3>
        <p className="max-w-64 text-xs leading-5 text-(--ui-text-tertiary)">
          Routines are recurring tasks {formatProfileName(activeProfile)} runs on a schedule.
        </p>
        <Button onClick={() => onEdit(null)} size="xs" variant="secondary">
          Create Routine
        </Button>
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col px-2.5 pb-2">
      <header className="flex h-8 shrink-0 items-center justify-between px-1">
        <span className="text-[0.68rem] font-medium text-(--ui-text-secondary)">Routines</span>
        <Button aria-label="Create Routine" onClick={() => onEdit(null)} size="icon-xs" variant="ghost">
          <Plus className="size-4" />
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        {orderedJobs.map(job => {
          const nextRun = job.next_run_at ? Date.parse(job.next_run_at) : Number.NaN
          const state = jobState(job)
          const active = job.enabled !== false && state !== 'disabled' && state !== 'paused'

          return (
            <button
              className="group flex w-full items-center gap-2 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-(--chrome-action-hover)"
              key={job.id}
              onClick={() => onEdit(job)}
              type="button"
            >
              <span
                aria-label={active ? 'Active and scheduled' : 'Paused'}
                className={active ? 'shrink-0 text-emerald-400' : 'shrink-0 text-(--ui-text-quaternary)'}
              >
                {active ? <Clock aria-hidden className="size-3.5" /> : <Pause aria-hidden className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.72rem] font-medium text-(--ui-text-primary)">{jobTitle(job)}</span>
                <span className="mt-0.5 block truncate text-[0.64rem] text-(--ui-text-quaternary)">
                  {Number.isNaN(nextRun) ? scheduleLabel(job) : relativeTime(nextRun)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

interface RoutineEditorProps {
  job: CronJob | null
  onClose: (changed?: boolean) => void
}

export function RoutineEditor({ job, onClose }: RoutineEditorProps) {
  const initialSchedule = job ? scheduleExpression(job) : SCHEDULES[1].value

  const initialPreset = SCHEDULES.some(option => option.value === initialSchedule)
    ? initialSchedule
    : CUSTOM_SCHEDULE

  const [name, setName] = useState(job?.name || '')
  const [prompt, setPrompt] = useState(job?.prompt || '')
  const [schedulePreset, setSchedulePreset] = useState(initialPreset)
  const [customSchedule, setCustomSchedule] = useState(initialPreset === CUSTOM_SCHEDULE ? initialSchedule : '')
  const [enabled, setEnabled] = useState(job?.enabled ?? true)
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [runs, setRuns] = useState<SessionInfo[] | null>(job ? null : [])
  const schedule = schedulePreset === CUSTOM_SCHEDULE ? customSchedule.trim() : schedulePreset

  useEffect(() => {
    if (!job) {
      return
    }

    let cancelled = false

    void getCronJobRuns(job.id, 5)
      .then(result => {
        if (!cancelled) {
          setRuns(result)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRuns([])
        }
      })

    return () => {
      cancelled = true
    }
  }, [job])

  const save = async () => {
    if (!prompt.trim() || !schedule) {
      return
    }

    setSaving(true)

    try {
      if (job) {
        await updateCronJob(job.id, { enabled, name: name.trim(), prompt: prompt.trim(), schedule })
      } else {
        const created = await createCronJob({ name: name.trim(), prompt: prompt.trim(), schedule })

        if (!enabled) {
          await pauseCronJob(created.id)
        }
      }

      notify({ kind: 'success', message: job ? 'Routine saved' : 'Routine created' })
      onClose(true)
    } catch (saveError) {
      notifyError(saveError, job ? 'Could not save routine' : 'Could not create routine')
    } finally {
      setSaving(false)
    }
  }

  const toggleEnabled = async (next: boolean) => {
    setEnabled(next)

    if (!job) {
      return
    }

    try {
      await (next ? resumeCronJob(job.id) : pauseCronJob(job.id))
      notify({ kind: 'success', message: next ? 'Routine active' : 'Routine paused' })
    } catch (toggleError) {
      setEnabled(!next)
      notifyError(toggleError, 'Could not update routine')
    }
  }

  const runNow = async () => {
    if (!job || running) {
      return
    }

    setRunning(true)

    try {
      await triggerCronJob(job.id)
      notify({ kind: 'success', message: 'Routine started' })
    } catch (runError) {
      notifyError(runError, 'Could not start routine')
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3">
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--ui-stroke-tertiary)">
          <label className="flex items-center gap-2 text-[0.7rem] text-(--ui-text-secondary)">
            Active
            <Switch aria-label="Active" checked={enabled} onCheckedChange={next => void toggleEnabled(next)} size="xs" />
          </label>
          {job ? (
            <div className="flex items-center gap-0.5">
              <Button
                aria-label="Delete routine"
                onClick={() => setDeleteOpen(true)}
                size="icon-xs"
                variant="ghost"
              >
                <Trash2 />
              </Button>
              <Button aria-label="Test run" disabled={running} onClick={() => void runNow()} size="xs" variant="ghost">
                <Play />
                {running ? 'Starting…' : 'Test run'}
              </Button>
            </div>
          ) : null}
        </div>

        <form
          className="grid gap-4 py-4"
          onSubmit={event => {
            event.preventDefault()
            void save()
          }}
        >
          <label className="grid gap-1.5 text-[0.68rem] text-(--ui-text-secondary)">
            Name
            <Input autoFocus onChange={event => setName(event.target.value)} placeholder="Morning briefing" value={name} />
          </label>
          <label className="grid gap-1.5 text-[0.68rem] text-(--ui-text-secondary)">
            Instruction
            <Textarea
              className="min-h-28 resize-y"
              onChange={event => setPrompt(event.target.value)}
              placeholder="What should this agent do?"
              value={prompt}
            />
          </label>
          <label className="grid gap-1.5 text-[0.68rem] text-(--ui-text-secondary)">
            When to run
            <Select onValueChange={setSchedulePreset} value={schedulePreset}>
              <SelectTrigger aria-label="When to run">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SCHEDULES.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
                <SelectItem value={CUSTOM_SCHEDULE}>Advanced…</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {schedulePreset === CUSTOM_SCHEDULE ? (
            <label className="grid gap-1.5 text-[0.68rem] text-(--ui-text-secondary)">
              Cron expression
              <Input
                aria-label="Cron expression"
                onChange={event => setCustomSchedule(event.target.value)}
                placeholder="0 9 * * 1-5"
                value={customSchedule}
              />
            </label>
          ) : null}

          <Button disabled={saving || !prompt.trim() || !schedule} size="sm" type="submit">
            {saving ? 'Saving…' : job ? 'Save changes' : 'Create Routine'}
          </Button>
        </form>

        {job ? (
          <section className="mt-1 border-t border-(--ui-stroke-tertiary) pt-3">
            <div className="mb-2 flex items-center gap-1.5 text-[0.68rem] font-medium text-(--ui-text-secondary)">
              <Clock className="size-3" />
              Run history
            </div>
            {runs === null ? (
              <Loader className="size-4" label="Loading run history" type="lemniscate-bloom" />
            ) : runs.length ? (
              <div className="space-y-1">
                {runs.map(run => (
                  <div className="rounded-md px-2 py-1.5 text-[0.65rem] text-(--ui-text-tertiary)" key={run.id}>
                    {fmtDayTime.format(new Date(run.started_at * 1000))}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[0.65rem] text-(--ui-text-quaternary)">No runs yet.</p>
            )}
          </section>
        ) : null}
      </div>

      {job ? (
        <ConfirmDialog
          confirmLabel="Delete"
          description="This removes the routine and its schedule."
          destructive
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await deleteCronJob(job.id)
            notify({ kind: 'success', message: 'Routine deleted' })
            onClose(true)
          }}
          open={deleteOpen}
          title="Delete this routine?"
        />
      ) : null}
    </>
  )
}
