import { useState } from 'react'
import { ConfirmAction } from '../ConfirmAction'

export type ShellNav = 'chat' | 'code' | 'terminal' | 'git'

interface Props {
  workspaceName: string
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  onNewSession: () => void
  nav: ShellNav
}

const COMING_SOON = 'coming soon — not built yet'
const NAV: { id: ShellNav; enabled: boolean }[] = [
  { id: 'chat', enabled: true },
  { id: 'code', enabled: false },
  { id: 'terminal', enabled: false },
  { id: 'git', enabled: false },
]

/**
 * Top bar: workspace name, slash-prefixed view nav (nochan style), and the
 * one primary action. Only /chat is a working view — /code, /terminal and
 * /git are visibly present but disabled (their backends don't exist yet,
 * roadmap Phase 4/5), never fake working tabs. A heavy 2px ink rule sits
 * under the bar (see `.topbar` in global.css).
 */
export function TopBar({ workspaceName, onRename, onDelete, onNewSession, nav }: Props) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  async function commit() {
    const trimmed = draft.trim()
    setEditing(false)
    if (trimmed && trimmed !== workspaceName) await onRename(trimmed)
  }

  return (
    <header className="topbar">
      <div className="topbar__identity">
        {editing ? (
          <input
            autoFocus
            className="input topbar__title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit()
              if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(false)
              }
            }}
          />
        ) : (
          <h1
            className="topbar__title"
            onDoubleClick={() => {
              setDraft(workspaceName)
              setEditing(true)
            }}
            title="double-click to rename"
          >
            {workspaceName}
          </h1>
        )}
        <ConfirmAction
          className="topbar__delete"
          label="[delete]"
          confirmLabel="[confirm delete workspace]"
          title="Delete this workspace"
          onConfirm={() => void onDelete()}
        />
      </div>

      <nav className="topbar__nav" aria-label="Workspace views">
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`topbar__nav-item${nav === item.id ? ' is-active' : ''}`}
            disabled={!item.enabled}
            title={item.enabled ? undefined : COMING_SOON}
            aria-current={nav === item.id ? 'page' : undefined}
          >
            /{item.id}
          </button>
        ))}
      </nav>

      <div className="topbar__actions">
        <button type="button" className="topbar__primary" onClick={onNewSession}>
          + new session <kbd>c</kbd>
        </button>
      </div>
    </header>
  )
}
