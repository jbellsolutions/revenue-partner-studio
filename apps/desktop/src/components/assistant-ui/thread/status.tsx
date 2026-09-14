import { useAuiState } from '@assistant-ui/react'
import { useStore } from '@nanostores/react'
import { type FC, type ReactNode, useEffect, useMemo, useState } from 'react'

import { useSessionView } from '@/app/chat/session-view'
import { summarizeToolRun, type ToolCallLike, toolPresentVerb } from '@/components/assistant-ui/tool/run-summary'
import { useElapsedSeconds } from '@/components/chat/activity-timer'
import { ActivityTimerText } from '@/components/chat/activity-timer-text'
import { SCAFFOLD_LABEL_CLASS } from '@/components/chat/scaffold-row'
import { Codicon } from '@/components/ui/codicon'
import { Loader } from '@/components/ui/loader'
import { StatusPulse } from '@/components/ui/status-pulse'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $backgroundResume } from '@/store/background-delegation'
import { sessionCompacting } from '@/store/compaction'
import { sessionAwaitingInput } from '@/store/prompts'
import { $turnStartedAt } from '@/store/session'
import { type DraftingTool, sessionDraftingTool } from '@/store/tool-drafting'

// A status line is scaffolding like any other — "Editing" while the model
// drafts a call is the same kind of line as "Explored 3 files" once it has run,
// and reads as one continuous column only if it shares their type and colour.
const StatusRow: FC<{ children: ReactNode; label: string } & React.ComponentPropsWithoutRef<'div'>> = ({
  children,
  label,
  className,
  ...rest
}) => (
  <div
    aria-atomic="true"
    aria-label={label}
    aria-live="polite"
    className={cn(
      'flex min-w-0 max-w-full items-center gap-1.5 self-start leading-(--conversation-line-height)',
      'text-(--conversation-scaffold-text)',
      className
    )}
    data-conversation-scaffold=""
    role="status"
    {...rest}
  >
    {children}
  </div>
)

// Fixed label while auto-compaction runs — decoupled from backend status text.
const COMPACTION_LABEL = 'Summarizing thread'

const HintText: FC<{ children: ReactNode }> = ({ children }) => (
  <span className={cn(SCAFFOLD_LABEL_CLASS, 'shimmer min-w-0 flex-1 truncate')}>{children}</span>
)

/** These indicators render inside whichever transcript mounted them, so every
 *  session-scoped signal comes from that surface's view — a tile must never
 *  show the primary chat's compaction, prompt-wait, or turn timer. */
function useThreadSessionStatus() {
  const sessionId = useStore(useSessionView().$runtimeId)
  const turnStartedAt = useStore($turnStartedAt)
  const compacting = useStore(useMemo(() => sessionCompacting(sessionId), [sessionId]))
  const drafting = useStore(useMemo(() => sessionDraftingTool(sessionId), [sessionId]))
  // A pending clarify / approval / sudo / secret means the turn is paused on the
  // user, not working — so don't resurrect the "thinking" timer while they
  // decide (matches the pet's awaitingInput pose taking priority over busy).
  const awaitingInput = useStore(useMemo(() => sessionAwaitingInput(sessionId), [sessionId]))

  return {
    awaitingInput,
    compacting,
    drafting,
    turnTimerKey: sessionId && turnStartedAt ? `turn:${sessionId}:${turnStartedAt}` : undefined
  }
}

// Long enough that a tool whose arguments arrive in a few frames never gets to
// strobe a label, short enough that a real wait is named almost immediately.
const DRAFTING_REVEAL_MS = 200
const PRODUCT_ACTIVITY_REVEAL_MS = 900
const PRODUCT_ACTIVITY_UPDATE_MS = 900
const PRODUCT_ACTIVITY_TIMER_REVEAL_S = 10

/**
 * What to call the wait, if it deserves a name. Compaction outranks a draft —
 * it's rarer, slower, and explains a transcript that looks like it reset.
 */
