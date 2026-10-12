import { useEffect, useRef, useState } from 'react'

export const CONFIRM_WINDOW_MS = 3000

interface Props {
  label: string
  confirmLabel: string
  onConfirm: () => void
  className?: string
  title?: string
}

/**
 * Lightweight destructive-action confirm (no modal): the first click turns
 * the text into `confirmLabel` for 3 seconds; a second click within that
 * window runs `onConfirm`. Blurring or the timeout reverts it.
 */
export function ConfirmAction({ label, confirmLabel, onConfirm, className = '', title }: Props) {
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (armed) {
      if (timer.current) clearTimeout(timer.current)
      setArmed(false)
      onConfirm()
      return
    }
    setArmed(true)
    timer.current = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS)
  }

  return (
    <button
      type="button"
      className={`link-action link-action--danger${armed ? ' is-armed' : ''} ${className}`}
      onClick={handleClick}
      onBlur={() => setArmed(false)}
      title={title}
    >
      {armed ? confirmLabel : label}
    </button>
  )
}
