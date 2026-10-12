/** DOM id of the composer textarea — the single place focus returns to
 * after any action (send, closing a popover/panel, switching session). */
export const COMPOSER_INPUT_ID = 'composer-input'

export function focusComposer(): void {
  // Next frame: the element may be re-rendering (e.g. session switch).
  requestAnimationFrame(() => {
    const el = document.getElementById(COMPOSER_INPUT_ID)
    if (el instanceof HTMLTextAreaElement && !el.disabled) el.focus()
  })
}

/** True when keyboard input is going into a text field — single-key
 * shortcuts like `c` must not fire while typing. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}
