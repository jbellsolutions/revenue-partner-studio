export const KEYBIND_BEFORE_RUN_EVENT = 'hermes:keybind-before-run'

export interface KeybindBeforeRunDetail {
  actionId: string
  combo: string
}

/** Give contextual surfaces one synchronous chance to claim a keybind before
 *  its handler mutates app state. Returning false means the action was
 *  claimed; callers should prevent the original keyboard event and stop. */
export function keybindActionAllowed(actionId: string, combo: string): boolean {
  if (typeof window === 'undefined') {
    return true
  }

  return window.dispatchEvent(
    new CustomEvent<KeybindBeforeRunDetail>(KEYBIND_BEFORE_RUN_EVENT, {
      cancelable: true,
      detail: { actionId, combo }
    })
  )
}