function useStatusHint(compacting: boolean, drafting: DraftingTool | null): string {
  const [revealed, setRevealed] = useState(false)
  const name = drafting?.name ?? ''

  useEffect(() => {
    setRevealed(false)

    if (!name) {
      return
    }

    const id = window.setTimeout(() => setRevealed(true), DRAFTING_REVEAL_MS)

    return () => window.clearTimeout(id)
  }, [name])

  if (compacting) {
    return COMPACTION_LABEL
  }

  return revealed && name ? toolPresentVerb(name) : ''
}

export const CenteredThreadSpinner: FC = () => {
  const { t } = useI18n()

  return (
    <div
      aria-label={t.assistant.thread.loadingSession}
      className="pointer-events-none absolute inset-0 z-1 grid place-items-center"
      role="status"
    >
      <Loader
        aria-hidden="true"
        className="size-12 text-midground/70"
        pathSteps={220}
        role="presentation"
        strokeScale={0.72}
        type="rose-curve"
      />
    </div>
  )
}

export const ResponseLoadingIndicator: FC = () => {
  const { t } = useI18n()
  const { compacting, drafting, turnTimerKey } = useThreadSessionStatus()
  const elapsed = useElapsedSeconds(true, turnTimerKey)
  const hint = useStatusHint(compacting, drafting)

  return (
    <StatusRow data-slot="aui_response-loading" label={hint || t.assistant.thread.loadingResponse}>
      <StatusPulse
        aria-hidden="true"
        className="dither inline-block size-3 rounded-[2px] text-midground/80"
        kind="opacity"
      />
      {hint && <HintText>{hint}</HintText>}
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}

interface CompactActivityPart {
  args?: unknown
  isError?: boolean
  result?: unknown
  text?: string
  toolCallId?: string
  toolName?: string
  type: string
}

const ACTIVITY_LABEL_MAX_LENGTH = 92

/**
 * The activity reel is visible UI, so keep provider prose and tool targets to
 * one quiet, safe line. This intentionally catches the credential shapes most
 * likely to appear in shell commands while leaving ordinary paths and queries
 * useful enough to explain the work.
 */
function cleanActivityLabel(value: string): string {
  const normalized = value
    .replace(/```(?:\w+)?/g, '')
    .replace(/`/g, '')
    .replace(/\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)=([^\s]+)/gi, match => {
      const equalsAt = match.indexOf('=')

      return `${match.slice(0, equalsAt)}=[hidden]`
    })
    .replace(/\b(?:sk|xai)[-_][A-Za-z0-9_-]{12,}\b/g, '[credential]')
    .replace(/\s+/g, ' ')
    .trim()

  if (normalized.length <= ACTIVITY_LABEL_MAX_LENGTH) {
    return normalized
  }

  return `${normalized.slice(0, ACTIVITY_LABEL_MAX_LENGTH - 1).trimEnd()}…`
}

function latestThoughtLabel(text: string): string {
  // Reasoning arrives token by token. Updating the selector for every token
  // would defeat the calm reel even though the DOM is throttled, so a thought
  // only becomes UI copy once the provider has completed a sentence or line.
  const lines = text.split(/\n/).map(line => line.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, '').trim())
  const stableLines = text.endsWith('\n') ? lines : lines.slice(0, -1)
  const completeSentences = text.match(/[^.!?\n]+[.!?]+(?=\s|$)/g) ?? []
  const latestStableThought = completeSentences.at(-1)?.trim() || stableLines.filter(Boolean).at(-1) || ''

  const thought = cleanActivityLabel(latestStableThought.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, ''))

  return thought ? `Thinking · ${thought}` : 'Thinking'
}

function toolActivityLabel(part: CompactActivityPart): string {
  const tool = part as ToolCallLike

  return cleanActivityLabel(summarizeToolRun([tool], part.result === undefined))
}

