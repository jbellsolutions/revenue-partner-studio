import { type ReactNode, useState } from 'react'

import { DisclosureCaret } from '@/components/ui/disclosure-caret'
import { cn } from '@/lib/utils'

export type TaskSegmentState = 'active' | 'cancelled' | 'completed' | 'pending'

interface StatusSectionProps {
  /** Optional right-aligned actions (text links / micro buttons). Pass
   *  `Button` with `size="micro"` + `variant="text"` or `"link"`. */
  accessory?: ReactNode
  children: ReactNode
  defaultCollapsed?: boolean
  /** Optional glyph between the caret and the label (e.g. a `Codicon`). */
  icon?: ReactNode
  label: ReactNode
  /** Tabular progress copy for the task variant (e.g. "0 of 3"). */
  taskProgressLabel?: string
  /** Per-task segment states driving the segmented progress rail. */
  taskSegments?: readonly TaskSegmentState[]
  /** Task checklist uses a lighter header without the group icon. */
  variant?: 'default' | 'task'
}

function TaskProgressRail({ segments }: { segments: readonly TaskSegmentState[] }) {
  if (segments.length === 0) {
    return null
  }

  const completed = segments.filter(segment => segment === 'completed').length

  return (
    <div
      aria-valuemax={segments.length}
      aria-valuemin={0}
      aria-valuenow={completed}
      className="flex gap-0.5"
      data-slot="task-progress-rail"
      role="progressbar"
    >
      {segments.map((segment, index) => (
        <span
          className={cn(
            'h-0.5 min-w-0 flex-1 rounded-full transition-colors duration-200',
            segment === 'completed' && 'bg-[color-mix(in_srgb,var(--ui-green)_72%,transparent)]',
            segment === 'active' && 'bg-[color-mix(in_srgb,var(--ui-accent)_68%,transparent)]',
            segment === 'pending' && 'bg-[color-mix(in_srgb,var(--ui-text-quaternary)_55%,transparent)]',
            segment === 'cancelled' && 'bg-[color-mix(in_srgb,var(--ui-text-tertiary)_42%,transparent)]'
          )}
          data-segment={segment}
          key={index}
        />
      ))}
    </div>
  )
}

/**
 * One collapsible group inside the composer status stack. Pure chrome — header
 * (caret + label) + body — styled to match the queue exactly so every status
 * (queue, subagents, background) reads as one piece. The stack supplies the
 * outer card and the dividers between groups; this owns only its own collapse.
 */
export function StatusSection({
  accessory,
  children,
  defaultCollapsed = true,
  icon,
  label,
  taskProgressLabel,
  taskSegments,
  variant = 'default'
}: StatusSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  const isTaskVariant = variant === 'task'

  return (
    <div data-slot="status-section" data-variant={variant}>
      <div className="flex items-center gap-1 pr-1">
        <button
          aria-expanded={!collapsed}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left transition-colors',
            isTaskVariant
              ? 'px-2.5 py-1.5 text-foreground/88 hover:text-foreground'
              : 'text-xs font-normal text-muted-foreground/92 hover:text-foreground/90'
          )}
          data-slot="status-section-header"
          onClick={() => setCollapsed(open => !open)}
          type="button"
        >
          <DisclosureCaret className="shrink-0" open={!collapsed} size="1em" />
          {isTaskVariant ? (
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium">{label}</span>
                {taskProgressLabel && (
                  <span className="shrink-0 text-[0.6875rem] tabular-nums text-muted-foreground/82">
                    {taskProgressLabel}
                  </span>
                )}
              </span>
              {taskSegments && taskSegments.length > 0 && <TaskProgressRail segments={taskSegments} />}
            </span>
          ) : (
            <>
              {icon && <span className="flex shrink-0 items-center">{icon}</span>}
              <span className="truncate">{label}</span>
            </>
          )}
        </button>
        {accessory && <div className="flex shrink-0 items-center gap-1">{accessory}</div>}
      </div>
      {!collapsed && (
        <div className={cn('px-1 pb-0.5', isTaskVariant && 'pb-1 pt-0.5')} data-slot="status-section-body">
          {children}
        </div>
      )}
    </div>
  )
}
