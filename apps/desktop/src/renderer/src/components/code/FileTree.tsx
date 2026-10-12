import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FsEntry } from '@ai-workspace/shared'
import { flattenTree, type TreeChildren } from '../../lib/code/tree'
import { ancestorDirs, dirName, ipcErrorMessage } from '../../lib/code/paths'

interface Props {
  workspaceId: string
  /** Bump to reload the root and every expanded folder (after saves, git actions, terminal use). */
  refreshKey: number
  activePath: string | null
  /** relative path -> single-letter git marker (M, A, U, ...). */
  markers: ReadonlyMap<string, string>
  onOpen: (path: string) => void
}

const INDENT_PX = 14

/**
 * The lazy file tree. Only the root and the folders the user has expanded are
 * ever listed (one `fs.listDir` per folder, answered by the main process with
 * the indexer's deny-list + .gitignore already applied) - the renderer never
 * holds the whole repository.
 */
export function FileTree({ workspaceId, refreshKey, activePath, markers, onOpen }: Props) {
  const [children, setChildren] = useState<TreeChildren>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const expandedRef = useRef(expanded)
  const childrenRef = useRef(children)
  const workspaceRef = useRef(workspaceId)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    expandedRef.current = expanded
  }, [expanded])
  useEffect(() => {
    childrenRef.current = children
  }, [children])
  useEffect(() => {
    workspaceRef.current = workspaceId
  }, [workspaceId])

  const loadDir = useCallback(async (dir: string): Promise<void> => {
    const id = workspaceRef.current
    setChildren((prev) => (Array.isArray(prev[dir]) ? prev : { ...prev, [dir]: 'loading' }))
    try {
      const result = await window.api.fs.listDir({ workspaceId: id, relativePath: dir })
      if (workspaceRef.current !== id) return
      setChildren((prev) => ({ ...prev, [dir]: result.entries }))
      if (dir === '') setError(null)
    } catch (err) {
      if (workspaceRef.current !== id) return
      setChildren((prev) => ({ ...prev, [dir]: [] }))
      if (dir === '') setError(ipcErrorMessage(err))
    }
  }, [])

  // New workspace: forget everything. Refresh: reload the root and open folders.
  useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setCursor(null)
    void loadDir('')
  }, [workspaceId, loadDir])

  useEffect(() => {
    if (refreshKey === 0) return
    void loadDir('')
    for (const dir of expandedRef.current) void loadDir(dir)
  }, [refreshKey, loadDir])

  // Reveal the active file: expand its ancestors (loading them as needed).
  useEffect(() => {
    if (!activePath) return
    const dirs = ancestorDirs(activePath)
    if (dirs.length === 0) return
    setExpanded((prev) => {
      if (dirs.every((d) => prev.has(d))) return prev
      return new Set([...prev, ...dirs])
    })
    for (const dir of dirs) if (childrenRef.current[dir] === undefined) void loadDir(dir)
    setCursor(activePath)
  }, [activePath, loadDir])

  const rows = useMemo(() => flattenTree(children, expanded), [children, expanded])

  const changedDirs = useMemo(() => {
    const dirs = new Set<string>()
    for (const path of markers.keys()) for (const dir of ancestorDirs(path)) dirs.add(dir)
    return dirs
  }, [markers])

  function toggle(entry: FsEntry): void {
    if (entry.kind === 'file') {
      onOpen(entry.relativePath)
      return
    }
    const path = entry.relativePath
    const next = new Set(expandedRef.current)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (children[path] === undefined) void loadDir(path)
    }
    setExpanded(next)
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (rows.length === 0) return
    const index = Math.max(0, rows.findIndex((r) => r.entry.relativePath === cursor))
    const current = rows[index]
    if (!current) return
    const move = (i: number): void => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, i))]
      if (!target) return
      setCursor(target.entry.relativePath)
      listRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(target.entry.relativePath)}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(index + 1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(index - 1)
    } else if (e.key === 'ArrowRight' && current.entry.kind === 'directory') {
      e.preventDefault()
      if (!current.expanded) toggle(current.entry)
      else move(index + 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (current.entry.kind === 'directory' && current.expanded) toggle(current.entry)
      else {
        const parent = dirName(current.entry.relativePath)
        if (parent) move(rows.findIndex((r) => r.entry.relativePath === parent))
      }
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      toggle(current.entry)
    } else if (e.key === 'Home') {
      e.preventDefault()
      move(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      move(rows.length - 1)
    }
  }

  if (error) {
    return (
      <div className="file-tree__state">
        <p className="signal">{error}</p>
      </div>
    )
  }
  if (children[''] === undefined || children[''] === 'loading') {
    return (
      <div className="file-tree__state">
        <p className="muted">loading…</p>
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="file-tree__state">
        <p className="muted">The folder is empty (hidden: .gitignore, secrets, build output).</p>
      </div>
    )
  }

  return (
    <div className="file-tree" role="tree" aria-label="Files" tabIndex={0} onKeyDown={onKeyDown} ref={listRef}>
      {rows.map((row) => {
        const path = row.entry.relativePath
        const isDir = row.entry.kind === 'directory'
        const marker = markers.get(path)
        const active = path === activePath
        return (
          <button
            key={path}
            type="button"
            role="treeitem"
            aria-expanded={isDir ? row.expanded : undefined}
            aria-selected={active}
            tabIndex={-1}
            data-path={path}
            className={`file-tree__row${active ? ' is-active' : ''}${cursor === path ? ' is-cursor' : ''}`}
            style={{ paddingLeft: 8 + row.depth * INDENT_PX }}
            onClick={() => {
              setCursor(path)
              toggle(row.entry)
            }}
            title={path}
          >
            <span className="file-tree__twisty" aria-hidden="true">
              {isDir ? (row.loading ? '…' : row.expanded ? '▾' : '▸') : ''}
            </span>
            <span className={`file-tree__name${isDir ? ' is-dir' : ''}`}>{row.entry.name}</span>
            {marker && !isDir && <span className={`file-tree__marker file-tree__marker--${marker}`}>{marker}</span>}
            {isDir && changedDirs.has(path) && <span className="file-tree__dot" aria-label="contains changes">•</span>}
          </button>
        )
      })}
    </div>
  )
}
