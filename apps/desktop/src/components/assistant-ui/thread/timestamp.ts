import { fmtClock, fmtDayTime } from '@/lib/time'

export const MESSAGE_TIMESTAMP_GAP_MS = 15 * 60 * 1000

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** iMessage-style separators appear at the start of a transcript, on a new
 *  calendar day, or after a meaningful pause—not above every bubble. */
export function shouldShowMessageTimestamp(currentMs: number, previousMs?: number): boolean {
  if (!Number.isFinite(currentMs) || currentMs <= 0) {
    return false
  }

  if (!Number.isFinite(previousMs) || !previousMs || previousMs <= 0) {
    return true
  }

  return (
    startOfDay(new Date(currentMs)) !== startOfDay(new Date(previousMs)) ||
    currentMs - previousMs >= MESSAGE_TIMESTAMP_GAP_MS
  )
}

export function formatMessageTimestamp(
  value: Date | string | number | undefined,
  labels: { today: (time: string) => string; yesterday: (time: string) => string }
): string {
  if (!value) {
    return ''
  }

  const date = value instanceof Date ? value : new Date(value)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const dayDelta = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)

  if (dayDelta === 0) {
    return labels.today(fmtClock.format(date))
  }

  if (dayDelta === 1) {
    return labels.yesterday(fmtClock.format(date))
  }

  return fmtDayTime.format(date)
}
