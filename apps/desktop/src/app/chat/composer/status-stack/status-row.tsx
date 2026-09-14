import { Fragment, memo, type ReactNode } from 'react'

import { openAgentTerminal } from '@/app/right-sidebar/terminal/terminals'
import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { GlyphSpinner } from '@/components/ui/glyph-spinner'
import { Tip } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { capitalize } from '@/lib/text'
import type { TodoStatus } from '@/lib/todos'
import { cn } from '@/lib/utils'
import type { ComposerStatusItem } from '@/store/composer-status'

const toolLabel = (name: string) => name.split('_').filter(Boolean).map(capitalize).join(' ') || name

// Todo rows speak checkbox, not spinner-and-dot: a crisp neutral ring while the
// item is still open (pending), token-colored checks once it resolves, a live
// spinner only on the in-progress item.
const TODO_GLYPHS: Record<Exclude<TodoStatus, 'in_progress' | 'pending'>, { icon: string; tone: string }> = {
  cancelled: { icon: 'circle-slash', tone: 'text-muted-foreground/45' },
  completed: { icon: 'pass-filled', tone: 'text-[color-mix(in_srgb,var(--ui-green)_82%,transparent)]' }
}

// Left slot: braille spinner while running, otherwise a small status dot
// (green = done, red = failed) so the slot is always filled and rows align.
function leadingGlyph(item: ComposerStatusItem, s: Translations['statusStack']): ReactNode {
  if (item.type === 'goal') {
    if (item.goalStatus === 'paused') {
      return <Codicon className="text-muted-foreground/60" name="debug-pause" size="0.8rem" />
    }

    if (item.goalStatus === 'done') {
      return <Codicon className="text-[color-mix(in_srgb,var(--ui-green)_82%,transparent)]" name="pass-filled" size="0.8rem" />
    }

    return (
      <GlyphSpinner
        ariaLabel={s.running}
        className="text-[0.85rem] leading-none text-[color-mix(in_srgb,var(--ui-green)_82%,transparent)]"
        spinner="braille"
      />
    )
  }

  if (item.todoStatus === 'pending') {
    return (
      <span
        aria-hidden
        className="box-border size-[0.72rem] rounded-full border border-[color-mix(in_srgb,var(--ui-text-tertiary)_72%,transparent)]"
      />
    )
  }

  if (item.todoStatus && item.todoStatus !== 'in_progress') {
    const glyph = TODO_GLYPHS[item.todoStatus]

    return <Codicon className={glyph.tone} name={glyph.icon} size="0.8rem" />
  }

  if (item.state === 'running') {
    return (
      <GlyphSpinner
        ariaLabel={s.running}
        className="text-[0.85rem] leading-none text-foreground/78"
        spinner="braille"
      />
    )
  }

  return (
    <span
      aria-hidden
      className={cn(
        'size-1.5 rounded-full',
        item.state === 'failed'
          ? 'bg-destructive/80'
          : 'bg-[color-mix(in_srgb,var(--ui-green)_72%,transparent)]'
      )}
    />
  )
}

interface StatusItemRowProps {
  item: ComposerStatusItem
  /** Clear a finished background task from the stack. */
  onDismiss?: (id: string) => void
  /** Open the subagent's own session window, livestreamed by the gateway's
   *  child-session mirror (Agents view fallback for older gateways). */
  onOpen?: () => void
  /** Cancel a running background task. */
  onStop?: (id: string) => void
}

/**
 * Renders one {@link ComposerStatusItem} into the shared {@link StatusRow}.
 * Memoised + keyed by id so parent re-renders never remount it (the spinner
 * keeps ticking instead of resetting).
 */
export const StatusItemRow = memo(function StatusItemRow({ item, onDismiss, onOpen, onStop }: StatusItemRowProps) {
  const { t } = useI18n()
  const s = t.statusStack
  const failed = item.state === 'failed'
  const running = item.state === 'running'
  const isTodo = item.type === 'todo'
  const todoActive = isTodo && item.todoStatus === 'in_progress'
  const todoCompleted = isTodo && item.todoStatus === 'completed'
  const todoCancelled = isTodo && item.todoStatus === 'cancelled'

  const action =
    item.type === 'background'
      ? running
        ? onStop && { label: s.stop, onClick: () => onStop(item.id) }
        : onDismiss && { label: s.dismiss, onClick: () => onDismiss(item.id) }
      : null

  const canOpen = item.type === 'subagent' && !!onOpen

  // Background rows link to their read-only terminal tab; subagents open their session.
  const onActivate =
    item.type === 'background' ? () => openAgentTerminal(item.id, item.title) : canOpen ? onOpen : undefined

  return (
    <Fragment>
      <StatusRow
        className={cn(
          isTodo && 'min-h-7 px-2 py-1',
          todoActive && 'bg-(--ui-row-active-background)',
          todoActive && 'shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ui-accent)_10%,transparent)]'
        )}
        data-task-state={isTodo ? item.todoStatus : undefined}
        leading={leadingGlyph(item, s)}
        onActivate={onActivate}
        suppressHover={isTodo}
        trailing={
          action ? (
            <Tip label={action.label}>
              <Button
                aria-label={action.label}
                className="-my-1 size-4 rounded-md text-muted-foreground/60 hover:text-foreground/90"
                onClick={event => {
                  event.stopPropagation()
                  action.onClick()
                }}
                size="icon-xs"
                type="button"
                variant="ghost"
              >
                <Codicon name="close" size="0.75rem" />
              </Button>
            </Tip>
          ) : canOpen ? (
            <Codicon aria-hidden className="text-muted-foreground/55" name="link-external" size="0.85rem" />
          ) : undefined
        }
      >
        <span
          className={cn(
            'min-w-0 truncate leading-[1.125rem]',
            isTodo ? 'text-[0.8125rem]' : 'text-[0.73rem] leading-4',
            failed
              ? 'text-destructive/90'
              : todoCompleted || todoCancelled
                ? 'text-muted-foreground/68'
                : todoActive
                  ? 'font-medium text-foreground/94'
                  : isTodo
                    ? 'text-foreground/86'
                    : item.todoStatus && item.todoStatus !== 'in_progress'
                      ? 'text-muted-foreground/75'
                      : 'text-foreground/92'
          )}
        >
          {item.title}
        </span>
        {item.type === 'subagent' && item.currentTool && (
          <span className="shrink-0 truncate text-[0.62rem] leading-4 text-muted-foreground/70">
            {toolLabel(item.currentTool)}
          </span>
        )}
        {item.type === 'goal' && item.currentTool && (
          <span className="shrink-0 truncate text-[0.62rem] leading-4 text-muted-foreground/70">
            {item.currentTool}
          </span>
        )}
        {failed && typeof item.exitCode === 'number' && item.exitCode !== 0 && (
          <span className="shrink-0 rounded bg-destructive/15 px-1 text-[0.58rem] font-semibold text-destructive tabular-nums">
            {s.exit(item.exitCode)}
          </span>
        )}
      </StatusRow>
    </Fragment>
  )
})
