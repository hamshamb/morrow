import { useState } from 'react'
import type { LastModelSelection, ProviderConfigSummary, Workspace } from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'

interface Props {
  workspace: Workspace | null
  providerConfigs: ProviderConfigSummary[]
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** `undefined` means settings haven't loaded yet — see the matching prop
   * doc on `ChatPanel`. */
  lastModelSelection: LastModelSelection | null | undefined
  onLastModelSelectionChange: (selection: LastModelSelection) => void
}

export function WorkspaceView({
  workspace,
  providerConfigs,
  onRename,
  onDelete,
  lastModelSelection,
  onLastModelSelectionChange,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [filesOpen, setFilesOpen] = useState(false)
  // Single owner of workspace-file state for this workspace — passed down to
  // both the Files panel and ChatPanel's context picker so neither holds its
  // own unsynced copy (see BUILD_STATE.md re: commit 28eb009).
  const workspaceFiles = useWorkspaceFiles(workspace?.id ?? null)

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
        <button type="button" className="workspace-view__files-btn" onClick={() => setFilesOpen(true)}>
          Files{workspaceFiles.root ? '' : ' (none)'}
        </button>
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

      {filesOpen && (
        <WorkspaceFilesPanel workspaceFiles={workspaceFiles} onClose={() => setFilesOpen(false)} />
      )}

      <ChatPanel
        key={workspace.id}
        workspaceId={workspace.id}
        providerConfigs={providerConfigs}
        workspaceFiles={workspaceFiles}
        lastModelSelection={lastModelSelection}
        onLastModelSelectionChange={onLastModelSelectionChange}
      />
    </div>
  )
}
