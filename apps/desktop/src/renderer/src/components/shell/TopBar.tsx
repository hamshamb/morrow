import { useState } from 'react'
import { ConfirmAction } from '../ConfirmAction'

export type ShellNav = 'chat' | 'code' | 'terminal' | 'git'
/** Pages the main area can show; `/terminal` is not one - it toggles the bottom panel. */
export type ShellPage = Exclude<ShellNav, 'terminal'>

interface Props {
  workspaceName: string
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  onNewSession: () => void
  /** The page currently shown. */
  nav: ShellPage
  onNavigate: (nav: ShellNav) => void
  /** The bottom panel (terminal / output) is open. */
  terminalOpen: boolean
  /** Unsaved editor files - shown as a dot after /code. */
  dirtyCount: number
}

const NAV: ShellNav[] = ['chat', 'code', 'terminal', 'git']

/**
 * Top bar: workspace name, slash-prefixed view nav (nochan style), and the
 * one primary action. The chat, code and repository-changes entries are pages;
 * /terminal toggles the bottom panel (it is lit while the panel is open)
 * instead of being a page. A heavy 2px ink rule sits under the bar (see
 * `.topbar` in global.css).
 */
export function TopBar({ workspaceName, onRename, onDelete, onNewSession, nav, onNavigate, terminalOpen, dirtyCount }: Props) {
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
        {NAV.map((item) => {
          const active = item === 'terminal' ? terminalOpen : nav === item
          return (
            <button
              key={item}
              type="button"
              className={`topbar__nav-item${active ? ' is-active' : ''}`}
              aria-current={item !== 'terminal' && active ? 'page' : undefined}
              aria-pressed={item === 'terminal' ? terminalOpen : undefined}
              title={item === 'terminal' ? 'toggle the terminal panel (Ctrl+`)' : undefined}
              onClick={() => onNavigate(item)}
            >
              /{item}
              {item === 'code' && dirtyCount > 0 && (
                <span className="topbar__dirty" title={`${dirtyCount} unsaved ${dirtyCount === 1 ? 'file' : 'files'}`}>
                  {' '}
                  •
                </span>
              )}
            </button>
          )
        })}
      </nav>

      <div className="topbar__actions">
        <button type="button" className="topbar__primary" onClick={onNewSession}>
          + new session <kbd>c</kbd>
        </button>
      </div>
    </header>
  )
}
