import {
  ActionBarPrimitive,
  ErrorPrimitive,
  MessagePrimitive,
  useAuiState,
  useMessageRuntime
} from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, useCallback, useMemo, useState } from 'react'

import { MarkdownTextContent } from '@/components/assistant-ui/markdown-text'
import { ChangedFilesCard } from '@/components/assistant-ui/thread/changed-files-card'
import {
  contentHasVisibleText,
  messageContentText,
  pickPrimaryPreviewTarget
} from '@/components/assistant-ui/thread/content'
import { MESSAGE_PARTS_COMPONENTS, shouldPresentProductTool } from '@/components/assistant-ui/thread/message-parts'
import { ReactionPicker } from '@/components/assistant-ui/thread/message-reactions'
import {
  CompactRunActivityIndicator,
  ResponseLoadingIndicator,
  StreamStallIndicator
} from '@/components/assistant-ui/thread/status'
import { type RestoreMessageTarget } from '@/components/assistant-ui/thread/types'
import { useMessageReactions, useTapbackDoubleClick } from '@/components/assistant-ui/thread/use-message-reactions'
import { AgentAvatar } from '@/components/assistant-ui/thread/user-message'
import type { ToolPart } from '@/components/assistant-ui/tool/fallback-model'
import { TooltipIconButton } from '@/components/assistant-ui/tooltip-icon-button'
import { PreviewAttachment } from '@/components/chat/preview-attachment'
import { CopyButton } from '@/components/ui/copy-button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { parseBotGroupReplies, stripBotGroupContext } from '@/lib/bot-group-chat'
import { triggerHaptic } from '@/lib/haptics'
import { CornerDownLeft, MoreHorizontalIcon, RefreshCwIcon, SmilePlusIcon, XIcon } from '@/lib/icons'
import { extractPreviewTargets } from '@/lib/preview-targets'
import { useEnterAnimation } from '@/lib/use-enter-animation'
import { cn } from '@/lib/utils'
import { $toolViewMode } from '@/store/tool-view'

// Stable empty identity for the settled-parts selector — a fresh [] per render
// would re-derive the changed-files card on every message re-render.
const EMPTY_PARTS: readonly unknown[] = []

interface MessageActionProps {
  messageId: string
  /** Lazy accessor — reads the live message text at action time. Passing the
   *  text itself as a prop forces the whole footer to re-render on every
   *  streaming delta flush (the text changes ~30×/s), which profiling showed
   *  was a large slice of per-token script time on long transcripts. */
  getMessageText: () => string
  onRequestRestoreConfirm?: (messageId: string, target: RestoreMessageTarget) => void
}

