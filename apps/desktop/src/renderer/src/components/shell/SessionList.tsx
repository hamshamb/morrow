import { useEffect, useRef, useState } from 'react'
import type { Conversation } from '@ai-workspace/shared'
import { ConfirmAction } from '../ConfirmAction'
import { formatRelativeTime } from '../../lib/time'
import { focusComposer } from '../../lib/focus'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  loading: boolean
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onOpenKeyboard: () => void
  onOpenSettings: () => void
  version: string | null
}

/**
 * Session (conversation) list panel next to the workspace rail. Compact
 * rows (title + muted age); the active row is an inverted ink block
 * (nochan's emphasis treatment) rather than an accent fill. Rename/delete
 * live behind a hover-revealed menu; delete uses an inline confirm.
 */
export function SessionList({
  conversations,
  activeId,
  loading,
  onSelect,
  onRename,
  onDelete,
  onOpenKeyboard,
  onOpenSettings,
  version,
}: Props) {
  const [menuForId, setMenuForId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuForId) return
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuForId(null)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setMenuForId(null)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuForId])

  async function commitRename(id: string) {
    const trimmed = draftTitle.trim()
    setRenamingId(null)
    if (trimmed) await onRename(id, trimmed)
    focusComposer()
  }

  return (
    <div className="session-list">
      <div className="session-list__header">
        <span className="label">sessions</span>
        {conversations.length > 0 && <span className="muted session-list__count">{conversations.length}</span>}
      </div>

      <nav className="session-list__items" aria-label="Sessions">
        {!loading && conversations.length === 0 && (
          // The main area carries the one "[start a session]" action.
          <div className="session-list__empty">
            <p className="muted">No sessions yet.</p>
          </div>
        )}
        {conversations.map((conversation) => {
          const active = conversation.id === activeId
          return (
            <div key={conversation.id} className={`session-row${active ? ' is-active' : ''}`}>
              {renamingId === conversation.id ? (
                <input
                  autoFocus
                  className="input session-row__rename"
                  value={draftTitle}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => void commitRename(conversation.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(conversation.id)
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      setRenamingId(null)
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="session-row__main"
                  onClick={() => {
                    onSelect(conversation.id)
                    focusComposer()
                  }}
                  aria-current={active}
                >
                  <span className="session-row__title">{conversation.title}</span>
                  <span className="session-row__age">{formatRelativeTime(conversation.updatedAt)}</span>
                </button>
              )}
              <button
                type="button"
                className="session-row__more"
                aria-label={`Actions for ${conversation.title}`}
                aria-expanded={menuForId === conversation.id}
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuForId((cur) => (cur === conversation.id ? null : conversation.id))
                }}
              >
                ···
              </button>
              {menuForId === conversation.id && (
                <div className="menu" ref={menuRef} role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="menu__item"
                    onClick={() => {
                      setRenamingId(conversation.id)
                      setDraftTitle(conversation.title)
                      setMenuForId(null)
                    }}
                  >
                    rename
                  </button>
                  <ConfirmAction
                    className="menu__item"
                    label="delete"
                    confirmLabel="confirm delete"
                    onConfirm={() => {
                      setMenuForId(null)
                      void onDelete(conversation.id)
                    }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </nav>

      <footer className="session-list__footer">
        <button type="button" className="link-action" onClick={onOpenKeyboard}>
          [keyboard]
        </button>
        <button type="button" className="link-action" onClick={onOpenSettings}>
          [settings]
        </button>
        {version && <span className="muted">v{version}</span>}
      </footer>
    </div>
  )
}
