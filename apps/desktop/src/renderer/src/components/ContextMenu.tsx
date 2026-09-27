import { useEffect, useRef } from 'react'

export interface ContextMenuItem {
  label: string
  onSelect: () => void
  danger?: boolean
  icon?: React.ReactNode
}

interface Props {
  items: ContextMenuItem[]
  onClose: () => void
}

/** A tiny anchored popover menu (rename/delete on a session row, etc.) —
 * closes on outside click or Escape. Purely presentational/original; not
 * derived from any external source. */
export function ContextMenu({ items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  return (
    <div className="context-menu" ref={ref} role="menu">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu__item${item.danger ? ' is-danger' : ''}`}
          onClick={() => {
            item.onSelect()
            onClose()
          }}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
