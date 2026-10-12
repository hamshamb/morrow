import { useEffect, useRef, useState } from 'react'
import type * as MonacoNs from 'monaco-editor/editor/editor.api.js'
import { loadMonaco, type MonacoApi } from '../../lib/monaco/loader'

interface Props {
  /** Workspace-relative path - only used to pick the language from its extension. */
  path: string
  original: string
  modified: string
  /** false = side by side, true = inline (unified). */
  inline: boolean
}

/**
 * Read-only Monaco diff editor (lazy, like the code editor). Both sides arrive
 * as text from the main process (HEAD / index / working tree), so no unified
 * diff text is parsed anywhere; Monaco computes the change blocks itself.
 */
export default function DiffViewer({ path, original, modified, inline }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [monaco, setMonaco] = useState<MonacoApi | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const editorRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(null)

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

  useEffect(() => {
    if (!monaco || !containerRef.current) return
    const editor = monaco.editor.createDiffEditor(containerRef.current, {
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      enableSplitViewResizing: true,
      useInlineViewWhenSpaceIsLimited: false,
      hideUnchangedRegions: { enabled: true, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 20 },
      fontFamily: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      padding: { top: 8, bottom: 8 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      theme: 'nochan',
    })
    editorRef.current = editor
    return () => {
      editor.setModel(null)
      editor.dispose()
      editorRef.current = null
    }
  }, [monaco])

  useEffect(() => {
    editorRef.current?.updateOptions({ renderSideBySide: !inline })
  }, [inline, monaco])

  useEffect(() => {
    const editor = editorRef.current
    if (!monaco || !editor) return
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const originalModel = monaco.editor.createModel(original, undefined, monaco.Uri.from({ scheme: 'diff-original', path: `/${path}`, query: stamp }))
    const modifiedModel = monaco.editor.createModel(modified, originalModel.getLanguageId(), monaco.Uri.from({ scheme: 'diff-modified', path: `/${path}`, query: stamp }))
    editor.setModel({ original: originalModel, modified: modifiedModel })
    return () => {
      editor.setModel(null)
      originalModel.dispose()
      modifiedModel.dispose()
    }
  }, [monaco, path, original, modified])

  if (failure) {
    return (
      <div className="empty-state diff-viewer__empty">
        <p className="empty-state__title">The diff editor could not be loaded</p>
        <p className="empty-state__hint">{failure}</p>
      </div>
    )
  }
  return (
    <div className="diff-viewer">
      <div ref={containerRef} className="diff-viewer__surface" />
      {!monaco && <p className="muted code-editor__loading">loading diff editor…</p>}
    </div>
  )
}
