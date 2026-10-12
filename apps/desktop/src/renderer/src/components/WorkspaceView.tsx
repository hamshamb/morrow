import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type {
  AutoPreference,
  CodeSession,
  ComposerMode,
  LastModelSelection,
  ModelRef,
  PendingAttachment,
  ProviderConfigSummary,
  Workspace,
} from '@ai-workspace/shared'
import { ChatPanel } from './ChatPanel'
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel'
import { TopBar, type ShellNav, type ShellPage } from './shell/TopBar'
import { SessionList } from './shell/SessionList'
import { ResizeHandle } from './shell/ResizeHandle'
import { CodeView } from './code/CodeView'
import { QuickOpen } from './code/QuickOpen'
import { GitView } from './git/GitView'
import { BottomPanel, type BottomTab } from './terminal/BottomPanel'
import { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { useConversations } from '../hooks/useConversations'
import { useModelCatalogs } from '../hooks/useModelCatalogs'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { useResizablePanel } from '../hooks/useResizablePanel'
import { useCodeWorkspace, type EditorApi } from '../hooks/useCodeWorkspace'
import { useGitStatus, type GitState } from '../hooks/useGitStatus'
import { useTerminals } from '../hooks/useTerminals'
import { useOutputLog } from '../hooks/useOutputLog'
import { buildMarkers } from '../lib/code/git-ui'
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
  autoPreference: AutoPreference
  onAutoPreferenceChange: (preference: AutoPreference) => void
  /** Saved editor tabs per workspace; `undefined` until settings have loaded. */
  codeSessions: Record<string, CodeSession> | undefined
  onCodeSessionChange: (workspaceId: string, session: CodeSession) => void
}

/** Imperative handle for App-level keyboard shortcuts and the command
 * palette, which sit above the per-workspace state owned here. */
export interface WorkspaceViewHandle {
  getCommandActions: () => WorkspaceCommandActions | null
  newSession: () => void
  openModelPicker: () => void
  /** Ctrl+Shift+M: open the composer's mode menu. */
  openModeMenu: () => void
  /** Esc: close the context panel if it's open. Returns true if it closed something. */
  dismissPanels: () => boolean
  /** True while the chat page is the one showing (single-key shortcuts only apply there). */
  isChatActive: () => boolean
}

