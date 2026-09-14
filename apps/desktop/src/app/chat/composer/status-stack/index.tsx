import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router'

import { blurComposerInput } from '@/app/chat/composer/focus'
import { AGENTS_ROUTE } from '@/app/routes'
import { BillingBanner } from '@/components/billing-banner'
import { composerStatusCard } from '@/components/chat/composer-dock'
import { StatusSection, type TaskSegmentState } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip, TipKeybindLabel } from '@/components/ui/tooltip'
import { type Translations, useI18n } from '@/i18n'
import { useSessionSlice } from '@/lib/use-session-slice'
import { cn } from '@/lib/utils'
import { $billingBlock } from '@/store/billing-block'
import {
  $statusItemsBySession,
  type ComposerStatusItem,
  dismissBackgroundProcess,
  groupStatusItems,
  refreshBackgroundProcesses,
  type StatusGroup,
  stopBackgroundProcess
} from '@/store/composer-status'
import { refreshSessionGoal } from '@/store/goals'
import { $previewStatusBySession, dismissPreviewArtifact } from '@/store/preview-status'
import { $threadScrolledUp } from '@/store/thread-scroll'
import { openSessionInNewWindow } from '@/store/windows'

import { PreviewStatusRow } from './preview-row'
import { StatusItemRow } from './status-row'

// Slow safety-net poll for silent exits (processes without notify_on_complete
// emit no event when they die). Only armed while a running row is on screen.
const BACKGROUND_POLL_MS = 5_000

// A localhost/loopback preview is only meaningful while its dev server is up, so
// we tie it to a live background process rather than persisting dismissals or
// letting dead URLs pile up. File previews (a real on-disk artifact) stand alone.
const isLocalhostPreview = (target: string): boolean => /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(target)

// Real codicons per group (no sparkles): a checklist for todos, the agent glyph
// for subagents, a background process glyph for background tasks.
const GROUP_ICON: Record<StatusGroup['type'], string> = {
  goal: 'target',
  todo: 'checklist',
  subagent: 'agent',
  background: 'server-process'
}

const todoTaskSegments = (items: ComposerStatusItem[]): TaskSegmentState[] =>
  items.map(item => {
    if (item.todoStatus === 'completed') {
      return 'completed'
    }

    if (item.todoStatus === 'cancelled') {
      return 'cancelled'
    }

    if (item.todoStatus === 'in_progress') {
      return 'active'
    }

    return 'pending'
  })

const groupLabel = (group: StatusGroup, s: Translations['statusStack']) => {
  if (group.type === 'goal') {
    const status = group.items[0]?.goalStatus

    return status === 'paused'
      ? s.goalPaused
      : status === 'waiting'
        ? s.goalWaiting
        : status === 'done'
          ? s.goalDone
          : s.goalActive
  }

  if (group.type === 'todo') {
    return s.tasksLabel
  }

  return group.type === 'subagent' ? s.subagents(group.items.length) : s.background(group.items.length)
}

interface ComposerStatusStackProps {
  /** The queue, built by the composer (it owns the queue's callbacks). Rendered
   *  as the last group so it stays fused to the composer like before. */
  queue: ReactNode
  sessionId: null | string
}

/**
 * The status "sink" above the composer: one card (the queue's chrome) holding
 * every session-scoped status — subagents, background tasks, queue — grouped by
 * type and separated by light dividers. Collapses to nothing when empty.
 */
