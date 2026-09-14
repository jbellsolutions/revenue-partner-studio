import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { $pluginRecords, setPluginEnabled } from '@/contrib/plugins-store'
import { useI18n } from '@/i18n/context'

/** A direct entry into Hermes's existing durable task board. Enabling the
 * desktop surface does not create tasks or change the remote dispatcher. */
export function TeamTasksButton({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const open = async () => {
    setBusy(true)
    setError('')

    try {
      if ($pluginRecords.get().kanban?.status !== 'loaded') {
        await setPluginEnabled('kanban', true)
      }

      // The loader records activation failures rather than throwing them.
      // Do not route to an unregistered /kanban path (it looks like a chat id).
      if ($pluginRecords.get().kanban?.status !== 'loaded') {
        throw new Error(t.botWorkspace.tasksUnavailable)
      }

      onNavigate('/kanban')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Button disabled={busy} onClick={() => void open()} size="sm" variant="ghost">
        {t.botWorkspace.teamTasks}
      </Button>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
