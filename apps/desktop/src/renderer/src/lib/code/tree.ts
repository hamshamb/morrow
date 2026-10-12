import type { FsEntry } from '@ai-workspace/shared'

/** One visible row of the file tree. */
export interface TreeRow {
  entry: FsEntry
  depth: number
  expanded: boolean
  /** The directory's children are being fetched. */
  loading: boolean
}

export type TreeChildren = Record<string, FsEntry[] | 'loading' | undefined>

/**
 * Flattens the lazily-loaded tree into the rows that are currently visible:
 * a directory's children appear only when it is expanded. Pure - the tree
 * itself never holds more than the directories the user has opened.
 */
export function flattenTree(children: TreeChildren, expanded: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  function visit(dir: string, depth: number): void {
    const list = children[dir]
    if (!Array.isArray(list)) return
    for (const entry of list) {
      const isOpen = entry.kind === 'directory' && expanded.has(entry.relativePath)
      rows.push({ entry, depth, expanded: isOpen, loading: isOpen && children[entry.relativePath] === 'loading' })
      if (isOpen) visit(entry.relativePath, depth + 1)
    }
  }
  visit('', 0)
  return rows
}
