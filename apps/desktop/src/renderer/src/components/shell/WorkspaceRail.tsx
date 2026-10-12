import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@ai-workspace/shared'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<void>
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

/**
 * Icon-only workspace switcher rail — OpenCode's "project rail" layout
 * (docs/UI_REFERENCE_OPENCODE.md §2); our concept is still "Workspace".
 * Square monogram tiles; the active one is inverted (ink on paper →
 * paper on ink), nochan's emphasis treatment.
 */
export function WorkspaceRail({ workspaces, activeId, onSelect, onCreate }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const popoverRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!creating) return
    function onDocClick(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setCreating(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [creating])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      await onCreate(trimmed)
      setName('')
      setCreating(false)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="rail">
      <nav className="rail__list" aria-label="Workspaces">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            type="button"
            className={`rail__tile${ws.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(ws.id)}
            title={ws.name}
            aria-current={ws.id === activeId}
          >
            {initials(ws.name)}
          </button>
        ))}
        <div className="rail__create">
          <button
            type="button"
            className="rail__tile rail__tile--ghost"
            onClick={() => setCreating((v) => !v)}
            title="New workspace"
            aria-label="New workspace"
            aria-expanded={creating}
          >
            +
          </button>
          {creating && (
            <form ref={popoverRef} className="popover rail__popover" onSubmit={handleSubmit}>
              <div className="label">new workspace</div>
              <input
                autoFocus
                className="input"
                placeholder="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setCreating(false)
                  }
                }}
              />
              <div className="rail__popover-actions">
                <button type="submit" className="btn btn--primary" disabled={!name.trim() || submitting}>
                  create
                </button>
                <button type="button" className="link-action" onClick={() => setCreating(false)}>
                  [cancel]
                </button>
              </div>
            </form>
          )}
        </div>
      </nav>
    </div>
  )
}
