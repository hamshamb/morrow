import { useState } from 'react'
import { ChatIcon, CodeIcon, FolderIcon, GitBranchIcon, TerminalIcon, TrashIcon } from '../icons'

export type ShellNav = 'chat' | 'code' | 'terminal' | 'git'

interface Props {
  workspaceName: string
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  filesRootLabel: string | null
  onOpenFiles: () => void
  nav: ShellNav
}

const COMING_SOON = 'Coming soon — not built yet'

/**
 * Minimal top bar: workspace name (double-click to rename) + a small nav
 * strip. Only "Chat" is a real, working view — Code/Terminal/Git are
 * rendered as visually present but disabled placeholders (never fake
 * working tabs) because their backends don't exist yet (roadmap Phase 4/5).
 * See docs/DECISIONS.md ADR-018.
 */
export function TopBar({ workspaceName, onRename, onDelete, filesRootLabel, onOpenFiles, nav }: Props) {
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
            className="topbar__title-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commit()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <h1
            className="topbar__title"
            onDoubleClick={() => {
              setDraft(workspaceName)
              setEditing(true)
            }}
            title="Double-click to rename"
          >
            {workspaceName}
          </h1>
        )}
        <button
          type="button"
          className="topbar__icon-btn"
          onClick={() => void onDelete()}
          title="Delete workspace"
          aria-label="Delete workspace"
        >
          <TrashIcon />
        </button>
      </div>

      <nav className="topbar__nav" aria-label="Workspace views">
        <button type="button" className={`topbar__nav-btn${nav === 'chat' ? ' is-active' : ''}`}>
          <ChatIcon />
          Chat
        </button>
        <button type="button" className="topbar__nav-btn" disabled title={COMING_SOON}>
          <CodeIcon />
          Code
        </button>
        <button type="button" className="topbar__nav-btn" disabled title={COMING_SOON}>
          <TerminalIcon />
          Terminal
        </button>
        <button type="button" className="topbar__nav-btn" disabled title={COMING_SOON}>
          <GitBranchIcon />
          Git
        </button>
      </nav>

      <div className="topbar__actions">
        <button type="button" className="topbar__files-btn" onClick={onOpenFiles}>
          <FolderIcon />
          {filesRootLabel ?? 'Choose folder'}
        </button>
      </div>
    </header>
  )
}
