import { lazy, Suspense, useEffect, useRef, useState, type RefObject } from 'react'
import { MAX_ATTACHMENT_BYTES, type PendingAttachment } from '@ai-workspace/shared'
import type { CodeWorkspace, EditorApi } from '../../hooks/useCodeWorkspace'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { ResizeHandle } from '../shell/ResizeHandle'
import { FileTree } from './FileTree'
import { EditorTabs } from './EditorTabs'
import { SearchPanel, type SearchPanelHandle } from './SearchPanel'
import { baseName } from '../../lib/code/paths'
import type { CursorInfo } from './CodeEditor'

const CodeEditor = lazy(() => import('./CodeEditor'))

interface Props {
  workspaceId: string
  rootPath: string | null
  indexing: boolean
  onPickFolder: () => void
  code: CodeWorkspace
  /** The Monaco host's imperative API (also given to `useCodeWorkspace`). */
  editorRef: RefObject<EditorApi | null>
  /** relative path -> git marker letter. */
  gitMarkers: ReadonlyMap<string, string>
  treeRefreshKey: number
  onRefreshTree: () => void
  onQuickOpen: () => void
  /** Bump to switch the explorer to search and focus its input. */
  searchSignal: number
  /** Current buffer or selection -> the chat's pending attachments. */
  onAddAttachment: (attachment: PendingAttachment) => void
  /** Too big to attach whole: reference the indexed file instead. */
  onAddFilePath: (path: string) => void
}

const encoder = new TextEncoder()

function revealInFolder(workspaceId: string, path: string): void {
  void window.api.fs.reveal(workspaceId, path).catch(() => undefined)
}

