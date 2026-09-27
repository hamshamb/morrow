import { randomUUID } from 'node:crypto'
import type { WorkspaceFileIndexEntry, WorkspaceFileRoot, WorkspaceFileSearchResult } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface WorkspaceFileRootRow {
  workspace_id: string
  root_path: string
  created_at: number
  updated_at: number
}

interface WorkspaceFileRow {
  id: string
  workspace_id: string
  relative_path: string
  size_bytes: number
  mtime_ms: number
  content: string | null
  indexed_at: number
}

function rowToRoot(row: WorkspaceFileRootRow): WorkspaceFileRoot {
  return {
    workspaceId: row.workspace_id,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToEntry(row: WorkspaceFileRow): WorkspaceFileIndexEntry {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    relativePath: row.relative_path,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    contentIndexed: row.content !== null,
    indexedAt: row.indexed_at,
  }
}

export interface FileToIndex {
  relativePath: string
  sizeBytes: number
  mtimeMs: number
  /** Extracted text content, or null when the file was listed but not
   * eligible for content indexing (too large / not a supported extension). */
  content: string | null
}

/**
 * Turns a raw FTS5 MATCH query into a safe boolean expression of
 * quoted-and-joined tokens. Quoting each token means punctuation in the
 * user's query (which would otherwise be invalid FTS5 query syntax) can
 * never throw — see DECISIONS.md for the tradeoff (no prefix/fuzzy matching
 * in V1). `mode: 'and'` (the default, used for an explicit user search box)
 * requires every token to match the same file; `mode: 'or'` (used to
 * auto-surface retrieval snippets from free-form chat draft text, where
 * requiring every word to appear verbatim in one file is far too strict)
 * matches a file containing any token, ranked by `bm25`.
 */
export function buildFtsQuery(raw: string, mode: 'and' | 'or' = 'and'): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, '').trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(mode === 'and' ? ' AND ' : ' OR ')
}

export class WorkspaceFileRepository {
  constructor(private readonly db: AppDatabase) {}

  getRoot(workspaceId: string): WorkspaceFileRoot | null {
    const row = this.db
      .prepare('SELECT * FROM workspace_file_roots WHERE workspace_id = ?')
      .get(workspaceId) as WorkspaceFileRootRow | undefined
    return row ? rowToRoot(row) : null
  }

  setRoot(workspaceId: string, rootPath: string): WorkspaceFileRoot {
    const now = Date.now()
    const existing = this.getRoot(workspaceId)
    if (existing) {
      this.db
        .prepare('UPDATE workspace_file_roots SET root_path = ?, updated_at = ? WHERE workspace_id = ?')
        .run(rootPath, now, workspaceId)
      return { ...existing, rootPath, updatedAt: now }
    }
    this.db
      .prepare(
        'INSERT INTO workspace_file_roots (workspace_id, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(workspaceId, rootPath, now, now)
    return { workspaceId, rootPath, createdAt: now, updatedAt: now }
  }

  listFiles(workspaceId: string, limit = 2000): WorkspaceFileIndexEntry[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM workspace_files WHERE workspace_id = ? ORDER BY relative_path ASC LIMIT ?',
      )
      .all(workspaceId, limit) as WorkspaceFileRow[]
    return rows.map(rowToEntry)
  }

  getFileContent(workspaceId: string, relativePath: string): string | null {
    const row = this.db
      .prepare('SELECT content FROM workspace_files WHERE workspace_id = ? AND relative_path = ?')
      .get(workspaceId, relativePath) as { content: string | null } | undefined
    return row?.content ?? null
  }

  /** Replaces the entire index for one workspace in a single transaction —
   * V1 always does a full re-walk rather than an incremental diff (see
   * DECISIONS.md). Returns the number of files with indexed content. */
  replaceIndex(workspaceId: string, files: FileToIndex[]): { fileCount: number; indexedCount: number } {
    const now = Date.now()
    const clearFiles = this.db.prepare('DELETE FROM workspace_files WHERE workspace_id = ?')
    const insertFile = this.db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, relative_path, size_bytes, mtime_ms, content, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertFts = this.db.prepare(
      `INSERT INTO workspace_files_fts (file_id, workspace_id, relative_path, content)
       VALUES (?, ?, ?, ?)`,
    )

    let indexedCount = 0
    const write = this.db.transaction(() => {
      // The AFTER DELETE trigger on workspace_files clears matching
      // workspace_files_fts rows as each row is deleted.
      clearFiles.run(workspaceId)
      for (const file of files) {
        const id = randomUUID()
        insertFile.run(id, workspaceId, file.relativePath, file.sizeBytes, file.mtimeMs, file.content, now)
        if (file.content !== null) {
          insertFts.run(id, workspaceId, file.relativePath, file.content)
          indexedCount += 1
        }
      }
    })
    write()

    return { fileCount: files.length, indexedCount }
  }

  search(
    workspaceId: string,
    query: string,
    limit = 20,
    mode: 'and' | 'or' = 'and',
  ): WorkspaceFileSearchResult[] {
    const ftsQuery = buildFtsQuery(query, mode)
    if (!ftsQuery) return []
    const rows = this.db
      .prepare(
        `SELECT relative_path AS relativePath,
                snippet(workspace_files_fts, 3, '[', ']', '…', 12) AS snippet,
                bm25(workspace_files_fts) AS score
         FROM workspace_files_fts
         WHERE workspace_id = ? AND workspace_files_fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(workspaceId, ftsQuery, limit) as { relativePath: string; snippet: string; score: number }[]
    return rows.map((row) => ({ relativePath: row.relativePath, snippet: row.snippet, score: row.score }))
  }
}
