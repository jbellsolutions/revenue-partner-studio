import { computeWindowOptions } from './window-state'

/** Recover the old near-display-sized geometry without forcing fullscreen on reopen. */
export function studioRestoredWindowState(state: any, displays: any[]) {
  if (!state) return null
  const oversized = displays.some(({workArea: area}) => area && state.width >= area.width * .95 && state.height >= area.height * .95)
  return oversized || state.isMaximized
    ? {...computeWindowOptions(null, displays), isMaximized: false}
    : {...state, isMaximized: false}
}
