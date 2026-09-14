// Assistant actions return to the user checkpoint that produced a response.
// The destructive history restore remains behind the shared confirmation
// dialog and disappears when restoration is unavailable.
import { AssistantRuntimeProvider, type ThreadMessage, useExternalStoreRuntime } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BOT_GROUP_REPLY_END, botGroupReplyStart } from '@/lib/bot-group-chat'
import { setToolViewMode } from '@/store/tool-view'

import { Thread } from '.'

const createdAt = new Date('2026-05-01T00:00:00.000Z')

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', TestResizeObserver)
vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0)
)
vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
vi.stubGlobal('CSS', { escape: (str: string) => str })

Element.prototype.scrollTo = function scrollTo() {}

Element.prototype.animate = function animate() {
  return { cancel() {}, finished: Promise.resolve() } as unknown as Animation
}

afterEach(() => {
  cleanup()
  setToolViewMode('product')
})

function userMessage(): ThreadMessage {
  return {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text: 'question one' }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  } as ThreadMessage
}

function assistantMessage(): ThreadMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    status: { type: 'complete', reason: 'stop' },
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  } as ThreadMessage
}

function Harness({
  isRunning = false,
  messages = [userMessage(), assistantMessage()],
  onRestoreToMessage
}: {
  isRunning?: boolean
  messages?: ThreadMessage[]
  onRestoreToMessage?: (messageId: string, target?: { text?: string; userOrdinal?: number | null }) => Promise<void> | void
}) {
  const runtime = useExternalStoreRuntime<ThreadMessage>({
    messages,
    isRunning,
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread onRestoreToMessage={onRestoreToMessage} />
    </AssistantRuntimeProvider>
  )
}

describe('AssistantMessage checkpoint action', () => {
  it('renders compact directional chat bubbles', async () => {
    const { container } = render(<Harness />)

    const userRoot = container.querySelector('[data-slot="aui_user-message-root"]')
    const userBubble = await screen.findByRole('button', { name: 'Edit message' })
    const assistantRoot = (await screen.findByText('done')).closest('[data-slot="aui_assistant-message-root"]')
    const assistantBubble = container.querySelector('[data-slot="aui_assistant-message-content"]')

    expect(userRoot?.className).toContain('items-end')
    expect(userRoot?.className).not.toContain('sticky')
    expect(userRoot?.className).not.toContain('bg-(--ui-chat-surface-background)')
    expect(userRoot?.className).not.toContain('w-[calc(100%+2rem)]')
    expect(userBubble.getAttribute('data-slot')).toBe('aui_user-message-bubble')
    expect(userBubble.className).toContain('max-w-[70%]')
    expect(userBubble.querySelector('[data-clamped]')).toBeNull()
    expect(userBubble.querySelector('.sticky-human-clamp')).toBeNull()
    expect(assistantRoot?.className).toContain('self-start')
    expect(assistantRoot?.className).toContain('max-w-[88%]')
    expect(assistantBubble?.className).toContain('rounded-xl')
  })

  it('shows the Return to checkpoint action when restoration is available', async () => {
    const restore = vi.fn()

    render(<Harness onRestoreToMessage={restore} />)

    fireEvent.pointerDown(await screen.findByRole('button', { name: 'More actions' }), {
      button: 0,
      ctrlKey: false
    })

    fireEvent.click(await screen.findByRole('menuitem', { name: 'Return to checkpoint' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore & rerun' }))

    expect(restore).toHaveBeenCalledWith('user-1', { text: 'question one', userOrdinal: 0 })
  })

  it('hides the Return to checkpoint action when restoration is unavailable', async () => {
    render(<Harness />)

    // Wait for the assistant message to actually mount before asserting
    // absence, so a missing button isn't just a false negative from an
    // unrendered message.
    await screen.findByText('done')
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }), {
      button: 0,
      ctrlKey: false
    })

    expect(screen.queryByRole('menuitem', { name: 'Return to checkpoint' })).toBeNull()
  })

  it('renders one compact side action control for every assistant message', async () => {
    const first = {
      ...assistantMessage(),
      id: 'assistant-first',
      content: [{ type: 'text', text: 'First agent update' }]
    } as ThreadMessage

    const final = {
      ...assistantMessage(),
      id: 'assistant-final',
      content: [{ type: 'text', text: 'Final agent answer' }]
    } as ThreadMessage

    const secondUser = {
      ...userMessage(),
      id: 'user-2',
      content: [{ type: 'text', text: 'Follow-up question' }]
    } as ThreadMessage

    const { container } = render(
      <Harness messages={[userMessage(), first, secondUser, final]} onRestoreToMessage={() => undefined} />
    )

    const firstRoot = (await screen.findByText('First agent update')).closest('[data-slot="aui_assistant-message-root"]')
    const finalRoot = (await screen.findByText('Final agent answer')).closest('[data-slot="aui_assistant-message-root"]')

    expect(firstRoot?.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    expect(finalRoot?.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-slot="aui_msg-actions"]')).toHaveLength(2)
    expect(firstRoot?.querySelector('[data-slot="aui_msg-actions"]')?.parentElement?.className).toContain('opacity-0')
    expect(finalRoot?.querySelector('[data-slot="aui_msg-actions"]')?.parentElement?.className).not.toContain('opacity-0')
    expect(finalRoot?.querySelector('[data-slot="aui_msg-actions"]')?.parentElement?.className).toContain('justify-end')
    expect(firstRoot?.querySelector('[data-slot="aui_msg-actions"]')?.parentElement?.parentElement?.className).toContain(
      'left-full'
    )
    expect(finalRoot?.querySelector('[data-slot="aui_msg-actions"]')?.parentElement?.parentElement?.className).toContain(
      'left-full'
    )
  })

  it('buffers streaming prose behind one compact activity indicator', async () => {
    const running: ThreadMessage = {
      ...assistantMessage(),
      content: [{ type: 'text', text: 'partial draft that should not flash' }],
      status: { type: 'running' }
    }

    const { container } = render(<Harness isRunning messages={[userMessage(), running]} />)

    expect(screen.queryByText('partial draft that should not flash')).toBeNull()
    expect(await screen.findByRole('status', { name: 'Hermes is loading a response' })).toBeTruthy()
    expect(container.querySelectorAll('[data-slot="aui_compact-run-activity"]')).toHaveLength(1)
  })

  it('keeps a sealed interim as conversational text with one separate live activity bubble', async () => {
    const interim = {
      ...assistantMessage(),
      id: 'assistant-interim',
      content: [{ type: 'text', text: 'Let me inspect that.' }],
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: { interim: true }
      }
    } as ThreadMessage

    const live = render(<Harness isRunning messages={[userMessage(), interim]} />)

    expect(await screen.findByText('Let me inspect that.')).toBeTruthy()
    expect(live.container.querySelector('[data-slot="aui_compact-run-activity"]')).toBeTruthy()
    expect(live.container.querySelectorAll('[data-slot="aui_assistant-activity-root"]')).toHaveLength(1)
    live.unmount()

    const settled = render(<Harness messages={[userMessage(), interim, assistantMessage()]} />)

    expect(await screen.findByText('Let me inspect that.')).toBeTruthy()
    expect(await screen.findByText('done')).toBeTruthy()
    expect(settled.container.querySelector('[data-slot="aui_assistant-activity-root"]')).toBeNull()
  })

  it('retains the detailed streaming transcript only in explicit technical mode', async () => {
    setToolViewMode('technical')

    const running: ThreadMessage = {
      ...assistantMessage(),
      content: [{ type: 'text', text: 'technical live output' }],
      status: { type: 'running' }
    }

    render(<Harness isRunning messages={[userMessage(), running]} />)

    expect(await screen.findByText('technical live output')).toBeTruthy()
  })

  it('still paints group bubbles after a mid-turn exit leaves the last message running', async () => {
    const interrupted: ThreadMessage = {
      ...assistantMessage(),
      content: [
        {
          type: 'text',
          text: [botGroupReplyStart('dewey', 'Dewey'), 'checking the inbox', BOT_GROUP_REPLY_END].join('\n')
        }
      ],
      status: { type: 'running' }
    }

    const { container } = render(<Harness isRunning={false} messages={[userMessage(), interrupted]} />)

    expect(await screen.findByText('checking the inbox')).toBeTruthy()
    expect(container.querySelector('[data-slot="aui_bot-group-message-root"]')).toBeTruthy()
    expect(container.querySelector('[data-slot="aui_bot-group-bubble"]')).toBeTruthy()
  })
})