export const AssistantMessage: FC<{
  onDismissError?: (messageId: string) => void
  onRequestRestoreConfirm?: (messageId: string, target: RestoreMessageTarget) => void
}> = ({ onDismissError, onRequestRestoreConfirm }) => {
  const messageId = useAuiState(s => s.message.id)
  const messageRuntime = useMessageRuntime()
  const { t } = useI18n()
  const toolViewMode = useStore($toolViewMode)
  const productMode = toolViewMode === 'product'

  // PERF: this component must NOT subscribe to the streaming text. Every
  // selector here returns a value that stays referentially stable across
  // token flushes (booleans, status strings, '' while running), so the
  // 30 Hz delta stream only re-renders the markdown part and the tiny
  // StreamStallIndicator leaf — not the footer/preview/root subtree.
  const messageStatus = useAuiState(s => s.message.status?.type)
  const isRunning = messageStatus === 'running'
  const isPlaceholder = useAuiState(s => s.message.status?.type === 'running' && s.message.content.length === 0)
  const hasVisibleText = useAuiState(s => contentHasVisibleText(s.message.content))
  // Sealed mid-turn commentary keeps its text but not the footer, so a
  // tool-heavy turn doesn't grow a copy/refresh bar per paragraph (see
  // ChatMessage.interim).
  const isInterim = useAuiState(s => s.message.metadata?.custom?.interim === true)
  const threadRunning = useAuiState(s => s.thread.isRunning)

  const hasPresentedTool = useAuiState(s =>
    s.message.parts.some(part => part.type === 'tool-call' && shouldPresentProductTool(part as ToolPart))
  )

  // The thinking/stall indicator belongs to the TAIL of the thread, period. A
  // stale pending bubble mid-transcript (a turn that ended without its settle
  // event, a steer race) must never show one — a spinner above a later user
  // message reads as the agent answering out of order. Booleans are stable
  // across token flushes, so this selector adds no streaming re-renders.
  const isLastMessage = useAuiState(s => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id)
  const productRunActive = productMode && isLastMessage && threadRunning && (isRunning || isInterim)

  // Preview targets only materialize once the turn completes — while running
  // the selector returns '' (stable), so per-token flushes skip the regex
  // scan and the re-render it would cause.
  const completedText = useAuiState(s =>
    s.message.status?.type === 'running' ? '' : messageContentText(s.message.content)
  )

  // Live product-mode turns still buffer prose behind the activity indicator.
  // After an interrupt the message can stay `running` while the thread is not,
  // and that used to blank the coordinator dump (and its group bubbles).
  const groupSourceText = useAuiState(s =>
    s.message.status?.type === 'running' && s.thread.isRunning ? '' : messageContentText(s.message.content)
  )

  const previewTargets = useMemo(() => {
    if (!completedText || !/(https?:\/\/|file:\/\/)/i.test(completedText)) {
      return []
    }

    return pickPrimaryPreviewTarget(extractPreviewTargets(completedText))
  }, [completedText])

  const getMessageText = useCallback(() => {
    const text = messageContentText(messageRuntime.getState().content)
    const replies = parseBotGroupReplies(text)

    return replies.length ? replies.map(reply => `${reply.name}: ${reply.text}`).join('\n\n') : text
  }, [messageRuntime])

  const groupReplies = useMemo(() => parseBotGroupReplies(groupSourceText), [groupSourceText])

  // Cursor's changed-files card only appears once the turn settles: while the
  // agent is still editing, the tool rows narrate each patch and a card that
  // grew a row per write would thrash the transcript. `[]` while running keeps
  // this selector referentially stable across the 30 Hz delta stream.
  //
  // It also only rides the LAST turn. The card is a "here's what just landed"
  // summary, not a per-turn artifact: leaving one behind on every reply would
  // stack a wall of stale cards down the transcript. Sending the next message
  // retires it — the working tree it describes is already history by then.
  const settledParts = useAuiState(s => {
    const isLastMessage = s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id

    return s.message.status?.type === 'running' || !isLastMessage ? EMPTY_PARTS : s.message.parts
  })

  const enterRef = useEnterAnimation(isRunning || productRunActive, `assistant-message:${messageId}`)

  // Double-click the reply to heart it (iMessage). Undefined while reactions
  // are off, so the root carries no listener at all.
  const onDoubleClick = useTapbackDoubleClick(messageId, 'assistant')

  // Product chat keeps real, agent-authored message.interim commentary as a
  // short conversational bubble. Only empty/running carriers disappear; the
  // technical view still retains every event-by-event row.
  if (productMode && !productRunActive && !hasVisibleText && !hasPresentedTool && messageStatus !== 'incomplete') {
    return null
  }

  if (groupReplies.length > 0) {
    return (
      <MessagePrimitive.Root
        className="group flex w-full min-w-0 flex-col items-start gap-1 overflow-visible"
        data-role="assistant"
        data-slot="aui_bot-group-message-root"
        onDoubleClick={onDoubleClick}
        ref={enterRef}
      >
        <div className="relative flex w-fit max-w-[88%] flex-col items-start gap-1">
          {groupReplies.map((reply, index) => {
            const cluster =
              groupReplies.length < 2
                ? undefined
                : index === 0
                  ? 'first'
                  : index === groupReplies.length - 1
                    ? 'last'
                    : 'middle'

            return (
              <div className="flex max-w-full items-end gap-2" key={`${reply.profile}:${index}`}>
                <AgentAvatar className="mb-0.5 size-4 text-[9px]" handle={reply.profile} />
                <div className="min-w-0">
                  <div className="mb-0.5 px-1 text-[9px] font-medium text-(--ui-text-tertiary)">{reply.name}</div>
                  <div
                    className="wrap-anywhere min-w-0 max-w-full overflow-hidden rounded-xl bg-(--ui-assistant-message-background) px-2 py-0.5 text-pretty text-[10px] leading-[1.35] text-(--orgo-ink) [--conversation-text-font-size:10px]"
                    data-bot-profile={reply.profile}
                    data-cluster={cluster}
                    data-slot="aui_bot-group-bubble"
                  >
                    <MarkdownTextContent disableArtifacts isRunning={false} text={reply.text} />
                  </div>
                </div>
              </div>
            )
          })}
          <div className="w-full pl-8">
            <AssistantFooter
              getMessageText={getMessageText}
              messageId={messageId}
              onRequestRestoreConfirm={onRequestRestoreConfirm}
            />
          </div>
        </div>
      </MessagePrimitive.Root>
    )
  }

  return (
    <>
      <MessagePrimitive.Root
        className="group relative flex w-fit min-w-0 max-w-[88%] flex-col gap-0 self-start overflow-visible"
        data-role="assistant"
        data-slot="aui_assistant-message-root"
        data-streaming={isRunning ? 'true' : undefined}
        onDoubleClick={onDoubleClick}
        ref={enterRef}
      >
        <div
          className="wrap-anywhere min-w-0 max-w-full overflow-hidden rounded-xl bg-(--ui-assistant-message-background) px-2 py-0.5 text-pretty text-[10px] leading-[1.35] text-(--orgo-ink) [--conversation-text-font-size:10px]"
          data-slot="aui_assistant-message-content"
        >
          {/* Todos render in the composer status stack now, not inline. */}
          <MessagePrimitive.Parts components={MESSAGE_PARTS_COMPONENTS} />
          {productMode
            ? productRunActive && !isInterim && <CompactRunActivityIndicator />
            : isLastMessage && (isPlaceholder ? <ResponseLoadingIndicator /> : isRunning && <StreamStallIndicator />)}
          {previewTargets.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {previewTargets.map(target => (
                <PreviewAttachment key={target} source="explicit-link" target={target} />
              ))}
            </div>
          )}
          <MessagePrimitive.Error>
            <ErrorPrimitive.Root
              className="mt-1.5 flex items-start gap-1.5 text-[0.78rem] leading-5 text-[color-mix(in_srgb,var(--dt-destructive)_78%,var(--ui-text-secondary))]"
              role="alert"
            >
              <ErrorPrimitive.Message className="min-w-0 flex-1" />
              {onDismissError && (
                <TooltipIconButton
                  className="-my-0.5 shrink-0 text-current opacity-70 hover:opacity-100"
                  onClick={() => onDismissError(messageId)}
                  side="top"
                  tooltip={t.assistant.thread.dismissError}
                >
                  <XIcon className="size-3.5" />
                </TooltipIconButton>
              )}
            </ErrorPrimitive.Root>
          </MessagePrimitive.Error>
        </div>
        {hasVisibleText && !isInterim && !isRunning && (
          <AssistantFooter
            getMessageText={getMessageText}
            messageId={messageId}
            onRequestRestoreConfirm={onRequestRestoreConfirm}
          />
        )}
        {/* Last thing in the turn — under the action bar, the way Cursor ends a
            turn on its summary rather than burying it above the controls. */}
        <ChangedFilesCard parts={productMode ? EMPTY_PARTS : settledParts} />
      </MessagePrimitive.Root>
      {productRunActive && isInterim && (
        <div
          className="flex w-fit min-w-0 max-w-[88%] self-start overflow-hidden rounded-xl bg-(--ui-assistant-message-background) px-2 py-0.5 text-[10px] leading-[1.35] [--conversation-text-font-size:10px]"
          data-role="assistant"
          data-slot="aui_assistant-activity-root"
        >
          <CompactRunActivityIndicator ignoreMessageText />
        </div>
      )}
    </>
  )
}

