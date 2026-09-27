import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ContextInspectorState,
  ContextSelection,
  LastModelSelection,
  PendingAttachment,
  ProviderConfigSummary,
  ReasoningEffort,
  WorkspaceFileSearchResult,
} from '@ai-workspace/shared'
import type { useConversations } from '../hooks/useConversations'
import { useChat } from '../hooks/useChat'
import { useModelCatalogs } from '../hooks/useModelCatalogs'
import type { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { ModelSelector } from './ModelSelector'
import { MessageList } from './MessageList'
import { ContextInspectorView } from './ContextInspectorView'
import { STATIC_FALLBACK_MODELS } from '../lib/models'
import { ArrowUpIcon, CloseIcon, FileIcon, PaperclipIcon, PanelRightIcon, PlusIcon, StopIcon } from './icons'
import { ResizeHandle } from './shell/ResizeHandle'
import { useResizablePanel } from '../hooks/useResizablePanel'

interface Props {
  workspaceId: string
  providerConfigs: ProviderConfigSummary[]
  workspaceFiles: ReturnType<typeof useWorkspaceFiles>
  /** Owned by `WorkspaceView` (single-owner pattern) and shared with the
   * `SessionList` panel so both act on the same conversation state. */
  conversations: ReturnType<typeof useConversations>
  /** The composer's last-used provider/model/effort, persisted in
   * `AppSettings` — restored as the default selection instead of always
   * picking `providerConfigs[0]` + its first model. Owned by `App` (single
   * owner, like `useProviderConfigs`) and threaded down through
   * `WorkspaceView`. `undefined` specifically means "settings haven't
   * loaded yet" (distinct from `null`, "loaded, nothing remembered") —
   * `App`'s own `useSettings` resolves asynchronously over IPC, same as
   * `useProviderConfigs`, and the two calls can resolve in either order.
   * Without this distinction, provider configs resolving first would lock
   * in the `providerConfigs[0]` fallback below before the remembered
   * selection ever arrived. */
  lastModelSelection: LastModelSelection | null | undefined
  onLastModelSelectionChange: (selection: LastModelSelection) => void
  /** Controlled by `WorkspaceView` so the command palette's "Open Context
   * Inspector" action can open it from outside this component. */
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  /** Incrementing this (from the command palette's "Switch model") opens
   * the model picker popover. */
  modelPickerSignal: number
  /** Set (with a fresh `id`) by the command palette's "Add to context"
   * workspace-file action; adds that path to the selection and opens the
   * Context Inspector so the result is visible. */
  addToContextSignal: { id: number; path: string } | null
}

const CONTEXT_INSPECTOR_DEBOUNCE_MS = 300

export function ChatPanel({
  workspaceId,
  providerConfigs,
  workspaceFiles,
  conversations,
  lastModelSelection,
  onLastModelSelectionChange,
  contextOpen,
  onContextOpenChange,
  modelPickerSignal,
  addToContextSignal,
}: Props) {
  const { activeId } = conversations
  const { messages, sending, streaming, error, send, regenerate, cancel } = useChat(activeId)
  const contextPanel = useResizablePanel({
    direction: 'horizontal',
    initialSize: 300,
    min: 240,
    max: 480,
    reverse: true,
  })
  const { catalogs, refresh: refreshModelCatalog, refreshingIds } = useModelCatalogs(providerConfigs)

  const [providerConfigId, setProviderConfigId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<ReasoningEffort | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    // Wait for settings to actually resolve (see the `lastModelSelection`
    // prop doc above) before picking any default — otherwise a faster
    // providerConfigs load would win the race and the remembered selection
    // would never get applied.
    if (providerConfigId || providerConfigs.length === 0 || lastModelSelection === undefined) {
      return
    }
    // Prefer the persisted last-used selection, but only if that provider
    // config still exists (it may have been removed since) — otherwise
    // fall back to the first configured provider, same as before.
    const remembered = lastModelSelection
      ? providerConfigs.find((c) => c.id === lastModelSelection.providerConfigId)
      : undefined
    if (remembered && lastModelSelection) {
      setProviderConfigId(remembered.id)
      setModel(lastModelSelection.model)
      setEffort(lastModelSelection.effort)
      return
    }
    const first = providerConfigs[0]
    if (!first) return
    setProviderConfigId(first.id)
  }, [providerConfigId, providerConfigs, lastModelSelection])

  // Once a provider config is chosen but there's no model yet (either the
  // fallback path above, or a remembered model that no longer applies),
  // default to the first model from its live catalog (once fetched) or its
  // static fallback list in the meantime.
  useEffect(() => {
    if (!providerConfigId || model) return
    const config = providerConfigs.find((c) => c.id === providerConfigId)
    if (!config) return
    const cached = catalogs[providerConfigId]
    const candidates =
      cached && cached.models.length > 0 ? cached.models : STATIC_FALLBACK_MODELS[config.provider]
    const firstModel = candidates[0]?.id
    if (firstModel) setModel(firstModel)
  }, [providerConfigId, model, providerConfigs, catalogs])

  const handleModelChange = useCallback(
    (nextProviderConfigId: string, nextModel: string, nextEffort: ReasoningEffort | null) => {
      setProviderConfigId(nextProviderConfigId)
      setModel(nextModel)
      setEffort(nextEffort)
      onLastModelSelectionChange({
        providerConfigId: nextProviderConfigId,
        model: nextModel,
        effort: nextEffort,
      })
    },
    [onLastModelSelectionChange],
  )

  // --- Phase 3: context selection (attachments, workspace files, retrieval,
  // and the Context Inspector that gates all of it) ---
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([])
  const [fileQuery, setFileQuery] = useState('')
  const [fileResults, setFileResults] = useState<WorkspaceFileSearchResult[]>([])
  const [inspector, setInspector] = useState<ContextInspectorState | null>(null)
  const [inspectorLoading, setInspectorLoading] = useState(false)
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set())
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const knownSourceIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!addMenuOpen) return
    function onDocClick(e: MouseEvent) {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [addMenuOpen])

  useEffect(() => {
    if (!activeId) {
      setInspector(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setInspectorLoading(true)
      window.api.chat
        .getContextInspector({
          workspaceId,
          conversationId: activeId,
          draftContent: draft,
          pendingAttachments,
          selectedWorkspaceFilePaths: selectedFilePaths,
        })
        .then((state) => {
          if (cancelled) return
          setInspector(state)
          setExcludedIds((prev) => {
            const next = new Set<string>()
            for (const source of state.sources) {
              const known = knownSourceIdsRef.current.has(source.id)
              const excluded = known ? prev.has(source.id) : !source.includedByDefault
              if (excluded) next.add(source.id)
            }
            knownSourceIdsRef.current = new Set(state.sources.map((s) => s.id))
            return next
          })
        })
        .catch(() => {
          if (!cancelled) setInspector(null)
        })
        .finally(() => {
          if (!cancelled) setInspectorLoading(false)
        })
    }, CONTEXT_INSPECTOR_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspaceId, activeId, draft, pendingAttachments, selectedFilePaths])

  useEffect(() => {
    if (!fileQuery.trim()) {
      setFileResults([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void workspaceFiles.search(fileQuery).then((results) => {
        if (!cancelled) setFileResults(results)
      })
    }, CONTEXT_INSPECTOR_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [fileQuery, workspaceFiles])

  const toggleSource = useCallback((sourceId: string) => {
    setExcludedIds((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }, [])

  async function handleAttachFile() {
    setAttachError(null)
    try {
      const picked = await window.api.attachments.pickFile()
      if (picked) setPendingAttachments((prev) => [...prev, picked])
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err))
    }
  }

  function removeAttachment(filename: string) {
    setPendingAttachments((prev) => prev.filter((a) => a.filename !== filename))
  }

  function addFileToContext(relativePath: string) {
    setSelectedFilePaths((prev) => (prev.includes(relativePath) ? prev : [...prev, relativePath]))
    setFileQuery('')
    setFileResults([])
  }

  function removeFileFromContext(relativePath: string) {
    setSelectedFilePaths((prev) => prev.filter((p) => p !== relativePath))
  }

  const lastAddSignalId = useRef<number | null>(null)
  useEffect(() => {
    if (!addToContextSignal || addToContextSignal.id === lastAddSignalId.current) return
    lastAddSignalId.current = addToContextSignal.id
    addFileToContext(addToContextSignal.path)
    onContextOpenChange(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addFileToContext/onContextOpenChange are stable-enough per-render callbacks; only addToContextSignal should retrigger this
  }, [addToContextSignal])

  const resolveSelection = useCallback((): ContextSelection | undefined => {
    if (!inspector) return undefined
    const included = (id: string) => !excludedIds.has(id)
    return {
      includeHistory: included('history'),
      attachments: pendingAttachments.filter((a) => included(`attachment:${a.filename}`)),
      workspaceFilePaths: selectedFilePaths.filter((p) => included(`file:${p}`)),
      retrievalSnippetPaths: inspector.sources
        .filter((s) => s.type === 'retrieval-snippet' && included(s.id))
        .map((s) => s.label),
    }
  }, [inspector, excludedIds, pendingAttachments, selectedFilePaths])

  const contextSourceCount = inspector
    ? inspector.sources.filter((s) => s.type !== 'conversation-history').length
    : 0

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed || !providerConfigId || !model || sending) return
    const selection = resolveSelection()
    setDraft('')
    setPendingAttachments([])
    setAttachError(null)
    await send(providerConfigId, model, trimmed, selection, effort)
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__thread">
        {!activeId ? (
          <div className="chat-panel__placeholder">
            <p>Create a conversation to start chatting.</p>
          </div>
        ) : (
          <>
            <div className="chat-panel__messages">
              <MessageList messages={messages} streaming={streaming} />
            </div>

            {error && <p className="chat-panel__error">{error}</p>}

            <div className="chat-panel__composer-wrap">
              {messages.some((m) => m.role === 'user') && !sending && (
                <div className="chat-panel__regenerate-row">
                  <button
                    type="button"
                    onClick={() =>
                      providerConfigId && model && void regenerate(providerConfigId, model, effort)
                    }
                    className="chat-panel__regenerate-btn"
                  >
                    Regenerate
                  </button>
                </div>
              )}

              {attachError && <p className="chat-panel__error">{attachError}</p>}

              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault()
                  void handleSend()
                }}
              >
                {(pendingAttachments.length > 0 || selectedFilePaths.length > 0) && (
                  <div className="composer__attachments">
                    <div className="activity-row-list">
                      {pendingAttachments.map((a) => (
                        <div className="activity-row" key={a.filename}>
                          <span className="activity-row__icon">
                            <PaperclipIcon />
                          </span>
                          <span className="activity-row__title">{a.filename}</span>
                          <span className="activity-row__subtitle">attachment</span>
                          <button
                            type="button"
                            className="activity-row__remove"
                            onClick={() => removeAttachment(a.filename)}
                            aria-label={`Remove ${a.filename}`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                      {selectedFilePaths.map((path) => (
                        <div className="activity-row" key={path}>
                          <span className="activity-row__icon">
                            <FileIcon />
                          </span>
                          <span className="activity-row__title">{path.split(/[\\/]/).pop()}</span>
                          <span className="activity-row__subtitle">{path}</span>
                          <button
                            type="button"
                            className="activity-row__remove"
                            onClick={() => removeFileFromContext(path)}
                            aria-label={`Remove ${path}`}
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <textarea
                  className="composer__textarea"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      void handleSend()
                    }
                  }}
                  placeholder={
                    providerConfigs.length === 0
                      ? 'Add a provider API key in Settings to start chatting…'
                      : 'Message… + to attach, Enter to send, Shift+Enter for a new line'
                  }
                  disabled={sending || providerConfigs.length === 0}
                />

                <div className="composer__footer">
                  <div className="composer__footer-left">
                    <div className="composer__add-menu" ref={addMenuRef}>
                      <button
                        type="button"
                        className={`composer__icon-btn${addMenuOpen ? ' composer__icon-btn--active' : ''}`}
                        onClick={() => setAddMenuOpen((v) => !v)}
                        disabled={sending}
                        aria-haspopup="menu"
                        aria-expanded={addMenuOpen}
                        title="Attach file or add workspace file to context"
                      >
                        <PlusIcon />
                      </button>
                      {addMenuOpen && (
                        <div className="composer__add-popover" role="menu">
                          <button
                            type="button"
                            className="composer__add-action"
                            onClick={() => {
                              setAddMenuOpen(false)
                              void handleAttachFile()
                            }}
                          >
                            <PaperclipIcon />
                            Attach file…
                          </button>
                          <div className="composer__add-divider" />
                          <div className="composer__file-search">
                            <input
                              type="text"
                              placeholder={
                                workspaceFiles.root
                                  ? 'Add a workspace file to context…'
                                  : 'Choose a folder in Files first…'
                              }
                              value={fileQuery}
                              onChange={(e) => setFileQuery(e.target.value)}
                              disabled={!workspaceFiles.root}
                            />
                            {fileResults.length > 0 && (
                              <ul className="composer__file-results">
                                {fileResults.map((result) => (
                                  <li key={result.relativePath}>
                                    <button
                                      type="button"
                                      onClick={() => addFileToContext(result.relativePath)}
                                    >
                                      {result.relativePath}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      className={`composer__icon-btn${contextOpen ? ' composer__icon-btn--active' : ''}`}
                      onClick={() => onContextOpenChange(!contextOpen)}
                      title="Context inspector — what's actually sent with this message"
                    >
                      <PanelRightIcon />
                      {contextSourceCount > 0 && (
                        <span className="composer__context-badge">{contextSourceCount}</span>
                      )}
                    </button>

                    <ModelSelector
                      configs={providerConfigs}
                      catalogs={catalogs}
                      providerConfigId={providerConfigId}
                      model={model}
                      effort={effort}
                      onChange={handleModelChange}
                      onRefreshModels={(id) => void refreshModelCatalog(id)}
                      refreshingIds={refreshingIds}
                      externalOpenSignal={modelPickerSignal}
                    />
                  </div>

                  {sending ? (
                    <button
                      type="button"
                      onClick={cancel}
                      className="composer__submit composer__submit--stop"
                      aria-label="Stop generating"
                      title="Stop generating"
                    >
                      <StopIcon />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      className="composer__submit"
                      disabled={!draft.trim() || providerConfigs.length === 0}
                      aria-label="Send message"
                      title="Send message"
                    >
                      <ArrowUpIcon />
                    </button>
                  )}
                </div>
              </form>
            </div>
          </>
        )}
      </div>

      {activeId && contextOpen && (
        <>
          <ResizeHandle
            onMouseDown={contextPanel.onMouseDown}
            dragging={contextPanel.dragging}
            ariaLabel="Resize context panel"
          />
          <div className="chat-panel__context-panel" style={{ width: contextPanel.size }}>
            <div className="chat-panel__context-panel-header">
              <span>
                <PanelRightIcon /> Context
              </span>
              <button
                type="button"
                onClick={() => onContextOpenChange(false)}
                aria-label="Close context panel"
              >
                <CloseIcon />
              </button>
            </div>
            <ContextInspectorView
              inspector={inspector}
              loading={inspectorLoading}
              excludedIds={excludedIds}
              onToggle={toggleSource}
            />
          </div>
        </>
      )}
    </div>
  )
}
