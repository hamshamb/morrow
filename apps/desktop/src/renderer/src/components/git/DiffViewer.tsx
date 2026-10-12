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

const FONT = "'IBM Plex Mono', ui-monospace, Consolas, monospace"

function useMonaco(): { monaco: MonacoApi | null; failure: string | null } {
  const [monaco, setMonaco] = useState<MonacoApi | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
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
  return { monaco, failure }
}

/**
 * Read-only Monaco diff editor (lazy, like the code editor). Both sides arrive
 * as text from the main process (HEAD / index / working tree), so no unified
 * diff text is parsed anywhere; Monaco computes the change blocks itself.
 *
 * A file that is wholly new or wholly deleted has nothing to compare against -
 * Monaco would draw the empty side as one phantom removed line - so those are
 * shown as a single read-only listing with every line tinted as added/removed.
 */
export default function DiffViewer(props: Props) {
  if (props.original === '' && props.modified !== '') return <WholeFileView path={props.path} text={props.modified} kind="added" />
  if (props.modified === '' && props.original !== '') return <WholeFileView path={props.path} text={props.original} kind="removed" />
  return <TwoSidedDiff {...props} />
}

function TwoSidedDiff({ path, original, modified, inline }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { monaco, failure } = useMonaco()
  const editorRef = useRef<MonacoNs.editor.IStandaloneDiffEditor | null>(null)

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
      fontFamily: FONT,
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

  if (failure) return <FailureNote what="diff editor" message={failure} />
  return (
    <div className="diff-viewer">
      <div ref={containerRef} className="diff-viewer__surface" />
      {!monaco && <p className="muted code-editor__loading">loading diff editor…</p>}
    </div>
  )
}

function WholeFileView({ path, text, kind }: { path: string; text: string; kind: 'added' | 'removed' }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const { monaco, failure } = useMonaco()

  useEffect(() => {
    if (!monaco || !containerRef.current) return
    const uri = monaco.Uri.from({ scheme: 'diff-whole', path: `/${path}`, query: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` })
    const model = monaco.editor.createModel(text, undefined, uri)
    const editor = monaco.editor.create(containerRef.current, {
      model,
      automaticLayout: true,
      readOnly: true,
      domReadOnly: true,
      minimap: { enabled: false },
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 20,
      scrollBeyondLastLine: false,
      renderLineHighlight: 'none',
      padding: { top: 8, bottom: 8 },
      lineNumbersMinChars: 3,
      folding: false,
      glyphMargin: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      theme: 'nochan',
    })
    editor.createDecorationsCollection([
      {
        range: new monaco.Range(1, 1, model.getLineCount(), 1),
        options: {
          isWholeLine: true,
          className: kind === 'added' ? 'diff-whole-line diff-whole-line--added' : 'diff-whole-line diff-whole-line--removed',
          linesDecorationsClassName: kind === 'added' ? 'diff-whole-gutter diff-whole-gutter--added' : 'diff-whole-gutter diff-whole-gutter--removed',
        },
      },
    ])
    return () => {
      editor.dispose()
      model.dispose()
    }
  }, [monaco, path, text, kind])

  if (failure) return <FailureNote what="diff editor" message={failure} />
  return (
    <div className="diff-viewer">
      <div ref={containerRef} className="diff-viewer__surface" />
      {!monaco && <p className="muted code-editor__loading">loading diff editor…</p>}
    </div>
  )
}

function FailureNote({ what, message }: { what: string; message: string }) {
  return (
    <div className="empty-state diff-viewer__empty">
      <p className="empty-state__title">The {what} could not be loaded</p>
      <p className="empty-state__hint">{message}</p>
    </div>
  )
}
