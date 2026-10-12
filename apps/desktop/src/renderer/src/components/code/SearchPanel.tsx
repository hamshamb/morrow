import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { FsSearchMatch, FsSearchTextResult } from '@ai-workspace/shared'
import { baseName, dirName, ipcErrorMessage } from '../../lib/code/paths'

interface Props {
  workspaceId: string
  onOpen: (path: string, position: { line: number; column: number }) => void
}

export interface SearchPanelHandle {
  focus: () => void
}

const DEBOUNCE_MS = 250

/**
 * Text search across the workspace: substring matches with line numbers from a
 * bounded scan in the main process (same deny-list + .gitignore as the tree).
 */
export const SearchPanel = forwardRef<SearchPanelHandle, Props>(function SearchPanel({ workspaceId, onOpen }, ref) {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [result, setResult] = useState<FsSearchTextResult | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!query.trim()) {
      setResult(null)
      setError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      window.api.fs.searchText({ workspaceId, query: query.trim(), caseSensitive }).then(
        (next) => {
          if (cancelled) return
          setResult(next)
          setError(null)
          setSearching(false)
        },
        (err: unknown) => {
          if (cancelled) return
          setError(ipcErrorMessage(err))
          setSearching(false)
        },
      )
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [workspaceId, query, caseSensitive])

  const groups = useMemo(() => {
    const map = new Map<string, FsSearchMatch[]>()
    for (const match of result?.matches ?? []) {
      const list = map.get(match.relativePath)
      if (list) list.push(match)
      else map.set(match.relativePath, [match])
    }
    return [...map.entries()]
  }, [result])

  return (
    <div className="search-panel">
      <div className="search-panel__bar">
        <input
          ref={inputRef}
          className="input search-panel__input"
          placeholder="search in files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search in files"
        />
        <button
          type="button"
          className={`search-panel__case${caseSensitive ? ' is-active' : ''}`}
          aria-pressed={caseSensitive}
          title="match case"
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
      </div>

      <div className="search-panel__results">
        {error && <p className="signal search-panel__note">{error}</p>}
        {searching && !result && <p className="muted search-panel__note">searching…</p>}
        {result && result.matches.length === 0 && !searching && <p className="muted search-panel__note">no matches</p>}
        {groups.map(([path, matches]) => (
          <div key={path} className="search-group">
            <div className="search-group__file" title={path}>
              <span className="search-group__name">{baseName(path)}</span>
              <span className="search-group__dir">{dirName(path)}</span>
              <span className="chip chip--outline">{matches.length}</span>
            </div>
            {matches.map((m) => (
              <button
                key={`${m.line}:${m.column}`}
                type="button"
                className="search-hit"
                onClick={() => onOpen(m.relativePath, { line: m.line, column: m.column })}
              >
                <span className="search-hit__line">{m.line}</span>
                <span className="search-hit__text">{highlightMatch(m.preview, query.trim(), caseSensitive)}</span>
              </button>
            ))}
          </div>
        ))}
        {result && (
          <p className="muted search-panel__note search-panel__summary">
            {result.matches.length} {result.matches.length === 1 ? 'match' : 'matches'} in {groups.length} {groups.length === 1 ? 'file' : 'files'}
            {result.truncated ? ' · stopped early (limit reached) — narrow the query' : ''}
          </p>
        )}
      </div>
    </div>
  )
})

/** Bolds the first occurrence of the query inside a result line. */
function highlightMatch(text: string, query: string, caseSensitive: boolean): React.ReactNode {
  if (!query) return text
  const index = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? query : query.toLowerCase())
  if (index === -1) return text
  return (
    <>
      {text.slice(0, index)}
      <mark className="search-hit__mark">{text.slice(index, index + query.length)}</mark>
      {text.slice(index + query.length)}
    </>
  )
}
