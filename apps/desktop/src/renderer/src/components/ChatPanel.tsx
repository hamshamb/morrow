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
import { useConversations } from '../hooks/useConversations'
import { useChat } from '../hooks/useChat'
import { useModelCatalogs } from '../hooks/useModelCatalogs'
import type { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { ModelSelector } from './ModelSelector'
import { MessageList } from './MessageList'
import { ContextInspectorView } from './ContextInspectorView'
import { STATIC_FALLBACK_MODELS } from '../lib/models'

interface Props {
  workspaceId: string
  providerConfigs: ProviderConfigSummary[]
  workspaceFiles: ReturnType<typeof useWorkspaceFiles>
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
}

const CONTEXT_INSPECTOR_DEBOUNCE_MS = 300

export function ChatPanel({
  workspaceId,
  providerConfigs,
  workspaceFiles,
  lastModelSelection,
  onLastModelSelectionChange,
}: Props) {
  const { conversations, activeId, setActiveId, create, remove } = useConversations(workspaceId)
  const { messages, sending, streaming, error, send, regenerate, cancel } = useChat(activeId)
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
  const [contextOpen, setContextOpen] = useState(false)
  const knownSourceIdsRef = useRef<Set<string>>(new Set())

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
      <aside className="chat-panel__conversations">
        <div className="chat-panel__conversations-header">
          <span>Conversations</span>
          <button type="button" onClick={() => void create()} aria-label="New conversation">
            +
          </button>
        </div>
        <nav>
          {conversations.map((conversation) => (
            <div
              key={conversation.id}
              className={`chat-panel__conversation${conversation.id === activeId ? ' is-active' : ''}`}
            >
              <button type="button" onClick={() => setActiveId(conversation.id)}>
                {conversation.title}
              </button>
              <button
                type="button"
                className="chat-panel__conversation-delete"
                aria-label="Delete conversation"
                onClick={() => void remove(conversation.id)}
              >
                ×
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="chat-panel__empty">No conversations yet.</p>
          )}
        </nav>
      </aside>

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

            <div className="chat-panel__composer">
              <div className="chat-panel__composer-row">
                <ModelSelector
                  configs={providerConfigs}
                  catalogs={catalogs}
                  providerConfigId={providerConfigId}
                  model={model}
                  effort={effort}
                  onChange={handleModelChange}
                  onRefreshModels={(id) => void refreshModelCatalog(id)}
                  refreshingIds={refreshingIds}
                />
                {sending ? (
                  <button type="button" onClick={cancel} className="chat-panel__cancel-btn">
                    Cancel
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      providerConfigId && model && void regenerate(providerConfigId, model, effort)
                    }
                    disabled={messages.every((m) => m.role !== 'user')}
                    className="chat-panel__regenerate-btn"
                  >
                    Regenerate
                  </button>
                )}
              </div>

              <div className="chat-panel__context-row">
                <button type="button" onClick={() => void handleAttachFile()} disabled={sending}>
                  📎 Attach file
                </button>
                <div className="chat-panel__file-search">
                  <input
                    type="text"
                    placeholder={
                      workspaceFiles.root
                        ? 'Add a workspace file to context…'
                        : 'Choose a workspace folder in Files to add files…'
                    }
                    value={fileQuery}
                    onChange={(e) => setFileQuery(e.target.value)}
                    disabled={!workspaceFiles.root}
                  />
                  {fileResults.length > 0 && (
                    <ul className="chat-panel__file-results">
                      {fileResults.map((result) => (
                        <li key={result.relativePath}>
                          <button type="button" onClick={() => addFileToContext(result.relativePath)}>
                            + {result.relativePath}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  type="button"
                  className="chat-panel__context-toggle-btn"
                  onClick={() => setContextOpen((v) => !v)}
                >
                  Context {contextSourceCount > 0 ? `(${contextSourceCount})` : ''}{' '}
                  {contextOpen ? '▲' : '▼'}
                </button>
              </div>

              {attachError && <p className="chat-panel__error">{attachError}</p>}

              {(pendingAttachments.length > 0 || selectedFilePaths.length > 0) && (
                <div className="chat-panel__context-chips">
                  {pendingAttachments.map((a) => (
                    <span key={a.filename} className="chat-panel__chip">
                      📎 {a.filename}
                      <button type="button" onClick={() => removeAttachment(a.filename)} aria-label={`Remove ${a.filename}`}>
                        ×
                      </button>
                    </span>
                  ))}
                  {selectedFilePaths.map((path) => (
                    <span key={path} className="chat-panel__chip">
                      📄 {path}
                      <button type="button" onClick={() => removeFileFromContext(path)} aria-label={`Remove ${path}`}>
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {contextOpen && (
                <ContextInspectorView
                  inspector={inspector}
                  loading={inspectorLoading}
                  excludedIds={excludedIds}
                  onToggle={toggleSource}
                />
              )}

              <textarea
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
                    : 'Message… (Enter to send, Shift+Enter for a new line)'
                }
                disabled={sending || providerConfigs.length === 0}
              />
              <button
                type="button"
                className="chat-panel__send-btn"
                onClick={() => void handleSend()}
                disabled={sending || !draft.trim() || providerConfigs.length === 0}
              >
                Send
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