/**
 * Resolve a whole noisy stream into the newest user-facing event. The caller
 * renders this in one stable bubble, so a new thought/tool/writing phase
 * replaces the previous line instead of adding another transcript row.
 *
 * This is purposely deterministic: it never asks the model to summarize its
 * own trace. We only sample provider-exposed reasoning and the same safe tool
 * summaries used by the technical transcript.
 */
export function compactRunActivityLabel(
  parts: readonly CompactActivityPart[],
  compacting: boolean,
  draftingName = '',
  ignoreText = false
): string {
  if (compacting) {
    return COMPACTION_LABEL
  }

  if (draftingName) {
    return toolPresentVerb(draftingName)
  }

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!

    if (!ignoreText && part.type === 'text' && part.text?.trim()) {
      return 'Writing reply'
    }

    if (part.type === 'reasoning' && part.text?.trim()) {
      return latestThoughtLabel(part.text)
    }

    if (part.type === 'tool-call' && part.toolName) {
      return toolActivityLabel(part)
    }
  }

  return ''
}

function useCalmActivityLabel(next: string): string {
  const [shown, setShown] = useState(next)
  const [lastUpdatedAt, setLastUpdatedAt] = useState(Date.now)

  useEffect(() => {
    if (next === shown) {
      return
    }

    const elapsed = Date.now() - lastUpdatedAt
    const remaining = Math.max(0, PRODUCT_ACTIVITY_UPDATE_MS - elapsed)

    const apply = () => {
      setLastUpdatedAt(Date.now())
      setShown(next)
    }

    if (remaining === 0) {
      apply()

      return
    }

    const id = window.setTimeout(apply, remaining)

    return () => window.clearTimeout(id)
  }, [lastUpdatedAt, next, shown])

  return shown
}

/**
 * The product-mode activity reel. It remains mounted for the full run, paints
 * no answer tokens, and calmly replaces one line with the newest exposed
 * thought, tool action, result, or writing phase. Technical mode keeps the
 * original detailed rows instead.
 */
export const CompactRunActivityIndicator: FC<{ ignoreMessageText?: boolean }> = ({ ignoreMessageText = false }) => {
  const { t } = useI18n()
  const { awaitingInput, compacting, drafting, turnTimerKey } = useThreadSessionStatus()
  const elapsed = useElapsedSeconds(true, turnTimerKey)
  const [labelReady, setLabelReady] = useState(false)

  const nextLabel = useAuiState(state =>
    compactRunActivityLabel(
      state.message.parts as readonly CompactActivityPart[],
      compacting,
      drafting?.name,
      ignoreMessageText
    )
  )

  const label = useCalmActivityLabel(nextLabel)

  useEffect(() => {
    const id = window.setTimeout(() => setLabelReady(true), PRODUCT_ACTIVITY_REVEAL_MS)

    return () => window.clearTimeout(id)
  }, [])

  if (awaitingInput) {
    return null
  }

  const visibleLabel = labelReady ? label : ''

  return (
    <StatusRow
      className="min-h-5 text-(--orgo-ink-secondary)"
      data-slot="aui_compact-run-activity"
      label={visibleLabel || t.assistant.thread.loadingResponse}
    >
      <span aria-hidden="true" className="flex items-center gap-[3px] px-0.5">
        <span className="size-[3px] animate-pulse rounded-full bg-current" />
        <span className="size-[3px] animate-pulse rounded-full bg-current [animation-delay:160ms]" />
        <span className="size-[3px] animate-pulse rounded-full bg-current [animation-delay:320ms]" />
      </span>
      {visibleLabel && <HintText key={visibleLabel}>{visibleLabel}</HintText>}
      {elapsed >= PRODUCT_ACTIVITY_TIMER_REVEAL_S && <ActivityTimerText seconds={elapsed} />}
    </StatusRow>
  )
}

