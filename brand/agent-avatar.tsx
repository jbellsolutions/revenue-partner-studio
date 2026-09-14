import type { CSSProperties } from 'react'
const roles: [RegExp, string][] = [
  [/founder|head|operations/i, '✦'],
  [/market|growth|launch/i, '↗'],
  [/content|writer|editor/i, '✎'],
  [/revenue|sales/i, '$'],
  [/code|developer|engineer/i, '⌘'],
  [/email/i, '✉']
]
/** Presentation only. No runtime identity, account data, or service imports. */
export function AgentAvatar({
  name,
  identity = name,
  head = false,
  small = false,
  working = false
}: {
  name: string
  identity?: string
  head?: boolean
  small?: boolean
  working?: boolean
}) {
  const hue = Array.from(identity).reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 0)
  const badge = head ? '✦' : roles.find(([pattern]) => pattern.test(name))?.[1]
  return (
    <span
      className={'bot-avatar' + (small ? ' compact' : '') + (working ? ' is-working' : '')}
      style={{ '--bot-hue': hue } as CSSProperties}
      aria-hidden="true"
    >
      <span className="bot-antenna" />
      <span className="bot-face">
        <i />
        <i />
      </span>
      {badge && <span className="bot-role">{badge}</span>}
    </span>
  )
}