const PANEL_MIN = 120
const PANEL_MAX = 720

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
    autoPreference,
    onAutoPreferenceChange,
    codeSessions,
    onCodeSessionChange,
  },
  ref,
) {
  const [filesOpen, setFilesOpen] = useState(false)
  // Single owners (see BUILD_STATE.md re: commit 28eb009) — each passed down
  // rather than re-fetched by a child.
  const workspaceFiles = useWorkspaceFiles(workspace?.id ?? null)
  const conversations = useConversations(workspace?.id ?? null)
  const { metadataVersion } = useProviderRegistry()
  const modelCatalogs = useModelCatalogs(providerConfigs, metadataVersion)

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
  const [addAttachmentSignal, setAddAttachmentSignal] = useState<{ id: number; attachment: PendingAttachment } | null>(null)
  const [selectModelSignal, setSelectModelSignal] = useState<{ id: number; ref: ModelRef } | null>(null)
  const [modeSignal, setModeSignal] = useState<{ id: number; mode: ComposerMode } | null>(null)
  const [modeMenuSignal, setModeMenuSignal] = useState(0)

  // --- Phase 4: code workspace -------------------------------------------------
  const [page, setPage] = useState<ShellPage>('chat')
  const [codeVisited, setCodeVisited] = useState(false)
  const [gitVisited, setGitVisited] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const [searchSignal, setSearchSignal] = useState(0)
  const [commitSignal, setCommitSignal] = useState(0)
  const [treeRefreshKey, setTreeRefreshKey] = useState(0)
  const [panelMounted, setPanelMounted] = useState(false)
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelTab, setPanelTab] = useState<BottomTab>('terminal')
  const [panelFocus, setPanelFocus] = useState(0)
  const panel = useResizablePanel({ direction: 'vertical', initialSize: 280, min: PANEL_MIN, max: PANEL_MAX, reverse: true })

  const workspaceId = workspace?.id ?? null
  const hasRoot = workspaceFiles.root !== null
  const output = useOutputLog()
  const gitRef = useRef<GitState | null>(null)

  const onFilesChanged = useCallback(() => {
    setTreeRefreshKey((k) => k + 1)
    void gitRef.current?.refresh()
  }, [])
  const editorRef = useRef<EditorApi | null>(null)
  const code = useCodeWorkspace({
    editorRef,
    workspaceId,
    hasRoot,
    restore: codeSessions === undefined || workspaceId === null ? undefined : (codeSessions[workspaceId] ?? null),
    onSessionChange: onCodeSessionChange,
    onFilesChanged,
    log: output.log,
  })
  const refreshFromDisk = code.refreshFromDisk
  const git = useGitStatus({
    workspaceId,
    hasRoot,
    visible: page !== 'chat',
    log: output.log,
    onRepoChanged: useCallback(() => {
      void refreshFromDisk()
      setTreeRefreshKey((k) => k + 1)
    }, [refreshFromDisk]),
  })
  useEffect(() => {
    gitRef.current = git
  })
  const terminals = useTerminals({ workspaceId, hasRoot, log: output.log })
  const gitMarkers = useMemo(() => buildMarkers(git.status), [git.status])
  const dirtyCount = code.dirtyPaths.length

  // Switching workspace starts on the chat page; a workspace without a folder has nothing to show elsewhere.
  useEffect(() => {
    setPage('chat')
    setQuickOpen(false)
  }, [workspaceId])

  // Pick up changes made outside the editor (terminal, git, another tool) when the window regains focus.
  const refreshFromDiskRef = useRef(refreshFromDisk)
  useEffect(() => {
    refreshFromDiskRef.current = refreshFromDisk
  })
  useEffect(() => {
    if (!codeVisited) return
    const onFocus = (): void => {
      void refreshFromDiskRef.current()
      setTreeRefreshKey((k) => k + 1)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [codeVisited])

  // Closing the window with unsaved edits: the main process turns this into a confirm dialog.
  // A layout effect, so the guard is armed in the same commit that shows the dirty marker.
  useLayoutEffect(() => {
    if (dirtyCount === 0) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [dirtyCount])

  const showPage = useCallback((next: ShellPage) => {
    setPage(next)
    if (next === 'code') setCodeVisited(true)
    if (next === 'git') setGitVisited(true)
    if (next === 'chat') focusComposer()
  }, [])

  const openFile = useCallback(
    (path: string, position?: { line: number; column?: number }) => {
      showPage('code')
      code.open(path, position)
    },
    [code, showPage],
  )

  const toggleTerminal = useCallback(() => {
    if (!workspaceId) return
    if (!panelOpen) {
      setPanelMounted(true)
      setPanelOpen(true)
      setPanelTab('terminal')
      setPanelFocus((n) => n + 1)
      // The first Ctrl+` / /terminal is the explicit request that starts a shell.
      if (hasRoot && terminals.terminals.length === 0) void terminals.create()
    } else if (panelTab !== 'terminal') {
      setPanelTab('terminal')
      setPanelFocus((n) => n + 1)
    } else {
      setPanelOpen(false)
    }
  }, [workspaceId, panelOpen, panelTab, hasRoot, terminals])

  const newTerminal = useCallback(() => {
    setPanelMounted(true)
    setPanelOpen(true)
    setPanelTab('terminal')
    setPanelFocus((n) => n + 1)
    if (hasRoot) void terminals.create()
  }, [hasRoot, terminals])

  const navigate = useCallback(
    (nav: ShellNav) => {
      if (nav === 'terminal') toggleTerminal()
      else showPage(nav)
    },
    [showPage, toggleTerminal],
  )

  function newSession() {
    if (!workspace) return
    showPage('chat')
    void conversations.create().then(() => focusComposer())
  }

  // Code shortcuts. Capture phase so Monaco / xterm can't swallow them first.
  const shortcutRefs = useRef({ page, code, toggleTerminal, showPage, hasRoot })
  useEffect(() => {
    shortcutRefs.current = { page, code, toggleTerminal, showPage, hasRoot }
  })
  useEffect(() => {
    if (!workspaceId) return
    function onKeyDown(e: KeyboardEvent): void {
      const { page: current, code: c, toggleTerminal: toggle, showPage: show, hasRoot: rooted } = shortcutRefs.current
      const mod = e.metaKey || e.ctrlKey
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      const target = e.target instanceof Element ? e.target : null
      // Ctrl+K opens the command palette even while Monaco has focus (it would start a chord).
      if (key === 'k' && !e.shiftKey && target?.closest('.monaco-editor')) {
        e.preventDefault()
        e.stopPropagation()
        window.dispatchEvent(new CustomEvent('ai-workspace:toggle-command-palette'))
        return
      }
      // Dialogs (settings, palette, keyboard sheet) own the keyboard while open.
      if (document.querySelector('.overlay:not([data-quick-open])')) return
      if (e.key === '`') {
        e.preventDefault()
        toggle()
      } else if (key === 'p' && !e.shiftKey) {
        if (!rooted) return
        e.preventDefault()
        // Render the overlay (and its autoFocus input) now, so the next keystrokes can't land in the editor.
        flushSync(() => setQuickOpen(true))
      } else if (key === 'f' && e.shiftKey) {
        if (!rooted) return
        e.preventDefault()
        flushSync(() => {
          show('code')
          setSearchSignal((n) => n + 1)
        })
      } else if (key === 's' && !e.shiftKey && current === 'code') {
        e.preventDefault()
        void c.save()
      } else if (key === 'w' && !e.shiftKey) {
        // Never let Ctrl+W close the whole window; in the code view it closes the tab.
        e.preventDefault()
        if (current === 'code' && c.active) c.requestClose(c.active)
      } else if (e.key === 'Tab' && current === 'code') {
        e.preventDefault()
        c.cycle(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [workspaceId])

  useImperativeHandle(
    ref,
    () => ({
      getCommandActions: () => {
        if (!workspace) return null
        return {
          newConversation: newSession,
          openModelPicker: () => setModelPickerSignal((s) => s + 1),
          openMode: (mode: ComposerMode) => setModeSignal((prev) => ({ id: (prev?.id ?? 0) + 1, mode })),
          openContextPanel: () => {
            showPage('chat')
            setContextOpen(true)
          },
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
          hasFolder: hasRoot,
          openFile: () => {
            if (hasRoot) setQuickOpen(true)
            else showPage('code')
          },
          searchInFiles: () => {
            showPage('code')
            setSearchSignal((n) => n + 1)
          },
          showCode: () => showPage('code'),
          toggleTerminal,
          newTerminal,
          showChanges: () => showPage('git'),
          commit: () => {
            showPage('git')
            setCommitSignal((n) => n + 1)
          },
        }
      },
      newSession,
      openModelPicker: () => setModelPickerSignal((s) => s + 1),
      openModeMenu: () => setModeMenuSignal((s) => s + 1),
      dismissPanels: () => {
        if (contextOpen) {
          setContextOpen(false)
          focusComposer()
          return true
        }
        return false
      },
      isChatActive: () => page === 'chat',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- newSession closes over workspace/conversations, both listed
    [workspace, conversations, workspaceFiles.files, favorites, providerConfigs, modelCatalogs.catalogs, contextOpen, page, hasRoot, toggleTerminal, newTerminal, showPage],
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

  const rootPath = workspaceFiles.root?.rootPath ?? null
  const pickFolder = () => void workspaceFiles.pickRoot()

  return (
    <div className="workspace-view">
      <TopBar
        workspaceName={workspace.name}
        onRename={(name) => onRename(workspace.id, name)}
        onDelete={() => onDelete(workspace.id)}
        onNewSession={newSession}
        nav={page}
        onNavigate={navigate}
        terminalOpen={panelOpen}
        dirtyCount={dirtyCount}
      />

      {filesOpen && <WorkspaceFilesPanel workspaceFiles={workspaceFiles} onClose={() => setFilesOpen(false)} />}

      <div className="workspace-view__main">
        <div className="workspace-view__pages">
          <div className="workspace-view__body" hidden={page !== 'chat'}>
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
              addAttachmentSignal={addAttachmentSignal}
              selectModelSignal={selectModelSignal}
              modeSignal={modeSignal}
              modeMenuSignal={modeMenuSignal}
              autoPreference={autoPreference}
              onAutoPreferenceChange={onAutoPreferenceChange}
            />
          </div>

          {codeVisited && (
            <div className="workspace-view__page" hidden={page !== 'code'}>
              <CodeView
                workspaceId={workspace.id}
                rootPath={rootPath}
                indexing={workspaceFiles.indexing}
                onPickFolder={pickFolder}
                code={code}
                editorRef={editorRef}
                gitMarkers={gitMarkers}
                treeRefreshKey={treeRefreshKey}
                onRefreshTree={() => {
                  setTreeRefreshKey((k) => k + 1)
                  void git.refresh()
                  void refreshFromDisk()
                }}
                onQuickOpen={() => setQuickOpen(true)}
                searchSignal={searchSignal}
                onAddAttachment={(attachment) => setAddAttachmentSignal((prev) => ({ id: (prev?.id ?? 0) + 1, attachment }))}
                onAddFilePath={(path) => setAddToContextSignal((prev) => ({ id: (prev?.id ?? 0) + 1, path }))}
              />
            </div>
          )}

          {gitVisited && (
            <div className="workspace-view__page" hidden={page !== 'git'}>
              <GitView
                workspaceId={workspace.id}
                rootPath={rootPath}
                indexing={workspaceFiles.indexing}
                onPickFolder={pickFolder}
                git={git}
                onOpenInEditor={(path) => openFile(path)}
                commitSignal={commitSignal}
              />
            </div>
          )}
        </div>

        {panelMounted && (
          <>
            {panelOpen && <ResizeHandle orientation="horizontal" onMouseDown={panel.onMouseDown} dragging={panel.dragging} ariaLabel="Resize panel" />}
            <BottomPanel
              visible={panelOpen}
              height={panel.size}
              tab={panelTab}
              onTabChange={setPanelTab}
              onHide={() => setPanelOpen(false)}
              terminals={terminals}
              output={output}
              hasRoot={hasRoot}
              onPickFolder={pickFolder}
              focusSignal={panelFocus}
            />
          </>
        )}
      </div>

      {quickOpen && (
        <QuickOpen
          workspaceId={workspace.id}
          onOpen={(path) => openFile(path)}
          onClose={() => {
            setQuickOpen(false)
          }}
        />
      )}
    </div>
  )
})
