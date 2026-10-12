import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  type ContextInspectorState,
  type ContextSelection,
  type LastModelSelection,
  type ModelRef,
  type PendingAttachment,
  type ProviderConfigSummary,
  type ProviderId,
  type ReasoningEffort,
  type WorkspaceFileSearchResult,
} from '@ai-workspace/shared'
import type { useConversations } from '../hooks/useConversations'
import { useChat } from '../hooks/useChat'
import type { useModelCatalogs } from '../hooks/useModelCatalogs'
import type { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { ModelSelector } from './ModelSelector'
import { ModelPicker } from './ModelPicker'
import { MessageList } from './MessageList'
import { ContextInspectorView } from './ContextInspectorView'
import { findDisplayName, shortModelName } from '../lib/model-label'
import { findModelMeta, keepEffort, pickDefaultModel } from '../lib/model-meta'
import { DEFAULT_SESSION_TITLE, deriveSessionTitle } from '../lib/session-title'
import { COMPOSER_INPUT_ID, focusComposer } from '../lib/focus'
import { FileIcon, PaperclipIcon } from './icons'
import { ResizeHandle } from './shell/ResizeHandle'
import { useResizablePanel } from '../hooks/useResizablePanel'

interface Props {
  workspaceId: string
  providerConfigs: ProviderConfigSummary[]
  workspaceFiles: ReturnType<typeof useWorkspaceFiles>
  /** Owned by `WorkspaceView` (single-owner pattern) and shared with the
   * `SessionList` panel so both act on the same conversation state. */
  conversations: ReturnType<typeof useConversations>
  /** Owned by `WorkspaceView` so the command palette can read display
   * names too (single owner — see commit 28eb009). */
  modelCatalogs: ReturnType<typeof useModelCatalogs>
  /** The composer's last-used provider/model/effort, persisted in
   * `AppSettings`. `undefined` = settings not loaded yet (distinct from
   * `null`, "loaded, nothing remembered") — see the default-selection
   * effect below for why the distinction matters. */
  lastModelSelection: LastModelSelection | null | undefined
  /** A model was actually used. `setAsDefault` is true for composer
   * changes (persisted as lastModelSelection) and false for a one-off
   * "regenerate with…", which only updates Recent. */
  onModelUsed: (selection: LastModelSelection, setAsDefault: boolean) => void
  favorites: ModelRef[]
  recents: LastModelSelection[]
  onToggleFavorite: (ref: ModelRef) => void
  /** Controlled by `WorkspaceView` so the palette / Esc can drive it. */
  contextOpen: boolean
  onContextOpenChange: (open: boolean) => void
  /** Increment to open the composer's model picker (palette, Ctrl+M). */
  modelPickerSignal: number
  /** Set with a fresh `id` to add a workspace file to the selection. */
  addToContextSignal: { id: number; path: string } | null
  /** Set with a fresh `id` to switch the composer model (palette favorites). */
  selectModelSignal: { id: number; ref: ModelRef } | null
}

const CONTEXT_INSPECTOR_DEBOUNCE_MS = 300

export function ChatPanel({
  workspaceId,
  providerConfigs,
  workspaceFiles,
  conversations,
  modelCatalogs,
  lastModelSelection,
  onModelUsed,
  favorites,
  recents,
  onToggleFavorite,
  contextOpen,
  onContextOpenChange,
  modelPickerSignal,
  addToContextSignal,
  selectModelSignal,
}: Props) {
  const { activeId } = conversations
  const activeConversation = conversations.conversations.find((c) => c.id === activeId) ?? null
  const { messages, sending, streaming, error, send, regenerate, cancel } = useChat(activeId)
  const contextPanel = useResizablePanel({ direction: 'horizontal', initialSize: 320, min: 260, max: 480, reverse: true })
  const { catalogs, refresh: refreshModelCatalog, refreshingIds } = modelCatalogs

  const [providerConfigId, setProviderConfigId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<ReasoningEffort | null>(null)
  const [draft, setDraft] = useState('')
  const [regenPickerOpen, setRegenPickerOpen] = useState(false)
  const [inflightModel, setInflightModel] = useState<{ provider: ProviderId; model: string } | null>(null)

  // Follow the conversation with `use-stick-to-bottom` (MIT): the view stays
  // pinned to the newest text while it streams, and the moment the user scrolls
  // up to read it stops following (no yanking) until they return to the bottom
  // or hit [latest]. Opening a conversation always lands on its latest turn.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({
    resize: 'instant',
    initial: 'instant',
  })
  useEffect(() => {
    void scrollToBottom('instant')
  }, [activeId, scrollToBottom])

  useEffect(() => {
    // Wait for settings to resolve before picking a default — otherwise a
    // faster providerConfigs load would lock in providerConfigs[0] before
    // the remembered selection arrived.
    if (providerConfigId || providerConfigs.length === 0 || lastModelSelection === undefined) return
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
    if (first) setProviderConfigId(first.id)
  }, [providerConfigId, providerConfigs, lastModelSelection])

  // A chosen provider config with no model yet → first model of its live
  // catalog (once fetched) or its static fallback in the meantime.
  useEffect(() => {
    if (!providerConfigId || model) return
    const config = providerConfigs.find((c) => c.id === providerConfigId)
    if (!config) return
    const firstModel = pickDefaultModel(catalogs[providerConfigId]?.models ?? [])
    if (firstModel) setModel(firstModel)
  }, [providerConfigId, model, providerConfigs, catalogs])

  const handleModelChange = useCallback(
    (nextProviderConfigId: string, nextModel: string, nextEffort: ReasoningEffort | null) => {
      setProviderConfigId(nextProviderConfigId)
      setModel(nextModel)
      setEffort(nextEffort)
      onModelUsed({ providerConfigId: nextProviderConfigId, model: nextModel, effort: nextEffort }, true)
    },
    [onModelUsed],
  )

  // Palette favorites → switch the composer model.
  const lastSelectSignalId = useRef<number | null>(null)
  useEffect(() => {
    if (!selectModelSignal || selectModelSignal.id === lastSelectSignalId.current) return
    lastSelectSignalId.current = selectModelSignal.id
    const config = providerConfigs.find((c) => c.id === selectModelSignal.ref.providerConfigId)
    if (!config) return
    const nextEffort = keepEffort(effort, findModelMeta(catalogs, config.id, selectModelSignal.ref.model))
    handleModelChange(config.id, selectModelSignal.ref.model, nextEffort)
    focusComposer()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new signal should retrigger this
  }, [selectModelSignal])

  const modelName = useCallback(
    (modelId: string) => shortModelName(modelId, findDisplayName(catalogs, modelId)),
    [catalogs],
  )

  // --- Context selection (attachments, workspace files, retrieval, and the
  // Context Inspector that gates all of it) ---
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
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false)
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
    } finally {
      focusComposer()
    }
  }

  function addFileToContext(relativePath: string) {
    setSelectedFilePaths((prev) => (prev.includes(relativePath) ? prev : [...prev, relativePath]))
    setFileQuery('')
    setFileResults([])
  }

  const lastAddSignalId = useRef<number | null>(null)
  useEffect(() => {
    if (!addToContextSignal || addToContextSignal.id === lastAddSignalId.current) return
    lastAddSignalId.current = addToContextSignal.id
    addFileToContext(addToContextSignal.path)
    onContextOpenChange(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new signal should retrigger this
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

  const contextSourceCount = inspector ? inspector.sources.filter((s) => s.type !== 'conversation-history').length : 0
  const activeConfig = providerConfigs.find((c) => c.id === providerConfigId) ?? null
  const activeMeta = findModelMeta(catalogs, providerConfigId, model)

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed || !providerConfigId || !model || sending || !activeId || !activeConfig) return
    const selection = resolveSelection()
    // Auto-title from the first message (no extra model call); a user's
    // own rename is never overwritten.
    if (activeConversation?.title === DEFAULT_SESSION_TITLE && messages.length === 0) {
      void conversations.rename(activeId, deriveSessionTitle(trimmed))
    }
    setDraft('')
    setPendingAttachments([])
    setAttachError(null)
    setInflightModel({ provider: activeConfig.provider, model })
    void scrollToBottom('instant')
    // Re-validate against the model's own effort list: the composer could
    // still hold an effort from a previously selected model.
    await send(providerConfigId, model, trimmed, selection, keepEffort(effort, activeMeta))
    focusComposer()
  }

  async function runRegenerate(targetConfigId: string, targetModel: string, targetEffort: ReasoningEffort | null) {
    const config = providerConfigs.find((c) => c.id === targetConfigId)
    if (!config) return
    setRegenPickerOpen(false)
    setInflightModel({ provider: config.provider, model: targetModel })
    void scrollToBottom('instant')
    await regenerate(targetConfigId, targetModel, targetEffort)
    focusComposer()
  }

  const regeneratePicker = useMemo(
    () =>
      regenPickerOpen ? (
        <div className="popover popover--inline">
          <ModelPicker
            title="regenerate with"
            configs={providerConfigs}
            catalogs={catalogs}
            selected={providerConfigId && model ? { providerConfigId, model } : null}
            favorites={favorites}
            recents={recents}
            onToggleFavorite={onToggleFavorite}
            onClose={() => {
              setRegenPickerOpen(false)
              focusComposer()
            }}
            onSelect={(option) => {
              const nextEffort = keepEffort(effort, option.meta)
              onModelUsed({ providerConfigId: option.providerConfigId, model: option.modelId, effort: nextEffort }, false)
              void runRegenerate(option.providerConfigId, option.modelId, nextEffort)
            }}
          />
        </div>
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runRegenerate is a per-render closure over the same state listed here
    [regenPickerOpen, providerConfigs, catalogs, providerConfigId, model, effort, favorites, recents, onToggleFavorite, onModelUsed],
  )

  if (!activeId) {
    return (
      <div className="chat-panel">
        <div className="empty-state chat-panel__empty">
          <p className="empty-state__title">No session open</p>
          <p className="empty-state__hint">
            <button type="button" className="link-action" onClick={() => void conversations.create()}>
              [start a session]
            </button>{' '}
            <kbd>c</kbd>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-panel">
      <div className="chat-panel__thread">
        <div className="chat-panel__scroll" ref={scrollRef}>
          <div className="column" ref={contentRef}>
            <MessageList
              messages={messages}
              streaming={streaming}
              modelName={modelName}
              pendingModel={inflightModel}
              error={error}
              busy={sending}
              onRegenerate={() => providerConfigId && model && void runRegenerate(providerConfigId, model, effort)}
              onOpenRegeneratePicker={() => setRegenPickerOpen((v) => !v)}
              regeneratePicker={regeneratePicker}
            />
          </div>
        </div>

        {!isAtBottom && (
          <button
            type="button"
            className="link-action chat-panel__latest"
            onClick={() => void scrollToBottom('smooth')}
            title="jump to the newest message"
          >
            [↓ latest]
          </button>
        )}

        <div className="column composer-wrap">
          {attachError && <p className="signal composer__note">{attachError}</p>}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault()
              void handleSend()
            }}
          >
            {(pendingAttachments.length > 0 || selectedFilePaths.length > 0) && (
              <div className="activity-rows composer__attachments">
                {pendingAttachments.map((a) => (
                  <div className="activity-row" key={a.filename}>
                    <span className="activity-row__icon">
                      <PaperclipIcon />
                    </span>
                    <span className="activity-row__title">{a.filename}</span>
                    <span className="activity-row__subtitle">attachment · {(a.sizeBytes / 1024).toFixed(1)} kB</span>
                    <button
                      type="button"
                      className="link-action"
                      onClick={() => setPendingAttachments((prev) => prev.filter((p) => p.filename !== a.filename))}
                      aria-label={`Remove ${a.filename}`}
                    >
                      [x]
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
                      className="link-action"
                      onClick={() => setSelectedFilePaths((prev) => prev.filter((p) => p !== path))}
                      aria-label={`Remove ${path}`}
                    >
                      [x]
                    </button>
                  </div>
                ))}
              </div>
            )}

            <textarea
              id={COMPOSER_INPUT_ID}
              className="composer__input"
              value={draft}
              autoFocus
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}
              placeholder="message — enter to send, shift+enter for a new line"
              disabled={sending}
            />

            <div className="composer__footer">
              <div className="composer__add" ref={addMenuRef}>
                <button
                  type="button"
                  className={`composer__icon${addMenuOpen ? ' is-active' : ''}`}
                  onClick={() => setAddMenuOpen((v) => !v)}
                  disabled={sending}
                  aria-haspopup="menu"
                  aria-expanded={addMenuOpen}
                  title="attach a file or add a workspace file"
                >
                  +
                </button>
                {addMenuOpen && (
                  <div className="popover popover--above composer__add-menu" role="menu">
                    <button
                      type="button"
                      className="menu__item"
                      onClick={() => {
                        setAddMenuOpen(false)
                        void handleAttachFile()
                      }}
                    >
                      attach a file…
                    </button>
                    <div className="label composer__add-label">add a workspace file</div>
                    {workspaceFiles.root ? (
                      <>
                        <input
                          className="input"
                          autoFocus
                          placeholder="search indexed files…"
                          value={fileQuery}
                          onChange={(e) => setFileQuery(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              setAddMenuOpen(false)
                              focusComposer()
                            }
                          }}
                        />
                        {fileResults.map((result) => (
                          <button
                            key={result.relativePath}
                            type="button"
                            className="menu__item"
                            onClick={() => addFileToContext(result.relativePath)}
                          >
                            {result.relativePath}
                          </button>
                        ))}
                      </>
                    ) : (
                      <p className="muted composer__add-empty">No folder yet — use Ctrl+K → Workspace files.</p>
                    )}
                  </div>
                )}
              </div>

              <ModelSelector
                configs={providerConfigs}
                catalogs={catalogs}
                providerConfigId={providerConfigId}
                model={model}
                effort={effort}
                onChange={handleModelChange}
                onRefreshModels={(id) => void refreshModelCatalog(id)}
                refreshingIds={refreshingIds}
                favorites={favorites}
                recents={recents}
                onToggleFavorite={onToggleFavorite}
                externalOpenSignal={modelPickerSignal}
              />

              <button
                type="button"
                className={`link-action composer__context${contextOpen ? ' is-active' : ''}`}
                onClick={() => onContextOpenChange(!contextOpen)}
                title="what's actually sent with this message"
              >
                [context{contextSourceCount > 0 ? ` ${contextSourceCount}` : ''}]
              </button>

              <span className="composer__spacer" />

              {sending ? (
                <button type="button" onClick={cancel} className="btn composer__send" aria-label="Stop generating">
                  stop ■
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn--primary composer__send"
                  disabled={!draft.trim() || !model}
                  aria-label="Send message"
                >
                  send ↵
                </button>
              )}
            </div>
          </form>
        </div>
      </div>

      {contextOpen && (
        <>
          <ResizeHandle onMouseDown={contextPanel.onMouseDown} dragging={contextPanel.dragging} ariaLabel="Resize context panel" />
          <aside className="context-panel" style={{ width: contextPanel.size }}>
            <div className="panel-header">
              <span className="label">context</span>
              <button
                type="button"
                className="link-action"
                onClick={() => {
                  onContextOpenChange(false)
                  focusComposer()
                }}
              >
                [close]
              </button>
            </div>
            <ContextInspectorView
              inspector={inspector}
              loading={inspectorLoading}
              excludedIds={excludedIds}
              onToggle={toggleSource}
              contextLimit={activeMeta?.contextWindow ?? null}
              modelName={model ? modelName(model) : null}
            />
          </aside>
        </>
      )}
    </div>
  )
}
