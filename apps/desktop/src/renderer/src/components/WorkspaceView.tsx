import { forwardRef, useImperativeHandle, useState } from 'react'
import type {
  LastModelSelection,
  ModelRef,
  ProviderConfigSummary,
  Workspace,
} from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { TopBar } from './shell/TopBar'
import { SessionList } from './shell/SessionList'
import { ResizeHandle } from './shell/ResizeHandle'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { useConversations } from '../hooks/useConversations'
import { useModelCatalogs } from '../hooks/useModelCatalogs'
import { useResizablePanel } from '../hooks/useResizablePanel'
import { findDisplayName, shortModelName } from '../lib/model-label'
import { focusComposer } from '../lib/focus'
import type { WorkspaceCommandActions } from './CommandPalette'

interface Props {
  workspace: Workspace | null
  providerConfigs: ProviderConfigSummary[]
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  /** `undefined` means settings haven't loaded yet — see ChatPanel. */
  lastModelSelection: LastModelSelection | null | undefined
  onModelUsed: (selection: LastModelSelection, setAsDefault: boolean) => void
  favorites: ModelRef[]
  recents: LastModelSelection[]
  onToggleFavorite: (ref: ModelRef) => void
  onOpenKeyboard: () => void
  onOpenSettings: () => void
  version: string | null
}

/** Imperative handle for App-level keyboard shortcuts and the command
 * palette, which sit above the per-workspace state owned here. */
export interface WorkspaceViewHandle {
  getCommandActions: () => WorkspaceCommandActions | null
  newSession: () => void
  openModelPicker: () => void
  /** Esc: close the context panel if it's open. Returns true if it closed something. */
  dismissPanels: () => boolean
}

export const WorkspaceView = forwardRef<WorkspaceViewHandle, Props>(function WorkspaceView(
  {
    workspace,
    providerConfigs,
    onRename,
    onDelete,
    lastModelSelection,
    onModelUsed,
    favorites,
    recents,
    onToggleFavorite,
    onOpenKeyboard,
    onOpenSettings,
    version,
  },
  ref,
) {
  const [filesOpen, setFilesOpen] = useState(false)
  // Single owners (see BUILD_STATE.md re: commit 28eb009) — each passed down
  // rather than re-fetched by a child.
  const workspaceFiles = useWorkspaceFiles(workspace?.id ?? null)
  const conversations = useConversations(workspace?.id ?? null)
  const modelCatalogs = useModelCatalogs(providerConfigs)

  const [sessionListCollapsed, setSessionListCollapsed] = useState(false)
  const sessionPanel = useResizablePanel({
    direction: 'horizontal',
    initialSize: 248,
    min: 200,
    max: 420,
    collapseThreshold: 140,
    onCollapse: () => setSessionListCollapsed(true),
  })

  const [contextOpen, setContextOpen] = useState(false)
  const [modelPickerSignal, setModelPickerSignal] = useState(0)
  const [addToContextSignal, setAddToContextSignal] = useState<{ id: number; path: string } | null>(null)
  const [selectModelSignal, setSelectModelSignal] = useState<{ id: number; ref: ModelRef } | null>(null)

  function newSession() {
    if (!workspace) return
    void conversations.create().then(() => focusComposer())
  }

  useImperativeHandle(
    ref,
    () => ({
      getCommandActions: () => {
        if (!workspace) return null
        return {
          newConversation: newSession,
          openModelPicker: () => setModelPickerSignal((s) => s + 1),
          openContextPanel: () => setContextOpen(true),
          openFilesPanel: () => setFilesOpen(true),
          addFileToContext: (path: string) => setAddToContextSignal((prev) => ({ id: (prev?.id ?? 0) + 1, path })),
          useModel: (modelRef: ModelRef) =>
            setSelectModelSignal((prev) => ({ id: (prev?.id ?? 0) + 1, ref: modelRef })),
          indexedFiles: workspaceFiles.files,
          favorites: favorites.flatMap((fav) => {
            const config = providerConfigs.find((c) => c.id === fav.providerConfigId)
            if (!config) return []
            return [
              {
                ref: fav,
                provider: config.provider,
                name: shortModelName(fav.model, findDisplayName(modelCatalogs.catalogs, fav.model)),
              },
            ]
          }),
        }
      },
      newSession,
      openModelPicker: () => setModelPickerSignal((s) => s + 1),
      dismissPanels: () => {
        if (contextOpen) {
          setContextOpen(false)
          focusComposer()
          return true
        }
        return false
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newSession closes over workspace/conversations, both listed
    [workspace, conversations, workspaceFiles.files, favorites, providerConfigs, modelCatalogs.catalogs, contextOpen],
  )

  if (!workspace) {
    return (
      <div className="workspace-view">
        <div className="empty-state workspace-view__empty">
          <p className="empty-state__title">No workspace yet</p>
          <p className="empty-state__hint">Create one with the + tile in the rail on the left.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="workspace-view">
      <TopBar
        workspaceName={workspace.name}
        onRename={(name) => onRename(workspace.id, name)}
        onDelete={() => onDelete(workspace.id)}
        onNewSession={newSession}
        nav="chat"
      />

      {filesOpen && <WorkspaceFilesPanel workspaceFiles={workspaceFiles} onClose={() => setFilesOpen(false)} />}

      <div className="workspace-view__body">
        {!sessionListCollapsed && (
          <>
            <div className="workspace-view__sessions" style={{ width: sessionPanel.size }}>
              <SessionList
                conversations={conversations.conversations}
                activeId={conversations.activeId}
                loading={conversations.loading}
                onSelect={conversations.setActiveId}
                onRename={conversations.rename}
                onDelete={conversations.remove}
                onOpenKeyboard={onOpenKeyboard}
                onOpenSettings={onOpenSettings}
                version={version}
              />
            </div>
            <ResizeHandle onMouseDown={sessionPanel.onMouseDown} dragging={sessionPanel.dragging} ariaLabel="Resize session list" />
          </>
        )}

        <button
          type="button"
          className={`workspace-view__sessions-toggle${sessionListCollapsed ? ' is-collapsed' : ''}`}
          onClick={() => setSessionListCollapsed((v) => !v)}
          title={sessionListCollapsed ? 'show sessions' : 'hide sessions'}
          aria-label={sessionListCollapsed ? 'Show sessions' : 'Hide sessions'}
        >
          {sessionListCollapsed ? '›' : '‹'}
        </button>

        <ChatPanel
          key={workspace.id}
          workspaceId={workspace.id}
          providerConfigs={providerConfigs}
          workspaceFiles={workspaceFiles}
          conversations={conversations}
          modelCatalogs={modelCatalogs}
          lastModelSelection={lastModelSelection}
          onModelUsed={onModelUsed}
          favorites={favorites}
          recents={recents}
          onToggleFavorite={onToggleFavorite}
          contextOpen={contextOpen}
          onContextOpenChange={setContextOpen}
          modelPickerSignal={modelPickerSignal}
          addToContextSignal={addToContextSignal}
          selectModelSignal={selectModelSignal}
        />
      </div>
    </div>
  )
})
