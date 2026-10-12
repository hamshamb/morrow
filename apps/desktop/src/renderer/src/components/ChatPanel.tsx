import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStickToBottom } from 'use-stick-to-bottom'
import {
  attachmentMimeType,
  attachmentRejectionReason,
  looksBinary,
  mergeAttachments,
  type AttachFilesResult,
  type AttachmentRejection,
  type AutoPreference,
  type ComposerMode,
  type ContextInspectorState,
  type ContextSelection,
  type LastModelSelection,
  type Message,
  type ModelRef,
  type PendingAttachment,
  type ProviderConfigSummary,
  type ReasoningEffort,
  type WorkspaceFileSearchResult,
} from '@ai-workspace/shared'
import type { useConversations } from '../hooks/useConversations'
import { useChat, type RoundTableTarget, type RunTarget } from '../hooks/useChat'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { ModeChip, ModeControls } from './ComposerModes'
import { defaultRoleAt, modeProblem, suggestModels, type ModeConfig, type ModelSlot } from '../lib/orchestration-ui'
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
import { formatFileSize } from '../lib/file-size'
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
  /** Set with a fresh `id` to add a pending attachment (an editor buffer or selection from /code). */
  addAttachmentSignal: { id: number; attachment: PendingAttachment } | null
  /** Set with a fresh `id` to switch the composer model (palette favorites). */
  selectModelSignal: { id: number; ref: ModelRef } | null
  /** Set with a fresh `id` to put the composer in a mode (palette: Compare models…). */
  modeSignal: { id: number; mode: ComposerMode } | null
  /** Increment to open the composer's mode menu (Ctrl+Shift+M). */
  modeMenuSignal: number
  autoPreference: AutoPreference
  onAutoPreferenceChange: (preference: AutoPreference) => void
}

const INITIAL_MODE_CONFIG: ModeConfig = {
  mode: 'chat',
  compare: [],
  reviewer: null,
  roundTable: [],
  synthesizer: null,
  rounds: 1,
}

const PLACEHOLDERS: Record<ComposerMode, string> = {
  chat: 'message — enter to send, shift+enter for a new line',
  compare: 'one prompt, several models — enter to compare',
  review: 'ask a question — a second model will review the answer',
  roundtable: 'pose a question for the round table',
  auto: 'message — Auto picks the model',
}

const SEND_LABELS: Record<ComposerMode, string> = {
  chat: 'send ↵',
  compare: 'compare ↵',
  review: 'review ↵',
  roundtable: 'discuss ↵',
  auto: 'send ↵',
}

const CONTEXT_INSPECTOR_DEBOUNCE_MS = 300

/**
 * Reads files dropped on the composer. Only the files the user physically
 * dropped are readable here (no paths cross to the main process); the same
 * type/size/binary rules as the native picker apply, checked before reading.
 */
async function readDroppedFiles(files: File[]): Promise<AttachFilesResult> {
  const result: AttachFilesResult = { attachments: [], rejected: [] }
  for (const file of files) {
    const reason = attachmentRejectionReason(file.name, file.size)
    if (reason) {
      result.rejected.push({ filename: file.name, reason })
      continue
    }
    try {
      const content = await file.text()
      if (looksBinary(content)) result.rejected.push({ filename: file.name, reason: 'binary file' })
      else result.attachments.push({ filename: file.name, mimeType: attachmentMimeType(file.name), sizeBytes: file.size, content })
    } catch {
      result.rejected.push({ filename: file.name, reason: 'could not be read' })
    }
  }
  return result
}

