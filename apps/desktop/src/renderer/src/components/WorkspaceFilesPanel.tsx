import { useEffect } from 'react'
import type { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'
import { FileIcon } from './icons'

interface Props {
  workspaceFiles: ReturnType<typeof useWorkspaceFiles>
  onClose: () => void
}

/**
 * Pick (or change) a workspace's local folder and browse what got
 * indexed. Excluded files (`.gitignore` + the built-in deny-list — see
 * ARCHITECTURE.md) never appear: they're never written to the index.
 */
export function WorkspaceFilesPanel({ workspaceFiles, onClose }: Props) {
  const { root, files, loading, indexing, error, pickRoot, reindex } = workspaceFiles

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div className="overlay" role="dialog" aria-label="Workspace files" onMouseDown={onClose}>
      <div className="dialog files-panel" onMouseDown={(e) => e.stopPropagation()}>
        <header className="dialog__header">
          <h2 className="dialog__title">Workspace files</h2>
          <button type="button" className="link-action" onClick={onClose}>
            [close] <kbd>esc</kbd>
          </button>
        </header>

        <div className="files-panel__body">
          {root ? (
            <div className="files-panel__root">
              <span className="files-panel__count">{files.length} files indexed</span>
              <span className="muted files-panel__path">{root.rootPath}</span>
              <button type="button" className="link-action" onClick={() => void reindex()} disabled={indexing}>
                {indexing ? '[indexing…]' : '[reindex]'}
              </button>
              <button type="button" className="link-action" onClick={() => void pickRoot()} disabled={indexing}>
                [change folder]
              </button>
            </div>
          ) : (
            <div className="empty-state files-panel__empty">
              <p className="empty-state__title">No folder yet</p>
              <p className="empty-state__hint">
                Pick a local folder to search it and add its files to chat context. .gitignore and a
                built-in deny-list (.env*, keys, .git/, node_modules/, build output, binaries) are never
                indexed.
              </p>
              <button type="button" className="btn btn--primary" onClick={() => void pickRoot()} disabled={indexing}>
                {indexing ? 'indexing…' : 'choose a folder'}
              </button>
            </div>
          )}

          {error && <p className="signal">{error}</p>}

          {loading ? (
            <p className="muted">loading…</p>
          ) : (
            root && (
              <div className="activity-rows files-panel__list">
                {files.slice(0, 200).map((file) => (
                  <div className="activity-row" key={file.id}>
                    <span className="activity-row__icon">
                      <FileIcon />
                    </span>
                    <span className="activity-row__subtitle">{file.relativePath}</span>
                    {!file.contentIndexed && <span className="chip chip--outline">not indexed</span>}
                  </div>
                ))}
                {files.length === 0 && <p className="muted">The folder has no indexable files.</p>}
                {files.length > 200 && <p className="muted">showing the first 200 of {files.length}</p>}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  )
}
