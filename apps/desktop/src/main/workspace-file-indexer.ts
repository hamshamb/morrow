import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { extname, join, relative } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import {
  DEFAULT_DENY_PATTERNS,
  MAX_INDEXED_FILES,
  MAX_INDEXED_FILE_CHARS,
  SUPPORTED_TEXT_EXTENSIONS,
} from '@ai-workspace/shared'
import type { FileToIndex } from '@ai-workspace/storage'

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_TEXT_EXTENSIONS)

function toPosixRelative(rootPath: string, fullPath: string): string {
  return relative(rootPath, fullPath).split('\\').join('/')
}

/**
 * Built from the built-in deny-list (always applied, regardless of
 * `.gitignore`) plus the workspace root's own `.gitignore`, if any — see
 * ARCHITECTURE.md "Security model" and DECISIONS.md.
 */
function buildIgnoreFilter(rootPath: string): Ignore {
  const filter = ignore()
  filter.add([...DEFAULT_DENY_PATTERNS])
  const gitignorePath = join(rootPath, '.gitignore')
  if (existsSync(gitignorePath)) {
    try {
      filter.add(readFileSync(gitignorePath, 'utf8'))
    } catch {
      // Unreadable .gitignore — fall back to just the built-in deny-list.
    }
  }
  return filter
}

export interface WalkOptions {
  maxFiles?: number
}

/**
 * Walks `rootPath` and returns metadata (+ extracted text content, for
 * files whose extension is in `SUPPORTED_TEXT_EXTENSIONS` and whose size is
 * within `MAX_INDEXED_FILE_CHARS`) for every file that survives the
 * `.gitignore` + built-in deny-list filter. Symlinks are never followed
 * (avoids escaping the root and directory cycles). Directories are matched
 * with a trailing slash so directory-only gitignore patterns (e.g.
 * `dist/`) behave the same as they do for git.
 */
export function walkWorkspaceFiles(rootPath: string, options: WalkOptions = {}): FileToIndex[] {
  const maxFiles = options.maxFiles ?? MAX_INDEXED_FILES
  const filter = buildIgnoreFilter(rootPath)
  const results: FileToIndex[] = []

  function visit(dirPath: string): void {
    if (results.length >= maxFiles) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dirPath, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxFiles) return
      if (entry.isSymbolicLink()) continue

      const fullPath = join(dirPath, entry.name)
      const relPath = toPosixRelative(rootPath, fullPath)

      if (entry.isDirectory()) {
        if (filter.ignores(`${relPath}/`)) continue
        visit(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (filter.ignores(relPath)) continue

      let stat: ReturnType<typeof statSync>
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }

      const ext = extname(entry.name).toLowerCase()
      let content: string | null = null
      if (SUPPORTED_EXTENSION_SET.has(ext) && stat.size <= MAX_INDEXED_FILE_CHARS * 4) {
        try {
          const raw = readFileSync(fullPath, 'utf8')
          content = raw.length > MAX_INDEXED_FILE_CHARS ? raw.slice(0, MAX_INDEXED_FILE_CHARS) : raw
        } catch {
          content = null
        }
      }

      results.push({
        relativePath: relPath,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        content,
      })
    }
  }

  visit(rootPath)
  return results
}
