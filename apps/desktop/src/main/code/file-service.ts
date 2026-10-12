import { createHash, randomBytes } from 'node:crypto'
import { chmod, lstat, open, readdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Ignore } from 'ignore'
import {
  MAX_DIR_ENTRIES,
  MAX_EDITABLE_FILE_BYTES,
  MAX_LISTED_PATHS,
  MAX_OPEN_FILE_BYTES,
  MAX_SEARCH_RESULTS,
  type FsEntry,
  type FsListDirResult,
  type FsListPathsResult,
  type FsReadResult,
  type FsSearchMatch,
  type FsSearchTextResult,
  type FsWriteResult,
} from '@ai-workspace/shared'
import { buildIgnoreFilter } from '../workspace-file-indexer'
import { PathSafetyError, isInside, isSensitivePath, resolveInRoot } from './path-safety'

/** Extensions that are never shown as text, whatever their bytes look like. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff', '.psd', '.pdf',
  '.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.bz2', '.xz',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib', '.class', '.jar', '.pyc', '.wasm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ogg', '.flac', '.mkv', '.webm',
  '.sqlite', '.sqlite3', '.db',
])

const SNIFF_BYTES = 8000
const SEARCH_DEFAULT_LIMIT = 200
const SEARCH_MAX_FILES = 5000
const SEARCH_MAX_FILE_BYTES = 1024 * 1024
const SEARCH_MAX_TOTAL_BYTES = 64 * 1024 * 1024
const SEARCH_MAX_MS = 5000
const SEARCH_MAX_PER_FILE = 20
const SEARCH_PREVIEW_CHARS = 200

export function hasBinaryExtension(path: string): boolean {
  return BINARY_EXTENSIONS.has(extname(path).toLowerCase())
}

/** A NUL byte in the first 8 KB is the same heuristic git uses for "binary". */
export function looksBinary(buffer: Buffer): boolean {
  const end = Math.min(buffer.length, SNIFF_BYTES)
  for (let i = 0; i < end; i += 1) if (buffer[i] === 0) return true
  return false
}

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** Decodes strictly: invalid UTF-8 returns null so a Latin-1 file is shown as
 * "not text" instead of being saved back with replacement characters. */
export function decodeUtf8(buffer: Buffer): string | null {
  try {
    return strictUtf8.decode(buffer)
  } catch {
    return null
  }
}

export interface CodeFileServiceOptions {
  /** Workspace id -> absolute root folder, or null when none is set. */
  resolveRoot: (workspaceId: string) => string | null
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined
}

/**
 * All filesystem access for the code workspace (ADR-035). Every method takes a
 * workspace id + a RELATIVE path; nothing here accepts an absolute path from
 * the renderer.
 */
export class CodeFileService {
  constructor(private readonly options: CodeFileServiceOptions) {}

  private root(workspaceId: string): string {
    const root = this.options.resolveRoot(workspaceId)
    if (!root) throw new Error('This workspace has no folder yet')
    return root
  }

