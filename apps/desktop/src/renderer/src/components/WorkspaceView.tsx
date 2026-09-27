import { useState } from 'react'
import type { ProviderConfigSummary, Workspace } from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'

interface Props {
  workspace: Workspace | null
  providerConfigs: ProviderConfigSummary[]
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

export function WorkspaceView({ workspace, providerConfigs, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')

  if (!workspace) {
    return (
      <div className="workspace-view workspace-view--empty">
        <p>Select or create a workspace to get started.</p>
      </div>
    )
  }

  async function commitRename() {
    const trimmed = draftName.trim()
    setEditing(false)
    if (trimmed && workspace && trimmed !== workspace.name) {
      await onRename(workspace.id, trimmed)
    }
  }

  return (
    <div className="workspace-view">
      <header className="workspace-view__header">
        {editing ? (
          <input
            autoFocus
            className="workspace-view__title-input"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
          />
        ) : (
          <h1
            className="workspace-view__title"
            onDoubleClick={() => {
              setDraftName(workspace.name)
              setEditing(true)
            }}
          >
            {workspace.name}
          </h1>
        )}
        <button
          type="button"
          className="workspace-view__delete-btn"
          onClick={() => void onDelete(workspace.id)}
        >
          Delete
        </button>
      </header>

      {workspace.description && (
        <p className="workspace-view__description">{workspace.description}</p>
      )}

      <ChatPanel key={workspace.id} workspaceId={workspace.id} providerConfigs={providerConfigs} />
    </div>
  )
}
