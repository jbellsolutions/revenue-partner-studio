import { isBotProduct } from './product'
/**
 * Transport markers used by Bot Mode's group-chat coordinator.
 *
 * Hermes sessions are profile-scoped today. Bot Mode therefore keeps the
 * user-facing group as one ordinary session and gives its owning profile a
 * hidden routing envelope: contact the other selected profiles, then return
 * one attributed block per participant. The transcript strips the envelope
 * from the human bubble and expands the attributed blocks into iMessage-like
 * bot bubbles.
 *
 * Keep these markers deliberately long and product-specific. A short token
 * such as `[group]` is too easy for normal user prose or pasted code to hit.
 */
export const BOT_GROUP_CONTEXT_START = '<<<HERMES_DESKTOP_BOT_GROUP_CONTEXT_V1>>>'
export const BOT_GROUP_CONTEXT_END = '<<<END_HERMES_DESKTOP_BOT_GROUP_CONTEXT_V1>>>'
export const BOT_GROUP_REPLY_END = '<<<END_HERMES_DESKTOP_BOT_GROUP_REPLY_V1>>>'

const REPLY_START_RE = /<<<HERMES_DESKTOP_BOT_GROUP_REPLY_V1\s+profile="([^"]{1,64})"(?:\s+name="([^"]{1,128})")?>>>/g

export interface BotGroupReply {
  name: string
  profile: string
  text: string
}

/** Human-readable portion of a group prompt. The routing envelope remains in
 * durable history for the coordinator, but never appears in the chat bubble. */
export function stripBotGroupContext(text: string): string {
  const start = text.indexOf(BOT_GROUP_CONTEXT_START)

  if (start === -1) {
    return text
  }

  const before = text.slice(0, start).trimEnd()

  // A partially streamed/legacy envelope should still stay private. Once the
  // unique start marker appears, everything after it is transport metadata.
  return before
}

/** Parse coordinator output into independently authored bot replies.
 * A trailing block without the end marker is kept as a partial — quitting
 * mid-generation used to drop the whole turn because every start required
 * a matching end. Empty/malformed starts are still skipped. */
export function parseBotGroupReplies(text: string): BotGroupReply[] {
  // Studio authorship comes exclusively from backend records.
  if (isBotProduct()) return []
  const replies: BotGroupReply[] = []
  const starts = Array.from(text.matchAll(REPLY_START_RE))

  for (const match of starts) {
    const bodyStart = (match.index ?? 0) + match[0].length
    const bodyEnd = text.indexOf(BOT_GROUP_REPLY_END, bodyStart)
    const profile = match[1].trim()
    const name = (match[2] || profile).trim()
    const body = (bodyEnd === -1 ? text.slice(bodyStart) : text.slice(bodyStart, bodyEnd)).trim()

    if (profile && body) {
      replies.push({ name, profile, text: body })
    }
  }

  return replies
}

export function botGroupReplyStart(profile: string, name: string): string {
  const safeProfile = profile.replace(/["\n\r]/g, '').slice(0, 64)
  const safeName = name.replace(/["\n\r]/g, '').slice(0, 128)

  return `<<<HERMES_DESKTOP_BOT_GROUP_REPLY_V1 profile="${safeProfile}" name="${safeName}">>>`
}
