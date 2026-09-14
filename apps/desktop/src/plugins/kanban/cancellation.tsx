import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  useMutation,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'

import { $boardSlug, cancelTask, taskKey } from './api'
import { useKanban } from './i18n'
import type { KanbanTask, KanbanTaskDetail } from './types'
import { errText } from './ui'

/** Explicit stop control. Cancelled intent and completed cleanup are distinct;
 * older runtimes must never silently fall back to the reclaim/retry endpoint. */
export function TaskCancellation({ task }: { task: KanbanTask }) {
  const k = useKanban().taskCancellation
  const slug = useValue($boardSlug)
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)

  const stop = useMutation({
    mutationFn: ({ id, board }: { id: string; board: string }) => cancelTask(id, board),
    onSuccess: (result, target) => {
      qc.setQueryData<KanbanTaskDetail>(
        taskKey(target.board, target.id),
        previous =>
          previous && {
            ...previous,
            task: { ...previous.task, status: result.status, cancellation_pending: !result.worker_stopped }
          }
      )
    },
    onSettled: (_result, _error, target) => {
      void qc.invalidateQueries({ queryKey: taskKey(target.board, target.id) })
      void qc.invalidateQueries({ queryKey: ['kanban', 'board', target.board] })
    }
  })

  if (!task.cancellation_supported || task.status === 'done' || task.status === 'archived') {
    return null
  }

  const cancelled = task.status === 'cancelled'
  const pending = cancelled && task.cancellation_pending !== false

  return (
    <div className="flex flex-col gap-2">
      {(stop.isPending || cancelled) && (
        <p className="text-xs text-(--ui-text-secondary)" role="status">
          {stop.isPending ? k.stopping : pending ? k.pending : k.stopped}
        </p>
      )}
      {stop.error && <ErrorState title={errText(stop.error)} />}
      {(!cancelled || pending) && (
        <Button disabled={stop.isPending} onClick={() => setConfirming(true)} size="xs" variant="outline">
          {pending ? k.retry : k.action}
        </Button>
      )}
      <Dialog onOpenChange={setConfirming} open={confirming}>
        <DialogContent onEscapeKeyDown={event => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>{k.title}</DialogTitle>
            <DialogDescription>{k.body}</DialogDescription>
          </DialogHeader>
          <p className="text-sm font-medium">{task.title || task.id}</p>
          <DialogFooter>
            <Button onClick={() => setConfirming(false)} variant="ghost">
              {k.dismiss}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false)
                stop.mutate({ id: task.id, board: slug })
              }}
              variant="destructive"
            >
              {k.action}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