  /** One level of the tree, filtered by the indexer's deny-list + .gitignore. */
  async listDir(workspaceId: string, relativePath: string): Promise<FsListDirResult> {
    const root = this.root(workspaceId)
    const dir = await resolveInRoot(root, relativePath, { allowRoot: true })
    const filter = buildIgnoreFilter(dir.rootReal)
    let dirents
    try {
      dirents = await readdir(dir.absolutePath, { withFileTypes: true, encoding: 'utf8' })
    } catch (err) {
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return { entries: [], truncated: false }
      throw err
    }

    const entries: FsEntry[] = []
    let truncated = false
    for (const dirent of dirents) {
      const rel = dir.relativePath === '' ? dirent.name : `${dir.relativePath}/${dirent.name}`
      let kind: 'file' | 'directory'
      let sizeBytes: number | null = null
      if (dirent.isSymbolicLink()) {
        // Only follow a link that stays inside the workspace.
        try {
          const target = await realpath(join(dir.absolutePath, dirent.name))
          if (!isInside(dir.rootReal, target)) continue
          const st = await stat(target)
          kind = st.isDirectory() ? 'directory' : 'file'
          sizeBytes = st.isFile() ? st.size : null
        } catch {
          continue
        }
      } else if (dirent.isDirectory()) {
        kind = 'directory'
      } else if (dirent.isFile()) {
        kind = 'file'
      } else {
        continue
      }
      if (filter.ignores(kind === 'directory' ? `${rel}/` : rel)) continue
      if (kind === 'file' && sizeBytes === null) {
        try {
          sizeBytes = (await lstat(join(dir.absolutePath, dirent.name))).size
        } catch {
          sizeBytes = null
        }
      }
      if (entries.length >= MAX_DIR_ENTRIES) {
        truncated = true
        break
      }
      entries.push({ name: dirent.name, relativePath: rel, kind, sizeBytes })
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    })
    return { entries, truncated }
  }

  async readFile(workspaceId: string, relativePath: string): Promise<FsReadResult> {
    const root = this.root(workspaceId)
    let resolved
    try {
      resolved = await resolveInRoot(root, relativePath)
    } catch (err) {
      // A secret is a visible, explainable state; every other rejection
      // (absolute / traversal / escape / invalid) is a thrown error.
      if (err instanceof PathSafetyError && err.code === 'denied') {
        return { status: 'denied', relativePath, sizeBytes: null, message: err.message }
      }
      throw err
    }
    const { absolutePath } = resolved
    const rel = resolved.relativePath

    let st
    try {
      st = await stat(absolutePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        return { status: 'missing', relativePath: rel, sizeBytes: null, message: 'File no longer exists' }
      }
      throw err
    }
    if (!st.isFile()) return { status: 'not-a-file', relativePath: rel, sizeBytes: null, message: 'Not a regular file' }
    if (st.size > MAX_OPEN_FILE_BYTES) {
      return {
        status: 'too-large',
        relativePath: rel,
        sizeBytes: st.size,
        message: `Too large to open (${formatBytes(st.size)}, limit ${formatBytes(MAX_OPEN_FILE_BYTES)}) - reveal it in the folder to open it elsewhere`,
      }
    }
    if (hasBinaryExtension(rel)) {
      return { status: 'binary', relativePath: rel, sizeBytes: st.size, message: 'Binary file - reveal it in the folder to open it elsewhere' }
    }
    const buffer = await readFile(absolutePath)
    if (looksBinary(buffer)) {
      return { status: 'binary', relativePath: rel, sizeBytes: st.size, message: 'Binary file - reveal it in the folder to open it elsewhere' }
    }
    const content = decodeUtf8(buffer)
    if (content === null) {
      return {
        status: 'binary',
        relativePath: rel,
        sizeBytes: st.size,
        message: 'Not valid UTF-8 text - opening it here could corrupt it, reveal it in the folder instead',
      }
    }
    const large = buffer.length > MAX_EDITABLE_FILE_BYTES
    return {
      status: 'ok',
      relativePath: rel,
      content,
      hash: sha256(buffer),
      mtimeMs: st.mtimeMs,
      sizeBytes: buffer.length,
      readOnly: large,
      readOnlyReason: large ? `Larger than ${formatBytes(MAX_EDITABLE_FILE_BYTES)} - opened read-only` : null,
      bom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf,
    }
  }

  /**
   * Atomic save: write a temp file beside the target, fsync, rename over it.
   * Refuses (returns `conflict`) when the file changed on disk since the read
   * the edit started from, unless `overwrite` is set after the user confirmed.
   */
  async writeFile(
    workspaceId: string,
    relativePath: string,
    content: string,
    expectedHash: string | null,
    overwrite = false,
    bom = false,
  ): Promise<FsWriteResult> {
    const root = this.root(workspaceId)
    const resolved = await resolveInRoot(root, relativePath)
    const bytes = Buffer.from(bom ? `﻿${content}` : content, 'utf8')
    if (bytes.length > MAX_OPEN_FILE_BYTES) throw new Error(`Refusing to write more than ${formatBytes(MAX_OPEN_FILE_BYTES)}`)

    let existing: Awaited<ReturnType<typeof stat>> | null = null
    try {
      existing = await stat(resolved.absolutePath)
    } catch (err) {
      if (errCode(err) !== 'ENOENT') throw err
    }
    if (existing && !existing.isFile()) throw new Error('Not a regular file')

    if (existing === null) {
      if (expectedHash !== null && !overwrite) return { status: 'conflict', reason: 'deleted', currentHash: null }
      // New file: its directory must already exist (no implicit mkdir -p).
      const parent = await stat(dirname(resolved.absolutePath)).catch(() => null)
      if (!parent?.isDirectory()) throw new Error('The folder for this file does not exist')
    } else if (!overwrite) {
      const currentHash = sha256(await readFile(resolved.absolutePath))
      if (expectedHash === null) return { status: 'conflict', reason: 'exists', currentHash }
      if (currentHash !== expectedHash) return { status: 'conflict', reason: 'changed', currentHash }
    }

    const target = resolved.absolutePath
    const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      const handle = await open(tmp, 'wx')
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (existing && process.platform !== 'win32') await chmod(tmp, existing.mode & 0o7777).catch(() => undefined)
      await rename(tmp, target)
    } catch (err) {
      await unlink(tmp).catch(() => undefined)
      throw err
    }
    const written = await stat(target)
    return { status: 'saved', hash: sha256(bytes), mtimeMs: written.mtimeMs, sizeBytes: bytes.length }
  }

  /** Every visible file path (bounded), for quick open. */
  async listPaths(workspaceId: string): Promise<FsListPathsResult> {
    const root = this.root(workspaceId)
    const rootReal = await realpath(root)
    const paths: string[] = []
    let truncated = false
    for await (const file of walkVisibleFiles(rootReal)) {
      if (paths.length >= MAX_LISTED_PATHS) {
        truncated = true
        break
      }
      paths.push(file.relativePath)
    }
    paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
    return { paths, truncated }
  }

  /**
   * Case-insensitive (by default) substring search with line numbers. A
   * bounded scan - file count, per-file size, total bytes and wall time are
   * capped - rather than the FTS5 index: that returns one snippet per file with
   * no line numbers, tokenizes on word boundaries, and can be stale (ADR-034).
   */
  async searchText(workspaceId: string, query: string, caseSensitive = false, limit?: number): Promise<FsSearchTextResult> {
    const root = this.root(workspaceId)
    const rootReal = await realpath(root)
    const max = Math.min(limit ?? SEARCH_DEFAULT_LIMIT, MAX_SEARCH_RESULTS)
    const needle = caseSensitive ? query : query.toLowerCase()
    const deadline = Date.now() + SEARCH_MAX_MS
    const matches: FsSearchMatch[] = []
    let filesScanned = 0
    let totalBytes = 0
    let truncated = false

    for await (const file of walkVisibleFiles(rootReal)) {
      if (matches.length >= max || filesScanned >= SEARCH_MAX_FILES || totalBytes >= SEARCH_MAX_TOTAL_BYTES || Date.now() > deadline) {
        truncated = true
        break
      }
      if (hasBinaryExtension(file.relativePath) || isSensitivePath(file.relativePath)) continue
      let buffer: Buffer
      try {
        const st = await stat(file.absolutePath)
        if (!st.isFile() || st.size > SEARCH_MAX_FILE_BYTES) continue
        buffer = await readFile(file.absolutePath)
      } catch {
        continue
      }
      filesScanned += 1
      totalBytes += buffer.length
      if (looksBinary(buffer)) continue
      const text = decodeUtf8(buffer)
      if (text === null) continue
      let inFile = 0
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] as string
        const haystack = caseSensitive ? line : line.toLowerCase()
        const column = haystack.indexOf(needle)
        if (column === -1) continue
        matches.push({
          relativePath: file.relativePath,
          line: i + 1,
          column: column + 1,
          preview: previewLine(line, column),
        })
        inFile += 1
        if (inFile >= SEARCH_MAX_PER_FILE || matches.length >= max) break
      }
    }
    return { matches, filesScanned, truncated }
  }

  /** Absolute, symlink-resolved path to hand to the OS file manager (reveal only). */
  async resolveForReveal(workspaceId: string, relativePath: string): Promise<string> {
    const resolved = await resolveInRoot(this.root(workspaceId), relativePath, { allowRoot: true })
    return resolved.absolutePath
  }
}

