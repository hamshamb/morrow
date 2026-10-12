import { useEffect } from 'react'

/** Every shortcut wired in App.tsx/ChatPanel — keep in sync. */
export const SHORTCUTS: { keys: string[]; action: string }[] = [
  { keys: ['c'], action: 'new session (when not typing)' },
  { keys: ['Ctrl', 'N'], action: 'new session' },
  { keys: ['Ctrl', 'K'], action: 'command palette' },
  { keys: ['Ctrl', 'Shift', 'P'], action: 'command palette' },
  { keys: ['Ctrl', 'M'], action: 'switch model' },
  { keys: ['Enter'], action: 'send message' },
  { keys: ['Shift', 'Enter'], action: 'new line' },
  { keys: ['Esc'], action: 'close popover / panel, back to the composer' },
  { keys: ['↑', '↓'], action: 'move through lists (palette, model picker)' },
]

interface Props {
  onClose: () => void
}

/** The `[keyboard]` sheet (reachable from the session footer and the
 * command palette) — nochan has the same affordance. */
export function KeyboardSheet({ onClose }: Props) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="overlay" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={onClose}>
      <div className="dialog keyboard-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 className="dialog__title">Keyboard</h2>
          <button type="button" className="link-action" onClick={onClose}>
            [close] <kbd>esc</kbd>
          </button>
        </header>
        <div className="rule-list keyboard-sheet__list">
          {SHORTCUTS.map((s) => (
            <div key={`${s.keys.join('+')}-${s.action}`} className="rule-list__row keyboard-sheet__row">
              <span className="keyboard-sheet__keys">
                {s.keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </span>
              <span>{s.action}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
