import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { CodeSession, FsReadResult } from '@ai-workspace/shared'
import { EMPTY_TABS, closeTab, cycleTab, openTab, sanitizeSession, type TabsState } from '../lib/code/tabs'
import { ipcErrorMessage } from '../lib/code/paths'

/** What the Monaco host exposes to the workspace logic (the host is a lazily-loaded chunk). */
export interface EditorApi {
  /** Current text of an open model, or null if the model doesn't exist. */
  getValue(path: string): string | null
  /** Monotonic edit counter (Monaco's alternative version id) for dirty tracking. */
  getVersion(path: string): number | null
  /** Records `version` as the saved baseline; the file is dirty again if edited past it. */
  markSaved(path: string, version: number): void
  /** The non-empty selection of the focused model, if any. */
  getSelection(): { path: string; text: string; startLine: number; endLine: number } | null
  focus(): void
}

export interface ReadyDoc {
  status: 'ready'
  path: string
  content: string
  hash: string
  bom: boolean
  readOnly: boolean
  readOnlyReason: string | null
  dirty: boolean
  saving: boolean
  /** Set when the file differs on disk from what this tab opened. */
  conflict: 'changed' | 'deleted' | 'exists' | null
  saveError: string | null
  /** Bumped when the model must be re-created from `content` (reload from disk). */
  version: number
}

export type Doc =
  | { status: 'loading'; path: string }
  | ReadyDoc
  | { status: 'unavailable'; path: string; reason: Exclude<FsReadResult['status'], 'ok'> | 'error'; message: string; sizeBytes: number | null }

export interface RevealRequest {
  path: string
  line: number
  column: number
  nonce: number
}

interface Options {
  /** Owned by the caller (and handed to the editor host) so reading it never counts as render-time ref access. */
  editorRef: RefObject<EditorApi | null>
  workspaceId: string | null
  /** The workspace has a folder; nothing is read until it does. */
  hasRoot: boolean
  /** Saved tabs for this workspace: undefined = settings not loaded yet, null = none. */
  restore: CodeSession | null | undefined
  onSessionChange: (workspaceId: string, session: CodeSession) => void
  /** A file was written - callers refresh git status and the path cache. */
  onFilesChanged: () => void
  log: (level: 'info' | 'error', text: string) => void
}

const SESSION_DEBOUNCE_MS = 400

/**
 * Single owner of the editor's open files (tabs, per-file state, save,
 * conflicts, close-confirm). The text of an open file lives in Monaco's model,
 * not in React state - `editorRef` reads it back on save - so typing never
 * re-renders this tree.
 */
