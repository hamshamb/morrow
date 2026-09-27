import { useRef, useState } from 'react'
import type { Workspace } from '@ai-workspace/shared'
import { PlusIcon, SettingsIcon } from '../icons'

interface Props {
  workspaces: Workspace[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<void>
  onOpenSettings: () => void
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase()
}

/**
 * Compact icon-only workspace-switcher rail — OpenCode's "project rail"
 * layout pattern (docs/UI_REFERENCE_OPENCODE.md §2: a fixed-width icon
 * strip of avatars + a "new project" affordance + settings pinned at the
 * bottom). Our product still calls the concept "Workspace", not "project" —
 * only the layout pattern is adopted, not the naming.
 */
export function WorkspaceRail({ workspaces, activeId, onSelect, onCreate, onOpenSettings }: Props) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

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
    <div className="workspace-rail">
      <nav className="workspace-rail__list" aria-label="Workspaces">
        {workspaces.map((ws) => (
          <button
            key={ws.id}
            type="button"
            className={`workspace-rail__item${ws.id === activeId ? ' is-active' : ''}`}
            onClick={() => onSelect(ws.id)}
            title={ws.name}
            aria-current={ws.id === activeId}
          >
            <span className="workspace-rail__avatar">{initials(ws.name)}</span>
          </button>
        ))}
      </nav>

      <div className="workspace-rail__bottom">
        <div className="workspace-rail__create">
          <button
            type="button"
            className="workspace-rail__item workspace-rail__item--ghost"
            onClick={() => setCreating((v) => !v)}
            title="New workspace"
            aria-expanded={creating}
          >
            <PlusIcon />
          </button>
          {creating && (
            <form ref={formRef} className="workspace-rail__popover" onSubmit={handleSubmit}>
              <input
                autoFocus
                placeholder="Workspace name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setCreating(false)
                }}
              />
              <div className="workspace-rail__popover-actions">
                <button type="submit" disabled={!name.trim() || submitting}>
                  Create
                </button>
                <button type="button" onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
        <button
          type="button"
          className="workspace-rail__item"
          onClick={onOpenSettings}
          title="Settings"
        >
          <SettingsIcon />
        </button>
      </div>
    </div>
  )
}
