import { useEffect, useMemo, useRef, useState } from 'react'
import { rankPaths } from '../../lib/code/quick-open'
import { baseName, dirName, ipcErrorMessage } from '../../lib/code/paths'

interface Props {
  workspaceId: string
  onOpen: (path: string) => void
  onClose: () => void
}

/**
 * Ctrl/Cmd+P. A path list fetched fresh from the main process (always the
 * current files, filtered by the same deny-list + .gitignore as the tree),
 * ranked by the normalized-substring matcher. Same overlay geometry as the
 * command palette.
 */
export function QuickOpen({ workspaceId, onOpen, onClose }: Props) {
  const [paths, setPaths] = useState<string[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    let cancelled = false
    window.api.fs.listPaths(workspaceId).then(
      (result) => {
        if (cancelled) return
        setPaths(result.paths)
        setTruncated(result.truncated)
      },
      (err: unknown) => {
        if (!cancelled) setError(ipcErrorMessage(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  const results = useMemo(() => (paths ? rankPaths(paths, query, 60) : []), [paths, query])

  useEffect(() => {
    setHighlighted(0)
  }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  function choose(path: string): void {
    onClose()
    onOpen(path)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(results.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const result = results[highlighted]
      if (result) choose(result.path)
    }
  }

  return (
    <div className="overlay overlay--top" data-quick-open onMouseDown={onClose}>
      <div className="command-palette" role="dialog" aria-label="Quick open" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="open a file by name or path…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          aria-label="File name"
        />
        <div className="command-palette__list" ref={listRef}>
          {error && <p className="command-palette__empty signal">{error}</p>}
          {!error && paths === null && <p className="command-palette__empty muted">reading files…</p>}
          {!error && paths !== null && results.length === 0 && <p className="command-palette__empty muted">no matching files</p>}
          {results.map((result, index) => (
            <button
              key={result.path}
              type="button"
              className="command-palette__row"
              data-active={index === highlighted || undefined}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => choose(result.path)}
            >
              <span className="command-palette__title">{baseName(result.path)}</span>
              <span className="command-palette__hint">{dirName(result.path)}</span>
            </button>
          ))}
          {truncated && <p className="command-palette__empty muted">the list was cut off at a very large file count</p>}
        </div>
      </div>
    </div>
  )
}
