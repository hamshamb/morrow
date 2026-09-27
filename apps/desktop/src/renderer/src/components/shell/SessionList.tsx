import { useState } from 'react'
import type { Conversation } from '@ai-workspace/shared'
import { ContextMenu } from '../ContextMenu'
import { DotIcon, MoreIcon, PencilIcon, PlusIcon, TrashIcon } from '../icons'

interface Props {
  conversations: Conversation[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: () => Promise<Conversation | void>
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

/**
 * Collapsible session (conversation) list panel that sits next to the
 * workspace rail — see docs/UI_REFERENCE_OPENCODE.md §2/§3. Each row is a
 * single compact line (status dot + title); rename/delete live behind a
 * hover-revealed "more" menu rather than a permanently visible delete
 * button, and the active row gets a plain background highlight instead of
 * an accent-colored pill.
 */
export function SessionList({ conversations, activeId, onSelect, onCreate, onRename, onDelete }: Props) {
  const [menuForId, setMenuForId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [draftTitle, setDraftTitle] = useState('')

  function startRename(conversation: Conversation) {
    setRenamingId(conversation.id)
    setDraftTitle(conversation.title)
    setMenuForId(null)
  }

  async function commitRename(id: string) {
    const trimmed = draftTitle.trim()
    setRenamingId(null)
    if (trimmed) await onRename(id, trimmed)
  }

  return (
    <div className="session-list">
      <div className="session-list__header">
        <span className="session-list__title">Sessions</span>
        <button
          type="button"
          className="session-list__new-btn"
          onClick={() => void onCreate()}
          aria-label="New conversation"
          title="New conversation"
        >
          <PlusIcon />
        </button>
      </div>

      <nav className="session-list__items">
        {conversations.length === 0 && <p className="session-list__empty">No conversations yet.</p>}
        {conversations.map((conversation) => (
          <div
            key={conversation.id}
            className={`session-row${conversation.id === activeId ? ' is-active' : ''}`}
          >
            <button
              type="button"
              className="session-row__main"
              onClick={() => onSelect(conversation.id)}
            >
              <span className="session-row__dot">
                <DotIcon />
              </span>
              {renamingId === conversation.id ? (
                <input
                  autoFocus
                  className="session-row__rename-input"
                  value={draftTitle}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setDraftTitle(e.target.value)}
                  onBlur={() => void commitRename(conversation.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void commitRename(conversation.id)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
              ) : (
                <span className="session-row__label">{conversation.title}</span>
              )}
            </button>
            <button
              type="button"
              className="session-row__more"
              aria-label="Conversation actions"
              onClick={(e) => {
                e.stopPropagation()
                setMenuForId((current) => (current === conversation.id ? null : conversation.id))
              }}
            >
              <MoreIcon />
            </button>
            {menuForId === conversation.id && (
              <ContextMenu
                onClose={() => setMenuForId(null)}
                items={[
                  {
                    label: 'Rename',
                    icon: <PencilIcon />,
                    onSelect: () => startRename(conversation),
                  },
                  {
                    label: 'Delete',
                    icon: <TrashIcon />,
                    danger: true,
                    onSelect: () => void onDelete(conversation.id),
                  },
                ]}
              />
            )}
          </div>
        ))}
      </nav>
    </div>
  )
}
