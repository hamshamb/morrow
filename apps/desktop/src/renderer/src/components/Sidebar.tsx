import { useState } from 'react'
import type { Workspace } from '@ai-workspace/shared'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<void>
}

export function Sidebar({ workspaces, activeId, onSelect, onCreate }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)

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
    <aside className="sidebar">
      <div className="sidebar__header">
        <span className="sidebar__title">Workspaces</span>
        <button
          type="button"
          className="sidebar__add-btn"
          aria-label="New workspace"
          onClick={() => setCreating((v) => !v)}
        >
          +
        </button>
      </div>

      {creating && (
        <form className="sidebar__create-form" onSubmit={handleSubmit}>
          <input
            autoFocus
            placeholder="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="sidebar__create-actions">
            <button type="submit" disabled={!name.trim() || submitting}>
              Create
            </button>
            <button type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <nav className="sidebar__list">
        {workspaces.length === 0 && !creating && (
          <p className="sidebar__empty">No workspaces yet.</p>
        )}
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            type="button"
            className={`sidebar__item${ws.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(ws.id)}
          >
            {ws.name}
          </button>
        ))}
      </nav>
    </aside>
  )
}
