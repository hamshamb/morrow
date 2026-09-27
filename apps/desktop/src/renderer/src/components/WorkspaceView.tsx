import type { LastModelSelection, ProviderConfigSummary, Workspace } from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { TopBar } from './shell/TopBar'
import { SessionList } from './shell/SessionList'
import { ResizeHandle } from './shell/ResizeHandle'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { useConversations } from '../hooks/useConversations'
import { useResizablePanel } from '../hooks/useResizablePanel'
import { useState } from 'react'

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
  const [filesOpen, setFilesOpen] = useState(false)
  // Single owner of workspace-file state for this workspace — passed down to
  // both the Files panel and ChatPanel's context picker so neither holds its
  // own unsynced copy (see BUILD_STATE.md re: commit 28eb009).
  const workspaceFiles = useWorkspaceFiles(workspace?.id ?? null)
  // Single owner of the conversation list for this workspace — the session
  // list panel and ChatPanel's message thread both read/act on this same
  // state (same single-owner precedent as workspaceFiles above).
  const conversations = useConversations(workspace?.id ?? null)
  const [sessionListCollapsed, setSessionListCollapsed] = useState(false)
  const sessionPanel = useResizablePanel({
    direction: 'horizontal',
    initialSize: 240,
    min: 180,
    max: 420,
    collapseThreshold: 120,
    onCollapse: () => setSessionListCollapsed(true),
  })

  if (!workspace) {
    return (
      <div className="workspace-view workspace-view--empty">
        <p>Select or create a workspace, or press + on the rail to create one.</p>
      </div>
    )
  }

  return (
    <div className="workspace-view">
      <TopBar
        workspaceName={workspace.name}
        onRename={(name) => onRename(workspace.id, name)}
        onDelete={() => onDelete(workspace.id)}
        filesRootLabel={workspaceFiles.root ? workspaceFiles.root.rootPath.split(/[\\/]/).pop() ?? 'Files' : null}
        onOpenFiles={() => setFilesOpen(true)}
        nav="chat"
      />

      {filesOpen && (
        <WorkspaceFilesPanel workspaceFiles={workspaceFiles} onClose={() => setFilesOpen(false)} />
      )}

      <div className="workspace-view__body">
        {!sessionListCollapsed && (
          <>
            <div className="workspace-view__sessions" style={{ width: sessionPanel.size }}>
              <SessionList
                conversations={conversations.conversations}
                activeId={conversations.activeId}
                onSelect={conversations.setActiveId}
                onCreate={conversations.create}
                onRename={conversations.rename}
                onDelete={conversations.remove}
              />
            </div>
            <ResizeHandle
              onMouseDown={sessionPanel.onMouseDown}
              dragging={sessionPanel.dragging}
              ariaLabel="Resize session list"
            />
          </>
        )}

        <button
          type="button"
          className="workspace-view__sessions-toggle"
          onClick={() => setSessionListCollapsed((v) => !v)}
          title={sessionListCollapsed ? 'Show sessions' : 'Hide sessions'}
        >
          {sessionListCollapsed ? '›' : '‹'}
        </button>

        <ChatPanel
          key={workspace.id}
          workspaceId={workspace.id}
          providerConfigs={providerConfigs}
          workspaceFiles={workspaceFiles}
          conversations={conversations}
          lastModelSelection={lastModelSelection}
          onLastModelSelectionChange={onLastModelSelectionChange}
        />
      </div>
    </div>
  )
}