// Parked-background affordance: a top-level delegate_task runs in the
// background, so the parent turn ends and the app goes idle while the subagent
// keeps working and its result re-enters as a fresh turn later. Instead of a
// spinner (reads as "stuck"), reuse the same compact, centered system-note
// chrome as the steer / slash-status lines (SystemMessage above) so it sits in
// the thread like every other meta line. Idle-only (gated upstream). Null when
// nothing is parked.
export const BackgroundResumeNotice: FC = () => {
  const { t } = useI18n()
  const resume = useStore($backgroundResume)

  if (!resume) {
    return null
  }

  const label = resume.activity ?? t.assistant.thread.resumeWhenBackgroundDone(resume.count)

  return (
    <div
      aria-live="polite"
      className="flex max-w-[min(86%,44rem)] items-center gap-1.5 self-center px-2 py-0.5 text-[0.6875rem] leading-5 text-muted-foreground/55"
      data-slot="aui_background-resume"
      role="status"
    >
      <Codicon className="text-muted-foreground/55" name="sync" size="0.75rem" />
      <span className="shimmer min-w-0 truncate">{label}</span>
    </div>
  )
}

// Seconds of no visible output (text or part count) before a still-running turn
// is treated as stalled and the thinking indicator returns at the tail.
const STREAM_STALL_S = 2

// Tail "still thinking" indicator: the pre-first-token spinner goes away once
// text flows, but if the stream then goes quiet mid-turn (tool think-time,
// provider stall) nothing signals that work continues. Watch a per-flush
// activity signal; when it hasn't changed for STREAM_STALL_S, re-show the
// dither + a timer counting from the last activity.
//
// Subscribes to the activity signal ITSELF (rather than taking it as a prop)
// so that per-token updates re-render only this leaf, not the whole
// AssistantMessage subtree.
export const StreamStallIndicator: FC = () => {
  const activity = useAuiState(s => {
    let textLength = 0

    for (const part of s.message.content) {
      const text = (part as { text?: unknown }).text

      if (typeof text === 'string') {
        textLength += text.length
      }
    }

    return `${s.message.content.length}:${textLength}`
  })

  // Timestamp of the activity that preceded the current quiet spell, set once
  // the spell qualifies as a stall. Holding the timestamp (not a boolean) is
  // what lets the timer read "quiet for 12s" rather than the age of this
  // component, which is the whole turn so far.
  const [quietSince, setQuietSince] = useState<number | undefined>(undefined)
  const { awaitingInput, compacting, drafting, turnTimerKey } = useThreadSessionStatus()
  const hint = useStatusHint(compacting, drafting)

  // A tool run at the tail already narrates the wait — its summary counts the
  // calls, its ticker names the current one, and it carries its own timer. A
  // second spinner under that adds a line and says nothing new.
  const toolNarrating = useAuiState(s => s.message.content.at(-1)?.type === 'tool-call')

  useEffect(() => {
    setQuietSince(undefined)
    const seenAt = Date.now()
    const id = window.setTimeout(() => setQuietSince(seenAt), STREAM_STALL_S * 1000)

    return () => window.clearTimeout(id)
  }, [activity])

  // A named wait doesn't have to earn the stall threshold first — we already
  // know what the turn is doing, so say it as soon as the label is ready rather
  // than leaving the transcript silent for STREAM_STALL_S.
  const active = (quietSince !== undefined || Boolean(hint)) && !awaitingInput && !toolNarrating

  // Compaction owns the whole turn, so it keeps counting from the turn's start;
  // anything else counts from the moment the stream went quiet — the stall's own
  // mark, or the draft's, whichever named the wait first.
  const elapsed = useElapsedSeconds(
    active,
    compacting ? turnTimerKey : undefined,
    compacting ? undefined : (quietSince ?? drafting?.since)
  )

  if (!active) {
    return null
  }

  return (
    <StatusRow data-slot="aui_stream-stall" label={hint || 'Hermes is thinking'}>
      <StatusPulse
        aria-hidden="true"
        className="dither inline-block size-3 rounded-[2px] text-midground/80"
        kind="opacity"
      />
      {hint && <HintText>{hint}</HintText>}
      <ActivityTimerText seconds={elapsed} />
    </StatusRow>
  )
}