export function CodeView({
  workspaceId,
  rootPath,
  indexing,
  onPickFolder,
  code,
  editorRef,
  gitMarkers,
  treeRefreshKey,
  onRefreshTree,
  onQuickOpen,
  searchSignal,
  onAddAttachment,
  onAddFilePath,
}: Props) {
  const explorer = useResizablePanel({ direction: 'horizontal', initialSize: 264, min: 180, max: 520 })
  const [mode, setMode] = useState<'files' | 'search'>('files')
  const [cursor, setCursor] = useState<CursorInfo | null>(null)
  const [hasSelection, setHasSelection] = useState(false)
  const [contextNote, setContextNote] = useState<string | null>(null)
  const searchRef = useRef<SearchPanelHandle>(null)

  useEffect(() => {
    if (searchSignal === 0) return
    setMode('search')
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [searchSignal])

  useEffect(() => {
    if (!contextNote) return
    const timer = setTimeout(() => setContextNote(null), 3500)
    return () => clearTimeout(timer)
  }, [contextNote])

  if (!rootPath) {
    return (
      <div className="code-view code-view--empty">
        <div className="empty-state">
          <p className="empty-state__title">No folder chosen for this workspace</p>
          <p className="empty-state__hint">
            Pick the repository folder to browse and edit it here, search it, run a terminal in it and review its git changes. Secrets
            (.env*, keys, .git/) are never opened.
          </p>
          <button type="button" className="link-action link-action--large" onClick={onPickFolder} disabled={indexing}>
            {indexing ? '[indexing…]' : '[choose a folder]'}
          </button>
        </div>
      </div>
    )
  }

  const activePath = code.active
  const activeDoc = activePath ? code.docs[activePath] : undefined
  const ready = activeDoc?.status === 'ready' ? activeDoc : null

  function addFileToContext(): void {
    if (!activePath || !ready) return
    const text = editorRef.current?.getValue(activePath) ?? ready.content
    const size = encoder.encode(text).length
    if (size <= MAX_ATTACHMENT_BYTES) {
      onAddAttachment({ filename: activePath, mimeType: 'text/plain', sizeBytes: size, content: text })
      setContextNote(`added ${baseName(activePath)}${ready.dirty ? ' (with unsaved edits)' : ''} to the chat context`)
    } else {
      onAddFilePath(activePath)
      setContextNote(`${baseName(activePath)} is large - added by reference (the indexed copy)`)
    }
  }

  function addSelectionToContext(): void {
    const selection = editorRef.current?.getSelection()
    if (!selection) return
    const size = encoder.encode(selection.text).length
    if (size > MAX_ATTACHMENT_BYTES) {
      setContextNote('that selection is too large to attach (512 KB max)')
      return
    }
    const range = selection.startLine === selection.endLine ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`
    onAddAttachment({ filename: `${selection.path}:${range}`, mimeType: 'text/plain', sizeBytes: size, content: selection.text })
    setContextNote(`added lines ${range} of ${baseName(selection.path)} to the chat context`)
  }

  const closing = code.closing
  const closingDoc = closing ? code.docs[closing] : undefined

  return (
    <div className="code-view">
      <aside className="code-view__explorer" style={{ width: explorer.size }}>
        <div className="explorer__header">
          <div className="segmented explorer__mode" role="tablist" aria-label="Explorer view">
            <button type="button" role="tab" aria-selected={mode === 'files'} className={mode === 'files' ? 'is-active' : ''} onClick={() => setMode('files')}>
              files
            </button>
            <button type="button" role="tab" aria-selected={mode === 'search'} className={mode === 'search' ? 'is-active' : ''} onClick={() => setMode('search')}>
              search
            </button>
          </div>
          <button type="button" className="link-action explorer__refresh" onClick={onRefreshTree} title="reload the file tree">
            [refresh]
          </button>
        </div>
        <div className="explorer__body">
          {mode === 'files' ? (
            <FileTree workspaceId={workspaceId} refreshKey={treeRefreshKey} activePath={activePath} markers={gitMarkers} onOpen={(p) => code.open(p)} />
          ) : (
            <SearchPanel ref={searchRef} workspaceId={workspaceId} onOpen={(p, pos) => code.open(p, pos)} />
          )}
        </div>
        <div className="explorer__footer" title={rootPath}>
          <span className="explorer__root">{rootPath}</span>
          <button type="button" className="link-action" onClick={onPickFolder} disabled={indexing}>
            [change]
          </button>
        </div>
      </aside>
      <ResizeHandle onMouseDown={explorer.onMouseDown} dragging={explorer.dragging} ariaLabel="Resize explorer" />

      <section className="code-view__editor">
        <div className="editor-header">
          <EditorTabs tabs={code.tabs} active={activePath} docs={code.docs} onActivate={code.activate} onClose={code.requestClose} />
          <button type="button" className="link-action editor-header__open" onClick={onQuickOpen} title="open a file by name">
            [open file] <kbd>Ctrl P</kbd>
          </button>
        </div>

        {closing && closingDoc?.status === 'ready' && (
          <div className="strip strip--warn" role="alert">
            <span>
              <strong>{baseName(closing)}</strong> has unsaved changes.
            </span>
            <button type="button" className="link-action" onClick={() => void code.confirmClose('save')}>
              [save &amp; close]
            </button>
            <button type="button" className="link-action link-action--danger" onClick={() => void code.confirmClose('discard')}>
              [discard]
            </button>
            <button type="button" className="link-action" onClick={() => void code.confirmClose('cancel')}>
              [keep editing]
            </button>
          </div>
        )}

        {ready?.conflict && activePath && (
          <div className="strip strip--warn" role="alert">
            <span>
              {ready.conflict === 'deleted'
                ? 'This file was deleted on disk.'
                : ready.conflict === 'exists'
                  ? 'A file with this name already exists on disk.'
                  : 'This file changed on disk since you opened it.'}
            </span>
            <button type="button" className="link-action" onClick={() => void code.resolveConflict(activePath, 'overwrite')}>
              [{ready.conflict === 'deleted' ? 'recreate it with my version' : 'overwrite with my version'}]
            </button>
            {ready.conflict !== 'deleted' && (
              <button type="button" className="link-action" onClick={() => void code.resolveConflict(activePath, 'reload')}>
                [reload from disk]
              </button>
            )}
            <button type="button" className="link-action" onClick={() => void code.resolveConflict(activePath, 'dismiss')}>
              [dismiss]
            </button>
          </div>
        )}

        {ready?.saveError && activePath && (
          <div className="strip strip--error" role="alert">
            <span className="signal">Could not save: {ready.saveError}</span>
            <button type="button" className="link-action" onClick={() => void code.save(activePath)}>
              [retry]
            </button>
          </div>
        )}

        <div className="code-view__surface">
          <div className="code-view__monaco" hidden={!ready}>
            <Suspense fallback={<p className="muted code-editor__loading">loading editor…</p>}>
              <CodeEditor
                ref={editorRef}
                docs={code.docs}
                activePath={activePath}
                reveal={code.reveal}
                onDirtyChange={code.setDirty}
                onCursor={setCursor}
                onSelectionChange={setHasSelection}
              />
            </Suspense>
          </div>

          {!ready && (
            <div className="code-view__overlay">
              {!activePath && (
                <div className="empty-state">
                  <p className="empty-state__title">No file open</p>
                  <p className="empty-state__hint">
                    Open a file from the tree, or press <kbd>Ctrl P</kbd> to find one by name and <kbd>Ctrl Shift F</kbd> to search inside files.
                  </p>
                  <button type="button" className="link-action link-action--large" onClick={onQuickOpen}>
                    [open file…]
                  </button>
                </div>
              )}
              {activePath && (!activeDoc || activeDoc.status === 'loading') && <p className="muted">loading {baseName(activePath)}…</p>}
              {activePath && activeDoc?.status === 'unavailable' && (
                <div className="empty-state">
                  <p className="empty-state__title">{unavailableTitle(activeDoc.reason)}</p>
                  <p className="empty-state__hint">{activeDoc.message}</p>
                  <p className="empty-state__hint muted">{activePath}</p>
                  {(activeDoc.reason === 'binary' || activeDoc.reason === 'too-large') && (
                    <button type="button" className="link-action link-action--large" onClick={() => revealInFolder(workspaceId, activePath)}>
                      [reveal in folder]
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="status-bar" role="status">
          {ready && cursor ? (
            <>
              <span>
                Ln {cursor.line}, Col {cursor.column}
                {cursor.selectedChars > 0 ? ` (${cursor.selectedChars} selected)` : ''}
              </span>
              <span className="muted">UTF-8{ready.bom ? ' BOM' : ''}</span>
              <span className="muted">{cursor.eol}</span>
              <span className="muted">{cursor.language}</span>
            </>
          ) : (
            <span className="muted">{activePath ? baseName(activePath) : 'no file open'}</span>
          )}
          {ready?.readOnly && (
            <span className="chip chip--outline" title={ready.readOnlyReason ?? 'read-only'}>
              read-only
            </span>
          )}
          {ready?.saving && <span className="muted">saving…</span>}
          <span className="status-bar__spacer" />
          {contextNote && <span className="status-bar__note">{contextNote}</span>}
          {ready && (
            <>
              <button type="button" className="link-action" onClick={addFileToContext} title="send this file's current text to the chat context">
                [+ file to chat]
              </button>
              <button type="button" className="link-action" onClick={addSelectionToContext} disabled={!hasSelection} title="send the selected lines to the chat context">
                [+ selection to chat]
              </button>
              {!ready.readOnly && (
                <button type="button" className="link-action" onClick={() => activePath && void code.save(activePath)} disabled={!ready.dirty || ready.saving}>
                  [save] <kbd>Ctrl S</kbd>
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  )
}

function unavailableTitle(reason: string): string {
  switch (reason) {
    case 'binary':
      return 'Binary file'
    case 'too-large':
      return 'File too large'
    case 'denied':
      return 'Protected file'
    case 'missing':
      return 'File not found'
    case 'not-a-file':
      return 'Not a file'
    default:
      return 'Could not open this file'
  }
}
