import { useEffect, useRef, useState } from 'react'
import { rpc } from './api'
type Preview = { text: string; truncated: boolean; kind?: string; role?: string }
type Review = {
  delivery: { id: string; recipient: string; body: string }
  inspectionToken: string
  actions: Preview[]
  history: Preview[]
  earlierActions: number
}
export function TaskActions({
  computer,
  task,
  changed
}: {
  computer: string
  task: { id: string; state: string }
  changed: () => void
}) {
  const [review, setReview] = useState<Review | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const active = useRef(true),
    request = useRef(crypto.randomUUID())
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  async function act(method: string) {
    setBusy(true)
    setError('')
    try {
      const result = await rpc(
        computer,
        method,
        { taskId: task.id, ...(review ? { inspectionToken: review.inspectionToken } : {}) },
        method === 'tasks.resume' ? request.current : crypto.randomUUID()
      )
      if (!active.current) return
      if (method === 'tasks.reconcile') {
        setReview(result)
        request.current = crypto.randomUUID()
      } else {
        setReview(null)
        changed()
      }
    } catch (e) {
      if (active.current) setError((e as Error).message)
    } finally {
      if (active.current) setBusy(false)
    }
  }
  return (
    <>
      <div className="task-actions">
        {task.state === 'needs_review' && (
          <button disabled={busy} onClick={() => void act('tasks.reconcile')}>
            Inspect interrupted task
          </button>
        )}
        {['queued', 'starting', 'running', 'needs_review'].includes(task.state) && (
          <button disabled={busy} onClick={() => void act('tasks.cancel')}>
            Cancel task
          </button>
        )}
      </div>
      {error && !review && <p role="alert">{error}</p>}
      {review && (
        <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && !busy && setReview(null)}>
          <section
            className="modal recovery-review"
            role="dialog"
            aria-modal="true"
            aria-label="Review interrupted task"
          >
            <button
              className="modal-close"
              disabled={busy}
              onClick={() => setReview(null)}
              aria-label="Close recovery review"
            >
              ×
            </button>
            <h2>Review interrupted task</h2>
            <p>
              {review.delivery.recipient.replaceAll('-', ' ')} stopped before its result was confirmed. Review the
              recent actions before continuing.
            </p>
            <h3>Original request</h3>
            <pre>{review.delivery.body}</pre>
            <h3>Recent actions</h3>
            {review.earlierActions > 0 && (
              <p>{review.earlierActions} earlier records remain in the original conversation.</p>
            )}
            {review.actions.length ? (
              review.actions.map((item, i) => (
                <details key={i}>
                  <summary>{item.kind?.replaceAll('.', ' ')}</summary>
                  <pre>{item.text}</pre>
                  {item.truncated && <small>Preview shortened; full details remain on this computer.</small>}
                </details>
              ))
            ) : (
              <p>No completed action record was saved. The agent must check what happened before doing more work.</p>
            )}
            {review.history.map((item, i) => (
              <details key={'history' + i}>
                <summary>Conversation · {item.role}</summary>
                <pre>{item.text}</pre>
                {item.truncated && <small>Preview shortened; open the conversation for the full record.</small>}
              </details>
            ))}
            <p>
              On resume, the agent will verify completed actions in this same conversation and finish only missing work.
              Unverifiable actions stay held for review.
            </p>
            {error && <p role="alert">{error}</p>}
            <button className="primary" disabled={busy} onClick={() => void act('tasks.resume')}>
              {busy ? 'Checking…' : 'Resume remaining work'}
            </button>
            <button disabled={busy} onClick={() => void act('tasks.reconcile')}>
              Refresh evidence
            </button>
          </section>
        </div>
      )}
    </>
  )
}
