import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type * as MonacoNs from 'monaco-editor/editor/editor.api.js'
import { loadMonaco, type MonacoApi } from '../../lib/monaco/loader'
import type { Doc, EditorApi, RevealRequest } from '../../hooks/useCodeWorkspace'

export interface CursorInfo {
  line: number
  column: number
  selectedChars: number
  language: string
  eol: 'LF' | 'CRLF'
}

interface Props {
  docs: Record<string, Doc>
  activePath: string | null
  reveal: RevealRequest | null
  onDirtyChange: (path: string, dirty: boolean) => void
  onCursor: (info: CursorInfo) => void
  onSelectionChange: (hasSelection: boolean) => void
}

interface ModelEntry {
  model: MonacoNs.editor.ITextModel
  docVersion: number
  savedVersion: number
  dirty: boolean
  subscription: MonacoNs.IDisposable
}

/**
 * The Monaco host. Loaded lazily (`React.lazy` in CodeView, and `loadMonaco`
 * is itself a dynamic import), so chat startup never pays for it. One model per
 * open file keeps undo history across tab switches; the model - not React
 * state - owns the text while it is being edited, and exposes it to the
 * workspace logic through the imperative `EditorApi`.
 */
const CodeEditor = forwardRef<EditorApi, Props>(function CodeEditor(
  { docs, activePath, reveal, onDirtyChange, onCursor, onSelectionChange },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [monaco, setMonaco] = useState<MonacoApi | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null)
  const entries = useRef(new Map<string, ModelEntry>())
  const viewStates = useRef(new Map<string, MonacoNs.editor.ICodeEditorViewState | null>())
  const shownPath = useRef<string | null>(null)
  const [modelRev, setModelRev] = useState(0)
  const callbacks = useRef({ onDirtyChange, onCursor, onSelectionChange })

  useEffect(() => {
    callbacks.current = { onDirtyChange, onCursor, onSelectionChange }
  })

  useEffect(() => {
    let cancelled = false
    loadMonaco().then(
      (m) => {
        if (!cancelled) setMonaco(m)
      },
      (err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  useImperativeHandle(
    ref,
    (): EditorApi => ({
      getValue: (path) => entries.current.get(path)?.model.getValue() ?? null,
      getVersion: (path) => entries.current.get(path)?.model.getAlternativeVersionId() ?? null,
      markSaved: (path, version) => {
        const entry = entries.current.get(path)
        if (!entry) return
        entry.savedVersion = version
        const dirty = entry.model.getAlternativeVersionId() !== entry.savedVersion
        if (dirty !== entry.dirty) {
          entry.dirty = dirty
          callbacks.current.onDirtyChange(path, dirty)
        }
      },
      getSelection: () => {
        const editor = editorRef.current
        const model = editor?.getModel()
        const selection = editor?.getSelection()
        if (!editor || !model || !selection || selection.isEmpty() || shownPath.current === null) return null
        return {
          path: shownPath.current,
          text: model.getValueInRange(selection),
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
        }
      },
      focus: () => editorRef.current?.focus(),
    }),
    [],
  )

  // Create the editor once Monaco has loaded.
  useEffect(() => {
    if (!monaco || !containerRef.current) return
    const editor = monaco.editor.create(containerRef.current, {
      model: null,
      automaticLayout: true,
      minimap: { enabled: false },
      fontFamily: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      fontLigatures: false,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'line',
      cursorBlinking: 'solid',
      padding: { top: 8, bottom: 8 },
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      overviewRulerBorder: false,
      hideCursorInOverviewRuler: true,
      renderWhitespace: 'selection',
      guides: { indentation: true, bracketPairs: false },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      stickyScroll: { enabled: false },
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      contextmenu: true,
      accessibilitySupport: 'auto',
      ariaLabel: 'Code editor',
      theme: 'nochan',
    })
    editorRef.current = editor
    const reportCursor = (): void => {
      const model = editor.getModel()
      const position = editor.getPosition()
      if (!model || !position) return
      const selection = editor.getSelection()
      callbacks.current.onCursor({
        line: position.lineNumber,
        column: position.column,
        selectedChars: selection && !selection.isEmpty() ? model.getValueInRange(selection).length : 0,
        language: model.getLanguageId(),
        eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
      })
      callbacks.current.onSelectionChange(!!selection && !selection.isEmpty())
    }
    const subs = [editor.onDidChangeCursorSelection(reportCursor), editor.onDidChangeModel(reportCursor)]
    const modelEntries = entries.current
    return () => {
      for (const sub of subs) sub.dispose()
      editor.dispose()
      editorRef.current = null
      for (const entry of modelEntries.values()) {
        entry.subscription.dispose()
        entry.model.dispose()
      }
      modelEntries.clear()
    }
  }, [monaco])

  // Keep one model per ready doc; rebuild when the doc was reloaded from disk.
  useEffect(() => {
    if (!monaco) return
    let changed = false
    for (const [path, entry] of entries.current) {
      const doc = docs[path]
      if (doc?.status !== 'ready' || doc.version !== entry.docVersion) {
        if (shownPath.current === path) viewStates.current.set(path, editorRef.current?.saveViewState() ?? null)
        entry.subscription.dispose()
        entry.model.dispose()
        entries.current.delete(path)
        if (doc?.status !== 'ready') viewStates.current.delete(path)
        if (shownPath.current === path) shownPath.current = null
        changed = true
      }
    }
    for (const doc of Object.values(docs)) {
      if (doc.status !== 'ready' || entries.current.has(doc.path)) continue
      const uri = monaco.Uri.from({ scheme: 'file', path: `/${doc.path}` })
      monaco.editor.getModel(uri)?.dispose()
      const model = monaco.editor.createModel(doc.content, undefined, uri)
      const entry: ModelEntry = {
        model,
        docVersion: doc.version,
        savedVersion: model.getAlternativeVersionId(),
        dirty: false,
        subscription: { dispose: () => undefined },
      }
      const path = doc.path
      entry.subscription = model.onDidChangeContent(() => {
        const dirty = model.getAlternativeVersionId() !== entry.savedVersion
        if (dirty !== entry.dirty) {
          entry.dirty = dirty
          callbacks.current.onDirtyChange(path, dirty)
        }
      })
      entries.current.set(path, entry)
      callbacks.current.onDirtyChange(path, false)
      changed = true
    }
    if (changed) setModelRev((r) => r + 1)
  }, [monaco, docs])

  // Show the active file's model.
  useEffect(() => {
    const editor = editorRef.current
    if (!monaco || !editor) return
    const doc = activePath ? docs[activePath] : undefined
    const entry = activePath ? entries.current.get(activePath) : undefined
    if (shownPath.current && shownPath.current !== activePath) {
      viewStates.current.set(shownPath.current, editor.saveViewState())
    }
    if (!activePath || !entry || doc?.status !== 'ready') {
      if (shownPath.current !== null) editor.setModel(null)
      shownPath.current = null
      return
    }
    if (shownPath.current !== activePath || editor.getModel() !== entry.model) {
      editor.setModel(entry.model)
      shownPath.current = activePath
      const state = viewStates.current.get(activePath)
      if (state) editor.restoreViewState(state)
      editor.focus()
    }
    editor.updateOptions({
      readOnly: doc.readOnly,
      ...(doc.readOnly ? { readOnlyMessage: { value: doc.readOnlyReason ?? 'This file is read-only' } } : {}),
    })
  }, [monaco, activePath, docs, modelRev])

  // Jump to a requested position (search result, command).
  useEffect(() => {
    const editor = editorRef.current
    if (!reveal || !editor || reveal.path !== activePath || shownPath.current !== reveal.path) return
    const position = { lineNumber: reveal.line, column: reveal.column }
    editor.setPosition(position)
    editor.revealPositionInCenter(position)
    editor.focus()
  }, [reveal, activePath, modelRev])

  if (failure) {
    return (
      <div className="empty-state code-editor__loading">
        <p className="empty-state__title">The editor could not be loaded</p>
        <p className="empty-state__hint">{failure}</p>
      </div>
    )
  }
  return (
    <div className="code-editor">
      <div ref={containerRef} className="code-editor__surface" />
      {!monaco && <p className="muted code-editor__loading">loading editor…</p>}
    </div>
  )
})

export default CodeEditor