export function useCodeWorkspace({ editorRef, workspaceId, hasRoot, restore, onSessionChange, onFilesChanged, log }: Options) {
  const [tabsState, setTabsState] = useState<TabsState>(EMPTY_TABS)
  const [docs, setDocs] = useState<Record<string, Doc>>({})
  const [closing, setClosing] = useState<string | null>(null)
  const [reveal, setReveal] = useState<RevealRequest | null>(null)
  const docsRef = useRef(docs)
  const tabsRef = useRef(tabsState)
  const nonce = useRef(0)
  const restoredFor = useRef<string | null>(null)
  const workspaceRef = useRef(workspaceId)

  useEffect(() => {
    docsRef.current = docs
  }, [docs])
  useEffect(() => {
    tabsRef.current = tabsState
  }, [tabsState])
  useEffect(() => {
    workspaceRef.current = workspaceId
  }, [workspaceId])

  const patch = useCallback((path: string, update: (doc: ReadyDoc) => ReadyDoc) => {
    setDocs((prev) => {
      const doc = prev[path]
      return doc?.status === 'ready' ? { ...prev, [path]: update(doc) } : prev
    })
  }, [])

  const load = useCallback(
    async (path: string): Promise<void> => {
      const id = workspaceRef.current
      if (!id) return
      setDocs((prev) => ({ ...prev, [path]: { status: 'loading', path } }))
      let doc: Doc
      try {
        const result = await window.api.fs.readFile({ workspaceId: id, relativePath: path })
        if (workspaceRef.current !== id) return
        doc =
          result.status === 'ok'
            ? {
                status: 'ready',
                path,
                content: result.content,
                hash: result.hash,
                bom: result.bom,
                readOnly: result.readOnly,
                readOnlyReason: result.readOnlyReason,
                dirty: false,
                saving: false,
                conflict: null,
                saveError: null,
                version: 0,
              }
            : { status: 'unavailable', path, reason: result.status, message: result.message, sizeBytes: result.sizeBytes }
      } catch (err) {
        doc = { status: 'unavailable', path, reason: 'error', message: ipcErrorMessage(err), sizeBytes: null }
      }
      setDocs((prev) => (path in prev ? { ...prev, [path]: doc } : prev))
    },
    [],
  )

  // Reset when the workspace changes; restore its saved tabs once settings are in.
  useEffect(() => {
    setTabsState(EMPTY_TABS)
    setDocs({})
    setClosing(null)
    setReveal(null)
    restoredFor.current = null
  }, [workspaceId])

  useEffect(() => {
    if (!workspaceId || !hasRoot || restore === undefined || restoredFor.current === workspaceId) return
    restoredFor.current = workspaceId
    if (!restore) return
    const next = sanitizeSession(restore.openTabs, restore.activeTab)
    setTabsState(next)
    // Only the active tab is read now; the others load when first activated.
    if (next.active) void load(next.active)
  }, [workspaceId, hasRoot, restore, load])

  // Persist the tab set (debounced) once the initial restore has happened.
  useEffect(() => {
    if (!workspaceId || restoredFor.current !== workspaceId) return
    const timer = setTimeout(() => {
      onSessionChange(workspaceId, { openTabs: tabsState.tabs.slice(0, 30), activeTab: tabsState.active })
    }, SESSION_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [workspaceId, tabsState, onSessionChange])

  const activate = useCallback(
    (path: string) => {
      setTabsState((s) => (s.tabs.includes(path) ? { ...s, active: path } : s))
      const doc = docsRef.current[path]
      if (!doc) void load(path)
    },
    [load],
  )

  const open = useCallback(
    (path: string, position?: { line: number; column?: number }) => {
      setTabsState((s) => openTab(s, path))
      const doc = docsRef.current[path]
      if (!doc || doc.status === 'unavailable') void load(path)
      if (position) {
        nonce.current += 1
        setReveal({ path, line: position.line, column: position.column ?? 1, nonce: nonce.current })
      }
    },
    [load],
  )

  const forget = useCallback((path: string) => {
    setTabsState((s) => closeTab(s, path))
    setDocs((prev) => {
      const rest = { ...prev }
      delete rest[path]
      return rest
    })
    setClosing((c) => (c === path ? null : c))
  }, [])

  /** Close button / Ctrl+W: closes at once if clean, else asks inline first. */
  const requestClose = useCallback(
    (path: string) => {
      const doc = docsRef.current[path]
      if (doc?.status === 'ready' && doc.dirty) {
        setTabsState((s) => ({ ...s, active: path }))
        setClosing(path)
        return
      }
      forget(path)
    },
    [forget],
  )

  const writeFile = useCallback(
    async (path: string, overwrite: boolean): Promise<boolean> => {
      const id = workspaceRef.current
      const doc = docsRef.current[path]
      const editor = editorRef.current
      if (!id || doc?.status !== 'ready' || doc.readOnly || doc.saving || !editor) return false
      const text = editor.getValue(path)
      const version = editor.getVersion(path)
      if (text === null || version === null) return false
      patch(path, (d) => ({ ...d, saving: true, saveError: null }))
      try {
        const result = await window.api.fs.writeFile({
          workspaceId: id,
          relativePath: path,
          content: text,
          expectedHash: doc.hash,
          bom: doc.bom,
          ...(overwrite ? { overwrite: true } : {}),
        })
        if (result.status === 'conflict') {
          patch(path, (d) => ({ ...d, saving: false, conflict: result.reason }))
          return false
        }
        editor.markSaved(path, version)
        patch(path, (d) => ({ ...d, saving: false, hash: result.hash, conflict: null, saveError: null }))
        log('info', `saved ${path}`)
        onFilesChanged()
        return true
      } catch (err) {
        const message = ipcErrorMessage(err)
        patch(path, (d) => ({ ...d, saving: false, saveError: message }))
        log('error', `could not save ${path}: ${message}`)
        return false
      }
    },
    [editorRef, log, onFilesChanged, patch],
  )

  const save = useCallback((path?: string) => writeFile(path ?? tabsRef.current.active ?? '', false), [writeFile])

  /** Conflict prompt: keep my version (overwrite) or take the disk version. */
  const resolveConflict = useCallback(
    async (path: string, choice: 'overwrite' | 'reload' | 'dismiss') => {
      if (choice === 'dismiss') {
        patch(path, (d) => ({ ...d, conflict: null }))
        return
      }
      if (choice === 'overwrite') {
        await writeFile(path, true)
        return
      }
      await load(path)
    },
    [load, patch, writeFile],
  )

  const confirmClose = useCallback(
    async (choice: 'save' | 'discard' | 'cancel') => {
      const path = closing
      if (!path) return
      if (choice === 'cancel') {
        setClosing(null)
        return
      }
      if (choice === 'save') {
        const saved = await writeFile(path, false)
        if (!saved) return // conflict / error strip shows; keep the tab
      }
      forget(path)
    },
    [closing, forget, writeFile],
  )

  const setDirty = useCallback(
    (path: string, dirty: boolean) => {
      patch(path, (d) => (d.dirty === dirty ? d : { ...d, dirty }))
    },
    [patch],
  )

  /**
   * Re-reads open files (window focus, after a terminal / git action): a clean
   * tab silently takes the new disk content; a tab with unsaved edits is flagged
   * so the conflict prompt shows before the user trips over it on save.
   */
  const refreshFromDisk = useCallback(async () => {
    const id = workspaceRef.current
    if (!id) return
    for (const doc of Object.values(docsRef.current)) {
      if (doc.status !== 'ready' || doc.saving) continue
      try {
        const result = await window.api.fs.readFile({ workspaceId: id, relativePath: doc.path })
        if (workspaceRef.current !== id) return
        const current = docsRef.current[doc.path]
        if (current?.status !== 'ready') continue
        if (result.status === 'ok' && result.hash === current.hash) continue
        if (!current.dirty) {
          if (result.status === 'ok') {
            patch(doc.path, (d) => ({ ...d, content: result.content, hash: result.hash, bom: result.bom, version: d.version + 1, conflict: null }))
          } else if (result.status === 'missing') {
            patch(doc.path, (d) => ({ ...d, conflict: 'deleted' }))
          }
        } else {
          patch(doc.path, (d) => ({ ...d, conflict: result.status === 'missing' ? 'deleted' : 'changed' }))
        }
      } catch {
        // A transient read failure is not worth a banner; the next focus retries.
      }
    }
  }, [patch])

  const cycle = useCallback(
    (direction: 1 | -1) => {
      const next = cycleTab(tabsRef.current, direction)
      if (next.active && next.active !== tabsRef.current.active) activate(next.active)
    },
    [activate],
  )

  const dirtyPaths = useMemo(
    () => Object.values(docs).flatMap((d) => (d.status === 'ready' && d.dirty ? [d.path] : [])),
    [docs],
  )

  return {
    tabs: tabsState.tabs,
    active: tabsState.active,
    docs,
    closing,
    reveal,
    dirtyPaths,
    open,
    activate,
    requestClose,
    confirmClose,
    save,
    resolveConflict,
    setDirty,
    refreshFromDisk,
    cycle,
  }
}

export type CodeWorkspace = ReturnType<typeof useCodeWorkspace>
