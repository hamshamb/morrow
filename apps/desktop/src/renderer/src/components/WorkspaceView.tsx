import { forwardRef, useImperativeHandle, useState } from 'react'
import type { LastModelSelection, ProviderConfigSummary, Workspace } from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { TopBar } from './shell/TopBar'
import { SessionList } from './shell/SessionList'
import { ResizeHandle } from './shell/ResizeHandle'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { useConversations } from '../hooks/useConversations'
import { useResizablePanel } from '../hooks/useResizablePanel'
import type { WorkspaceCommandActions } from './CommandPalette'

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

/** Imperative handle exposed to `App` so the command palette (rendered at
 * the App level, above the workspace/session state owned here) can drive
 * real actions — new conversation, open the model picker, open the Context
 * Inspector, add an indexed file to context — without lifting all of that
 * state up to App. `null` fields are provided by `getCommandActions()`
 * returning `null` when there's nothing to act on. */
export interface WorkspaceViewHandle {
  getCommandActions: () => WorkspaceCommandActions | null
}

export const WorkspaceView = forwardRef<WorkspaceViewHandle, Props>(function WorkspaceView(
  { workspace, providerConfigs, onRename, onDelete, lastModelSelection, onLastModelSelectionChange },
  ref,
) {
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

  // Controlled here (rather than inside ChatPanel) so the command palette
  // can drive them via the imperative handle below.
  const [contextOpen, setContextOpen] = useState(false)
  const [modelPickerSignal, setModelPickerSignal] = useState(0)
  const [addToContextSignal, setAddToContextSignal] = useState<{ id: number; path: string } | null>(
    null,
  )

  useImperativeHandle(
    ref,
    () => ({
      getCommandActions: () => {
        if (!workspace) return null
        return {
          newConversation: () => void conversations.create(),
          openModelPicker: () => setModelPickerSignal((s) => s + 1),
          openContextPanel: () => setContextOpen(true),
          addFileToContext: (path: string) =>
            setAddToContextSignal((prev) => ({ id: (prev?.id ?? 0) + 1, path })),
          indexedFiles: workspaceFiles.files,
        }
      },
    }),
    [workspace, conversations, workspaceFiles.files],
  )

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
          className={`workspace-view__sessions-toggle${sessionListCollapsed ? ' is-collapsed' : ''}`}
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
          contextOpen={contextOpen}
          onContextOpenChange={setContextOpen}
          modelPickerSignal={modelPickerSignal}
          addToContextSignal={addToContextSignal}
        />
      </div>
    </div>
  )
})
