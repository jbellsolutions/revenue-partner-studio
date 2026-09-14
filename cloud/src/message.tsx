import { memo } from 'react'
import { Streamdown } from 'streamdown'
import { AgentAvatar } from '../../brand/agent-avatar'
import type { Message } from './state'
// Completed messages keep their parsed Markdown while the next response streams.
export const ChatMessage = memo(function ChatMessage({
  message: m,
  name,
  identity,
  head,
  more
}: {
  message: Message
  name: string
  identity: string
  head?: boolean
  more: (id: string | number, offset: number) => void
}) {
  return (
    <article className={'message ' + m.role}>
      <div className="message-author">
        {m.role === 'assistant' && <AgentAvatar name={name} identity={identity} head={head} small />}
        {m.role === 'user' ? 'You' : m.role === 'tool' ? 'Tool result' : name}
      </div>
      {m.role === 'tool' ? (
        <details>
          <summary>View tool result</summary>
          <pre>{m.content}</pre>
        </details>
      ) : (
        <Streamdown>{typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}</Streamdown>
      )}
      {m.truncated && (
        <button onClick={() => more(m.id, Array.from(m.content).length)}>Show more of this message</button>
      )}
    </article>
  )
})