function previewLine(line: string, column: number): string {
  // Keep the match visible when the line is long.
  const start = Math.max(0, column - 60)
  const slice = line.slice(start, start + SEARCH_PREVIEW_CHARS).trim()
  return start > 0 ? `...${slice}` : slice
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

interface VisibleFile {
  relativePath: string
  absolutePath: string
}

/**
 * Walks `rootReal` yielding every file that survives the indexer's deny-list +
 * .gitignore filter. Symlinks are never followed (no escape, no cycles) -
 * the same rule as the indexer.
 */
export async function* walkVisibleFiles(rootReal: string, filter: Ignore = buildIgnoreFilter(rootReal)): AsyncGenerator<VisibleFile> {
  const stack: { abs: string; rel: string }[] = [{ abs: rootReal, rel: '' }]
  while (stack.length > 0) {
    const { abs, rel } = stack.pop() as { abs: string; rel: string }
    let dirents
    try {
      dirents = await readdir(abs, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    // Reverse so the stack pops in alphabetical-ish order.
    dirents.sort((a, b) => b.name.localeCompare(a.name))
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`
      if (dirent.isDirectory()) {
        if (!filter.ignores(`${childRel}/`)) stack.push({ abs: join(abs, dirent.name), rel: childRel })
      } else if (dirent.isFile()) {
        if (!filter.ignores(childRel)) yield { relativePath: childRel, absolutePath: join(abs, dirent.name) }
      }
    }
  }
}
