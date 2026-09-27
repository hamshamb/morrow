import type { useWorkspaceFiles } from '../hooks/useWorkspaceFiles'

interface Props {
  workspaceFiles: ReturnType<typeof useWorkspaceFiles>
  onClose: () => void
}

/**
 * Lets the user pick (or change) a workspace's local file root and browse
 * what got indexed. Excluded files (`.gitignore` + the built-in deny-list —
 * see ARCHITECTURE.md) never appear here because they were never written to
 * the index in the first place (see `workspace-file-indexer.ts`).
 */
export function WorkspaceFilesPanel({ workspaceFiles, onClose }: Props) {
  const { root, files, loading, indexing, error, pickRoot, reindex } = workspaceFiles

  return (
    <div className="settings-overlay" role="dialog" aria-label="Workspace files">
      <div className="settings-panel">
        <header className="settings-panel__header">
          <h2>Workspace files</h2>
          <button type="button" onClick={onClose} aria-label="Close workspace files">
            ×
          </button>
        </header>

        <section className="settings-panel__section">
          <p className="settings-panel__hint">
            Pick a local folder to browse, search, and attach to chat context. Files matching your
            .gitignore or a built-in deny-list (.env*, credentials, private keys, .git/,
            node_modules/, build output, binaries) are never indexed or readable here.
          </p>

          {root ? (
            <p>
              Root: <code>{root.rootPath}</code>
            </p>
          ) : (
            <p>No folder selected yet.</p>
          )}

          {error && <p className="settings-panel__error">{error}</p>}

          <div className="settings-panel__form-actions">
            <button type="button" onClick={() => void pickRoot()} disabled={indexing}>
              {root ? 'Change folder' : 'Choose folder'}
            </button>
            {root && (
              <button type="button" onClick={() => void reindex()} disabled={indexing}>
                {indexing ? 'Indexing…' : 'Reindex'}
              </button>
            )}
          </div>

          {loading ? (
            <p>Loading…</p>
          ) : (
            <ul className="settings-panel__configs">
              {files.slice(0, 200).map((file) => (
                <li key={file.id}>
                  <span>
                    {file.relativePath}
                    {!file.contentIndexed && ' (not content-indexed)'}
                  </span>
                </li>
              ))}
              {files.length === 0 && root && <li className="settings-panel__empty">No files indexed.</li>}
            </ul>
          )}
          {files.length > 200 && <p className="settings-panel__hint">Showing the first 200 of {files.length} files.</p>}
        </section>
      </div>
    </div>
  )
}