function describeRejections(rejected: AttachmentRejection[]): string | null {
  if (rejected.length === 0) return null
  const shown = rejected.slice(0, 4).map((r) => `${r.filename} (${r.reason})`)
  const more = rejected.length > shown.length ? ` · +${rejected.length - shown.length} more` : ''
  return `skipped ${shown.join(' · ')}${more}`
}

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
  addAttachmentSignal,
  selectModelSignal,
  modeSignal,
  modeMenuSignal,
  autoPreference,
  onAutoPreferenceChange,
}: Props) {
  const { activeId } = conversations
  const activeConversation = conversations.conversations.find((c) => c.id === activeId) ?? null
  const chat = useChat(activeId)
  const { messages, sending, live, error, cancel } = chat
  const registry = useProviderRegistry()
  const contextPanel = useResizablePanel({ direction: 'horizontal', initialSize: 320, min: 260, max: 480, reverse: true })
  const { catalogs, refresh: refreshModelCatalog, refreshingIds } = modelCatalogs

  const [providerConfigId, setProviderConfigId] = useState<string | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [effort, setEffort] = useState<ReasoningEffort | null>(null)
  const [draft, setDraft] = useState('')
  const [regenPickerOpen, setRegenPickerOpen] = useState(false)
  const [modeConfig, setModeConfig] = useState<ModeConfig>(INITIAL_MODE_CONFIG)
  const [columnPickerFor, setColumnPickerFor] = useState<string | null>(null)

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
  const [dropActive, setDropActive] = useState(false)
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

  /** Adds a batch of picked/dropped files; anything skipped is listed with its reason. */
  function addAttachments(batch: AttachFilesResult) {
    const merged = mergeAttachments(pendingAttachments, batch.attachments)
    setPendingAttachments(merged.attachments)
    setAttachError(describeRejections([...batch.rejected, ...merged.rejected]))
  }

  async function handleAttachFiles() {
    setAttachError(null)
    try {
      const picked = await window.api.attachments.pickFiles()
      if (picked) addAttachments(picked)
    } catch (err) {
      setAttachError(err instanceof Error ? err.message : String(err))
    } finally {
      focusComposer()
    }
  }

  async function handleDroppedFiles(files: File[]) {
    setAttachError(null)
    addAttachments(await readDroppedFiles(files))
    focusComposer()
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

  // An editor buffer / selection sent from /code arrives as a pending attachment,
  // so it rides the existing Context Inspector toggles (same filename replaces the old copy).
  const lastAttachmentSignalId = useRef<number | null>(null)
  useEffect(() => {
    if (!addAttachmentSignal || addAttachmentSignal.id === lastAttachmentSignalId.current) return
    lastAttachmentSignalId.current = addAttachmentSignal.id
    const incoming = addAttachmentSignal.attachment
    setPendingAttachments((prev) => {
      const merged = mergeAttachments(prev.filter((a) => a.filename !== incoming.filename), [incoming])
      if (merged.rejected.length > 0) setAttachError(describeRejections(merged.rejected))
      return merged.attachments
    })
  }, [addAttachmentSignal])

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

  // --- Modes (compare / review / round table / auto). `chat` is the clean
  // default; the others reveal their own controls only while selected.
  const configIds = useMemo(() => providerConfigs.map((c) => c.id), [providerConfigs])
  const mode = modeConfig.mode

  function currentSlot(): ModelSlot | null {
    return providerConfigId && model ? { providerConfigId, model, effort: keepEffort(effort, activeMeta) } : null
  }

  function suggest(exclude: ModelRef[], count: number): ModelSlot[] {
    return suggestModels({ catalogs, configIds, favorites, recents, exclude, count }).map((ref) => ({ ...ref, effort: null }))
  }

  /** Switching to a mode pre-fills it from the composer model, favorites and recents. */
  function changeMode(next: ComposerMode) {
    const here = currentSlot()
    setModeConfig((prev) => {
      const cfg: ModeConfig = { ...prev, mode: next }
      const base = here ? [here] : []
      if (next === 'compare' && cfg.compare.length < 2) {
        cfg.compare = [...base, ...suggest(base, 3 - base.length)]
      }
      if (next === 'review' && !cfg.reviewer) {
        cfg.reviewer = suggest(base, 1)[0] ?? null
      }
      if (next === 'roundtable' && cfg.roundTable.length < 2) {
        cfg.roundTable = [...base, ...suggest(base, 3 - base.length)].map((slot, i) => ({ ...slot, role: defaultRoleAt(i) }))
      }
      return cfg
    })
  }

  const lastModeSignalId = useRef<number | null>(null)
  useEffect(() => {
    if (!modeSignal || modeSignal.id === lastModeSignalId.current) return
    lastModeSignalId.current = modeSignal.id
    changeMode(modeSignal.mode)
    focusComposer()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new signal should retrigger this
  }, [modeSignal])

  /** A mode slot as something the hook can run; null when its key was removed. */
  function toRunTarget(slot: ModelSlot): RunTarget | null {
    const config = providerConfigs.find((c) => c.id === slot.providerConfigId)
    if (!config) return null
    return {
      providerConfigId: config.id,
      provider: config.provider,
      model: slot.model,
      effort: keepEffort(slot.effort, findModelMeta(catalogs, config.id, slot.model)),
    }
  }

  const problem = modeProblem(modeConfig, !!providerConfigId && !!model)
  const modeIsIdleForModelChip = mode === 'compare' || mode === 'roundtable' || mode === 'auto'
  const primaryLabel =
    model && activeConfig ? `${modelName(model)} · ${registry.label(activeConfig.provider)}` : null

  async function handleSend() {
    const trimmed = draft.trim()
    if (!trimmed || sending || !activeId || problem) return
    const missingKey = 'A selected model belongs to a key that was removed — pick it again.'

    // Resolve every target before touching the draft, so a stale slot loses nothing.
    let run: (() => Promise<void>) | null = null
    const selection = resolveSelection()
    if (mode === 'chat') {
      if (!providerConfigId || !model || !activeConfig) return
      const config = activeConfig
      const modelId = model
      run = () => chat.send(providerConfigId, config.provider, modelId, trimmed, selection, keepEffort(effort, activeMeta))
    } else if (mode === 'auto') {
      run = () => chat.sendAuto(trimmed, selection, autoPreference)
    } else if (mode === 'compare') {
      const targets = modeConfig.compare.map(toRunTarget)
      if (targets.some((t) => t === null)) return setAttachError(missingKey)
      const resolved = targets as RunTarget[]
      for (const t of resolved) onModelUsed({ providerConfigId: t.providerConfigId, model: t.model, effort: t.effort }, false)
      run = () => chat.sendCompare(resolved, trimmed, selection)
    } else if (mode === 'review') {
      const primarySlot = currentSlot()
      const primary = primarySlot ? toRunTarget(primarySlot) : null
      const reviewer = modeConfig.reviewer ? toRunTarget(modeConfig.reviewer) : null
      if (!primary || !reviewer) return setAttachError(missingKey)
      onModelUsed({ providerConfigId: reviewer.providerConfigId, model: reviewer.model, effort: null }, false)
      run = () => chat.sendReview(primary, reviewer, trimmed, selection)
    } else {
      const turns = modeConfig.roundTable.map((slot) => {
        const target = toRunTarget(slot)
        return target ? ({ ...target, role: slot.role } satisfies RoundTableTarget) : null
      })
      const synth = modeConfig.synthesizer ? toRunTarget(modeConfig.synthesizer) : null
      if (turns.some((t) => t === null) || (modeConfig.synthesizer && !synth)) return setAttachError(missingKey)
      const resolved = turns as RoundTableTarget[]
      run = () => chat.sendRoundTable(resolved, synth, modeConfig.rounds, trimmed, selection)
    }

    // Auto-title from the first message (no extra model call); a user's
    // own rename is never overwritten.
    if (activeConversation?.title === DEFAULT_SESSION_TITLE && messages.length === 0) {
      void conversations.rename(activeId, deriveSessionTitle(trimmed))
    }
    setDraft('')
    setPendingAttachments([])
    setAttachError(null)
    void scrollToBottom('instant')
    await run()
    focusComposer()
  }

  async function runRegenerate(targetConfigId: string, targetModel: string, targetEffort: ReasoningEffort | null) {
    const config = providerConfigs.find((c) => c.id === targetConfigId)
    if (!config) return
    setRegenPickerOpen(false)
    void scrollToBottom('instant')
    await chat.regenerate({ providerConfigId: targetConfigId, provider: config.provider, model: targetModel, effort: targetEffort })
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

  // --- Compare columns / review actions that act on a stored reply.
  const messageById = (id: string): Message | undefined => messages.find((m) => m.id === id)

  /** The first saved key for the provider that wrote a stored reply. */
  function targetForMessage(message: Message): RunTarget | null {
    const config = providerConfigs.find((c) => c.provider === message.provider)
    if (!config || !message.model) return null
    return { providerConfigId: config.id, provider: config.provider, model: message.model, effort: null }
  }

  async function retryColumn(messageId: string) {
    const failed = messageById(messageId)
    if (!failed) return
    const target = targetForMessage(failed)
    if (!target) {
      setColumnPickerFor(messageId)
      return
    }
    void scrollToBottom('instant')
    await chat.retryReply(failed, target)
    focusComposer()
  }

  const columnPicker = useMemo(() => {
    if (!columnPickerFor) return null
    return {
      messageId: columnPickerFor,
      node: (
        <div className="popover popover--inline">
          <ModelPicker
            title="switch model"
            configs={providerConfigs}
            catalogs={catalogs}
            selected={null}
            favorites={favorites}
            recents={recents}
            onToggleFavorite={onToggleFavorite}
            onClose={() => {
              setColumnPickerFor(null)
              focusComposer()
            }}
            onSelect={(option) => {
              const failed = messages.find((m) => m.id === columnPickerFor)
              setColumnPickerFor(null)
              if (!failed) return
              const config = providerConfigs.find((c) => c.id === option.providerConfigId)
              if (!config) return
              onModelUsed({ providerConfigId: option.providerConfigId, model: option.modelId, effort: null }, false)
              void chat
                .retryReply(failed, { providerConfigId: config.id, provider: config.provider, model: option.modelId, effort: null })
                .then(focusComposer)
            }}
          />
        </div>
      ),
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `chat` is a fresh object each render; its methods are stable per conversation
  }, [columnPickerFor, providerConfigs, catalogs, favorites, recents, onToggleFavorite, onModelUsed, messages])

  async function applySuggestions(primaryId: string, reviewId: string) {
    const primary = messageById(primaryId)
    const review = messageById(reviewId)
    if (!primary || !review) return
    const target = targetForMessage(primary)
    if (!target) {
      setAttachError('The model that wrote this answer is no longer configured, so it cannot revise it.')
      return
    }
    void scrollToBottom('instant')
    await chat.applySuggestions(primary, review, target)
    focusComposer()
  }

  async function retryReview(primaryId: string) {
    const primary = messageById(primaryId)
    if (!primary?.replyGroupId) return
    const failedReview = messages.find(
      (m) => m.replyGroupId === primary.replyGroupId && m.roleLabel === 'review' && m.status !== 'complete',
    )
    const reviewer = failedReview ? targetForMessage(failedReview) : null
    if (!reviewer) {
      setAttachError('The reviewer is no longer configured — send a new review instead.')
      return
    }
    void scrollToBottom('instant')
    await chat.retryReview(primary, reviewer)
    focusComposer()
  }


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
              live={live}
              modelName={modelName}
              error={error}
              busy={sending}
              onRegenerate={() => providerConfigId && model && void runRegenerate(providerConfigId, model, effort)}
              onOpenRegeneratePicker={() => setRegenPickerOpen((v) => !v)}
              regeneratePicker={regeneratePicker}
              onChoose={(messageId) => void chat.chooseReply(messageId)}
              onRetryColumn={(messageId) => void retryColumn(messageId)}
              onSwitchColumn={(messageId) => setColumnPickerFor((current) => (current === messageId ? null : messageId))}
              columnPicker={columnPicker}
              onCancelColumn={chat.cancelColumn}
              onStop={cancel}
              onApplySuggestions={(primaryId, reviewId) => void applySuggestions(primaryId, reviewId)}
              onRetryReview={(primaryId) => void retryReview(primaryId)}
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
            className={`composer${dropActive ? ' is-drop-target' : ''}`}
            onSubmit={(e) => {
              e.preventDefault()
              void handleSend()
            }}
            onDragOver={(e) => {
              if (sending || !e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDropActive(true)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
            }}
            onDrop={(e) => {
              e.preventDefault()
              setDropActive(false)
              if (sending) return
              const files = Array.from(e.dataTransfer.files)
              if (files.length > 0) void handleDroppedFiles(files)
            }}
          >
            {dropActive && <div className="composer__drop-hint">drop files to attach</div>}
            {(pendingAttachments.length > 0 || selectedFilePaths.length > 0) && (
              <div className="activity-rows composer__attachments">
                {pendingAttachments.map((a) => (
                  <div className="activity-row" key={a.filename}>
                    <span className="activity-row__icon">
                      <PaperclipIcon />
                    </span>
                    <span className="activity-row__title">{a.filename}</span>
                    <span className="activity-row__subtitle">attachment · {formatFileSize(a.sizeBytes)}</span>
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
              placeholder={PLACEHOLDERS[mode]}
              disabled={sending}
            />

            <ModeControls
              config={modeConfig}
              onChange={setModeConfig}
              configs={providerConfigs}
              catalogs={catalogs}
              favorites={favorites}
              recents={recents}
              onToggleFavorite={onToggleFavorite}
              primaryLabel={primaryLabel}
              autoPreference={autoPreference}
              onAutoPreferenceChange={onAutoPreferenceChange}
              problem={problem}
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
                  title="attach files (or drop them here) or add a workspace file"
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
                        void handleAttachFiles()
                      }}
                    >
                      attach files…
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

              <div className={`composer__model${modeIsIdleForModelChip ? ' is-idle' : ''}`} title={modeIsIdleForModelChip ? `not used in ${mode} mode` : undefined}>
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
              </div>

              <ModeChip mode={mode} onChange={changeMode} disabled={sending} openSignal={modeMenuSignal} />

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
                  disabled={!draft.trim() || !!problem}
                  aria-label="Send message"
                  title={problem ?? undefined}
                >
                  {SEND_LABELS[mode]}
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
