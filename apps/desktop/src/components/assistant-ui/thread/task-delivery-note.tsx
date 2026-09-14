import { WorkerThreadLink } from '@/app/bot-product/worker-thread-link'
import { useI18n } from '@/i18n'
import { LinkifiedText } from '@/lib/external-link'
import type { TaskUpdate } from '@/types/hermes'

export function TaskDeliveryNote({ updates, text }: { updates: TaskUpdate[]; text: string }) {
  const { t } = useI18n()

  return (
    <div className="flex w-full min-w-0 flex-col gap-2 text-sm" data-slot="aui-task-delivery">
      <span className="text-(--ui-text-secondary)">{t.botWorkspace.taskUpdate}</span>
      {updates.length ? (
        updates.map((update, index) => (
          <div className="min-w-0 space-y-1" key={`${update.board}:${update.task_id}:${index}`}>
            <div className="flex flex-wrap items-baseline gap-x-2 text-(--ui-text-secondary)">
              {update.worker ? (
                <span>
                  {t.botWorkspace.taskWorker} @{update.worker}
                </span>
              ) : update.assignee ? (
                <span>
                  {t.botWorkspace.taskAssignee} @{update.assignee}
                </span>
              ) : null}
              <span className="wrap-anywhere font-mono text-xs">
                {update.board} / {update.task_id}
              </span>
            </div>
            <LinkifiedText
              className="block whitespace-pre-wrap wrap-anywhere text-(--ui-text-primary)"
              explicitOnly
              pretty={false}
              text={update.text}
            />
            <WorkerThreadLink profile={update.worker} sessionId={update.worker_session_id} />
          </div>
        ))
      ) : (
        <LinkifiedText
          className="whitespace-pre-wrap wrap-anywhere text-(--ui-text-primary)"
          explicitOnly
          pretty={false}
          text={text}
        />
      )}
    </div>
  )
}
