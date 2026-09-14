import { useEffect, useState } from 'react'
import { rpc } from './api'
import { downloadAttachment } from './attachments'
export function ConversationFiles({
  computer,
  agent,
  runtime,
  revision,
  enabled
}: {
  computer: string
  agent: string
  runtime: string
  revision: number
  enabled: boolean
}) {
  const [files, setFiles] = useState<{ id: string; name: string; size: number }[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('')
  useEffect(() => {
    let active = true
    if (runtime && enabled)
      void rpc(computer, 'files.list', { agentId: agent, runtimeId: runtime })
        .then(r => {
          if (active) setFiles(r.files)
        })
        .catch(() => {})
    return () => {
      active = false
    }
  }, [computer, agent, runtime, revision, enabled])
  if (!files.length) return null
  return (
    <details className="conversation-files">
      <summary>Files in this conversation · {files.length}</summary>
      {files.map(file => (
        <button
          key={file.id}
          disabled={!runtime || !!busy}
          onClick={() => {
            setBusy(file.id)
            setError('')
            void downloadAttachment(computer, agent, runtime, file.id)
              .catch(e => setError(e.message))
              .finally(() => setBusy(''))
          }}
        >
          {busy === file.id ? 'Downloading…' : file.name}
          <small>{Math.ceil(file.size / 1024)} KB</small>
        </button>
      ))}
      {error && <p role="status">{error}</p>}
    </details>
  )
}