export function ComposerStatusStack({ queue, sessionId }: ComposerStatusStackProps) {
  const { t } = useI18n()
  const navigate = useNavigate()
  // Subscribe to THIS session's slice only. Both maps churn on other
  // sessions' activity (subagent ticks, background polls, preview updates in
  // any tile); a whole-map `useStore` re-rendered every mounted stack — one
  // per open tile — on all of it. The per-key arrays are referentially stable
  // across unrelated writes, so the slice hook bails out unless OUR session's
  // items actually changed.
  const items = useSessionSlice($statusItemsBySession, sessionId)
  const previews = useSessionSlice($previewStatusBySession, sessionId)
  const scrolledUp = useStore($threadScrolledUp)
  const billing = useStore($billingBlock)

  const groups = useMemo(() => groupStatusItems(items), [items])

  // Seed from the registry on session open; event-driven refreshes (terminal /
  // process tool completions) live in use-message-stream.
  useEffect(() => {
    if (sessionId) {
      void refreshBackgroundProcesses(sessionId)
      void refreshSessionGoal(sessionId)
    }
  }, [sessionId])

  const hasRunningBackground = groups.some(g => g.type === 'background' && g.items.some(i => i.state === 'running'))

  // Drop localhost previews once no dev server is left running — that's what made
  // dead `localhost:5174` chips stick around. On-disk file previews are kept.
  const visiblePreviews = previews.filter(item => hasRunningBackground || !isLocalhostPreview(item.target))

  useEffect(() => {
    if (!sessionId || !hasRunningBackground) {
      return
    }

    const timer = setInterval(() => void refreshBackgroundProcesses(sessionId), BACKGROUND_POLL_MS)

    return () => clearInterval(timer)
  }, [hasRunningBackground, sessionId])

  const openAgents = () => navigate(AGENTS_ROUTE)

  const openSubagent = (item: ComposerStatusItem) =>
    item.sessionId ? void openSessionInNewWindow(item.sessionId, { watch: true }) : openAgents()

  // Preview links live as child rows of the background group — a localhost dev
  // server and its preview are the same thing — so they no longer float as an
  // odd, differently-indented standalone block under the stack.
  const previewRows =
    visiblePreviews.length > 0 && sessionId
      ? visiblePreviews.map(item => (
          <PreviewStatusRow item={item} key={item.id} onDismiss={id => dismissPreviewArtifact(sessionId, id)} />
        ))
      : []

  const hasBackgroundGroup = groups.some(g => g.type === 'background')

  const previewBlock = <div className="px-1 py-0.5">{previewRows}</div>

  const sections: { key: string; node: ReactNode }[] = []

  // Billing wall sits at the very top of the stack — it's the most important
  // thing above the composer when the account is out of credits. Rendered here
  // (not as a composer-disable) so slash commands stay usable.
  if (billing && sessionId && billing.sessionId === sessionId) {
    sections.push({ key: 'billing', node: <BillingBanner sessionId={sessionId} /> })
  }

  for (const group of groups) {
    const todoDone = group.type === 'todo' ? group.items.filter(i => i.todoStatus === 'completed').length : 0

    sections.push({
      key: group.type,
      node: (
        <StatusSection
          accessory={
            group.type === 'subagent' ? (
              <Tip label={<TipKeybindLabel actionId="nav.agents" text={t.statusStack.agents} />}>
                <Button
                  className="text-muted-foreground/75 hover:text-foreground/90"
                  onClick={openAgents}
                  size="micro"
                  type="button"
                  variant="text"
                >
                  {t.statusStack.agents}
                </Button>
              </Tip>
            ) : undefined
          }
          defaultCollapsed={group.type !== 'todo' && group.type !== 'goal'}
          icon={
            group.type === 'todo' ? undefined : (
              <Codicon className="text-muted-foreground/70" name={GROUP_ICON[group.type]} size="0.8rem" />
            )
          }
          label={groupLabel(group, t.statusStack)}
          taskProgressLabel={
            group.type === 'todo' ? t.statusStack.tasksProgress(todoDone, group.items.length) : undefined
          }
          taskSegments={group.type === 'todo' ? todoTaskSegments(group.items) : undefined}
          variant={group.type === 'todo' ? 'task' : 'default'}
        >
          {group.items.map(item => (
            <StatusItemRow
              item={item}
              key={item.id}
              onDismiss={sessionId ? id => dismissBackgroundProcess(sessionId, id) : undefined}
              onOpen={() => openSubagent(item)}
              onStop={sessionId ? id => void stopBackgroundProcess(sessionId, id) : undefined}
            />
          ))}
        </StatusSection>
      )
    })

    // Preview links belong to the background group (a localhost dev server and
    // its preview are the same thing), but they must stay VISIBLE even when that
    // group is collapsed — the whole point is a one-tap open. Render them as an
    // always-visible block right after the background section, not as collapsible
    // children that get swallowed the moment a background task appears.
    if (group.type === 'background' && previewRows.length > 0) {
      sections.push({ key: 'preview', node: previewBlock })
    }
  }

  // No background group to host them (e.g. a standalone on-disk file preview):
  // still render them as their own always-visible block.
  if (previewRows.length > 0 && !hasBackgroundGroup) {
    sections.push({ key: 'preview', node: previewBlock })
  }

  if (queue) {
    sections.push({ key: 'queue', node: queue })
  }

  // Micro actions are the TOP-MOST thing in the whole overlay lane — above the
  // status card, above the billing wall, above everything. They're the only
  // rows up here you press instead of read, so nothing may ever stack on top
  // of them. Rendered outside the card (below) so the pills float.
  const visible = sections.length > 0

  // No height to publish: the stack is an in-flow child of the composer dock,
  // so the dock's own measurement (--composer-measured-height) already covers
  // it and the thread clears both with one number.

  if (!visible) {
    return null
  }

  return (
    <div
      // In flow in the dock column, above the composer. The bottom margin is a
      // real layout gap: status content can never paint into the input surface.
      className="flex max-h-[40vh] min-h-0 flex-col overflow-y-auto"
      data-layout="detached"
      data-slot="composer-status-stack"
      onPointerDownCapture={() => blurComposerInput()}
    >
      {/* A standalone card with four real corners and a complete border. It is
          intentionally detached from the composer instead of sharing a seam:
          the old fused treatment read as an overlapping input. */}
      {sections.length > 0 && (
        <div
          className={cn(
            composerStatusCard,
            'mx-2 mb-2 overflow-hidden p-1',
            'transition-opacity duration-200 ease-out',
            scrolledUp ? 'opacity-30 group-hover/composer:opacity-100' : 'opacity-100'
          )}
          data-slot="composer-status-card"
        >
          {sections.map(section => (
            <div key={section.key}>{section.node}</div>
          ))}
        </div>
      )}
    </div>
  )
}