const AssistantActionBar: FC<MessageActionProps> = ({ messageId, getMessageText, onRequestRestoreConfirm }) => {
  const { t } = useI18n()
  const copy = t.assistant.thread
  const isLastMessage = useAuiState(s => s.thread.messages[s.thread.messages.length - 1]?.id === s.message.id)

  const restoreUserIndex = useAuiState(s => {
    const messageIndex = s.thread.messages.findIndex(message => message.id === s.message.id)

    for (let index = messageIndex - 1; index >= 0; index -= 1) {
      if (s.thread.messages[index]?.role === 'user') {
        return index
      }
    }

    return -1
  })

  const restoreMessageId = useAuiState(s => s.thread.messages[restoreUserIndex]?.id ?? null)

  const restoreText = useAuiState(s =>
    stripBotGroupContext(messageContentText(s.thread.messages[restoreUserIndex]?.content))
  )

  const restoreUserOrdinal = useAuiState(
    s =>
      s.thread.messages
        .slice(0, restoreUserIndex + 1)
        .reduce((count, message) => count + (message.role === 'user' ? 1 : 0), 0) - 1
  )

  const [pickerOpen, setPickerOpen] = useState(false)
  const { enabled: reactionsEnabled, react, reactions: shownReactions } = useMessageReactions(messageId, 'assistant')

  const pickEmoji = useCallback(
    (emoji: null | string) => {
      setPickerOpen(false)
      react(emoji)
    },
    [react]
  )

  return (
    <div
      className={cn(
        'relative flex h-5 w-full shrink-0 items-center justify-end gap-0.5 text-(--ui-text-tertiary) transition-opacity',
        !isLastMessage &&
          'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100'
      )}
    >
      {(reactionsEnabled || shownReactions.length > 0) && (
        <ReactionPicker
          onOpenChange={setPickerOpen}
          onSelect={pickEmoji}
          open={pickerOpen}
          selected={shownReactions.find(reaction => reaction.author === 'user')?.emoji}
        >
          <TooltipIconButton
            className="size-5"
            data-reacted={shownReactions.length > 0 || undefined}
            data-slot="aui_msg-reactions"
            data-state={pickerOpen ? 'open' : undefined}
            onClick={reactionsEnabled ? () => setPickerOpen(open => !open) : undefined}
            tooltip={copy.react}
          >
            {shownReactions.length > 0 ? (
              <span className="flex items-center gap-0.5 text-[0.75rem] leading-none">
                {shownReactions.map(reaction => (
                  <span className="reaction-pop" key={`${reaction.author}-${reaction.emoji}`}>
                    {reaction.emoji}
                  </span>
                ))}
              </span>
            ) : (
              <SmilePlusIcon className="size-3.5" />
            )}
          </TooltipIconButton>
        </ReactionPicker>
      )}
      <ActionBarPrimitive.Root
        className="relative flex h-5 flex-row items-center justify-start gap-0.5"
        data-slot="aui_msg-actions"
      >
        <ActionBarPrimitive.Reload asChild>
          <TooltipIconButton className="size-5" onClick={() => triggerHaptic('submit')} tooltip={copy.refresh}>
            <RefreshCwIcon className="size-3.5" />
          </TooltipIconButton>
        </ActionBarPrimitive.Reload>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <TooltipIconButton className="size-5" tooltip={copy.moreActions}>
              <MoreHorizontalIcon className="size-3.5" />
            </TooltipIconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-40" sideOffset={4}>
            {onRequestRestoreConfirm && restoreMessageId && (
              <DropdownMenuItem
                onSelect={() => {
                  triggerHaptic('selection')
                  onRequestRestoreConfirm(restoreMessageId, {
                    text: restoreText,
                    userOrdinal: restoreUserOrdinal
                  })
                }}
              >
                <CornerDownLeft className="size-3.5" />
                {copy.restoreCheckpoint}
              </DropdownMenuItem>
            )}
            <CopyButton appearance="menu-item" label={copy.copy} text={getMessageText} />
          </DropdownMenuContent>
        </DropdownMenu>
      </ActionBarPrimitive.Root>
    </div>
  )
}

const AssistantFooter: FC<MessageActionProps> = props => (
  <div className="absolute top-1/2 left-full z-10 ml-1 flex h-5 w-max -translate-y-1/2 items-center justify-end">
    <AssistantActionBar {...props} />
  </div>
)
