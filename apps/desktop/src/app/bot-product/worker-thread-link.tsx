import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import { $agentThreadOpener, taskWorkerThread } from './agent-thread-navigation'

/** Both result notices and run history use the Bot controller's navigation
 * intent, never a guessed assignee, filesystem path, or another computer. */
export function WorkerThreadLink({ profile, sessionId }: { profile?: unknown; sessionId?: unknown }) {
  const opener = useStore($agentThreadOpener)

  const target = taskWorkerThread({
    worker: typeof profile === 'string' ? profile : undefined,
    worker_session_id: typeof sessionId === 'string' ? sessionId : undefined
  })

  return opener && target ? (
    <WorkerThreadAction key={`${target.profile}:${target.sessionId}`} opener={opener} {...target} />
  ) : null
}

function WorkerThreadAction({ opener, profile, sessionId }: {
  opener: NonNullable<ReturnType<typeof $agentThreadOpener.get>>
  profile: string
  sessionId: string
}) {
  const { t } = useI18n()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')

  const open = async () => {
    // A disposed/replaced computer controller cannot act on this stale row.
    if (opener !== $agentThreadOpener.get()) {
      return
    }

    setOpening(true)
    setError('')

    try {
      await opener(profile, sessionId)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setOpening(false)
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        aria-busy={opening}
        aria-label={`${t.botWorkspace.openWorkerThread}: @${profile}`}
        disabled={opening}
        onClick={() => void open()}
        size="inline"
        variant="textStrong"
      >
        {t.botWorkspace.openWorkerThread}
      </Button>
      {error && (
        <div role="alert">
          <ErrorState title={error} />
        </div>
      )}
    </div>
  )
}
