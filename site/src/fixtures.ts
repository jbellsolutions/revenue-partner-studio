// All data is invented for the public example. Never import production state.
export const computers = [
  {
    id: 'sample-founder',
    name: 'AI Co-founder',
    initials: 'CF',
    color: 'blue',
    role: 'Turn a goal into a coordinated plan.',
    skills: ['Planning', 'Delegation', 'Decision notes'],
    memory: 'Prefers a short daily brief. Requests approval before sharing work across computers.',
    task: 'Plan our next product launch.',
    reply: 'I’ll map the launch, ask Go-to-market for positioning, and bring the pieces back here for review.',
    file: 'launch-plan.md',
    lines: [
      '# A launch worth talking about',
      'Audience: small teams building with AI',
      'Promise: one calm workspace for real work',
      'Next: positioning → content → outreach'
    ]
  },
  {
    id: 'sample-gtm',
    name: 'Go-to-market',
    initials: 'GT',
    color: 'green',
    role: 'Find the audience and sharpen the offer.',
    skills: ['Market research', 'Positioning', 'Launch planning'],
    memory: 'Focuses on small service businesses. Keeps research separate from assumptions.',
    task: 'Help us explain who this is for.',
    reply:
      'Start with founders and small teams who want persistent AI help on computers they control. Lead with a concrete workflow, then show it in the demo.',
    file: 'positioning.md',
    lines: [
      '# Who we help',
      'Small teams, with a lot to get done',
      'An operator that remembers the work',
      'A workspace you can step into'
    ]
  },
  {
    id: 'sample-content',
    name: 'Content Marketer',
    initials: 'CM',
    color: 'peach',
    role: 'Make useful content from a clear idea.',
    skills: ['Writing', 'Editorial planning', 'Repurposing'],
    memory: 'Uses plain language. Drafts stay private until the owner approves publication.',
    task: 'Draft three ideas for the launch.',
    reply:
      '1. A day with your AI co-founder.\n2. From one brief to four focused specialists.\n3. How to take over when a task needs your touch.',
    file: 'editorial-plan.md',
    lines: [
      '# Editorial plan',
      'Monday · Meet your AI co-founder',
      'Wednesday · Four agents, one launch',
      'Friday · The human stays in control'
    ]
  },
  {
    id: 'sample-revenue',
    name: 'Revenue Partner',
    initials: 'RP',
    color: 'violet',
    role: 'Keep follow-through connected to revenue.',
    skills: ['Pipeline review', 'Follow-up drafts', 'Revenue planning'],
    memory: 'Never sends outreach without approval. Tracks next actions and their owners.',
    task: 'What should we follow up on first?',
    reply:
      'Start with the people who already asked for a demo. I’ll prepare the next steps for review before anything is sent.',
    file: 'next-actions.md',
    lines: [
      '# Next actions',
      'Review demo requests',
      'Draft helpful follow-ups',
      'Ask for approval before sending',
      'Record the outcome'
    ]
  }
] as const
export type DemoState = {
  selected: number
  tab: 'chat' | 'profile' | 'skills'
  delegated: boolean
  approved: boolean
  takeover: boolean
  expanded: boolean
}
export const initialState: DemoState = {
  selected: 0,
  tab: 'chat',
  delegated: false,
  approved: false,
  takeover: false,
  expanded: false
}
export function transition(state: DemoState, action: string, value?: number): DemoState {
  if (action === 'reset') return { ...initialState }
  if (action === 'select' && value !== undefined && value >= 0 && value < computers.length)
    return { ...state, selected: value, tab: 'chat', takeover: false, expanded: false }
  if (action === 'delegate') return { ...state, delegated: true }
  if (action === 'approve' && state.delegated) return { ...state, approved: true }
  if (action === 'takeover') return { ...state, takeover: !state.takeover }
  return state
}
