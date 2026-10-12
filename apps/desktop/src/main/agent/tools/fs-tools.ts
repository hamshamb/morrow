import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  AGENT_WRITE_MAX_BYTES,
  MAX_SEARCH_RESULTS,
  TOOL_OUTPUT_CHAR_CAP,
  WRITE_OVERWRITE_MAX_BYTES,
  type FsReadResult,
} from '@ai-workspace/shared'
import { formatBytes, sha256 } from '../../code/file-service'
import { PathSafetyError, normalizeRelativePath, resolveInRoot } from '../../code/path-safety'
import { diffStats, truncateDiff, unifiedDiff } from '../unified-diff'
import { ToolError, type ToolContext, type ToolDefinition, type ToolResult } from './types'

const PathArg = z.string().min(1).max(4096).describe('Path relative to the workspace root, e.g. "src/index.ts". Absolute paths and ".." are rejected.')

/** Validates and normalizes a tool path; a refusal becomes a readable error for the model. */
export function toolPath(input: string, options: { allowRoot?: boolean } = {}): string {
  try {
    return normalizeRelativePath(input, { allowRoot: options.allowRoot ?? false })
  } catch (err) {
    if (err instanceof PathSafetyError) throw new ToolError(`${err.message}. Use a path relative to the workspace root.`)
    throw err
  }
}

/** Turns a path-safety refusal from the services into a ToolError. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof PathSafetyError) throw new ToolError(err.message)
    throw err
  }
}

function describeReadFailure(path: string, result: Exclude<FsReadResult, { status: 'ok' }>): string {
  switch (result.status) {
    case 'denied':
      return `Access to "${path}" is blocked: it matches the secrets / .git deny-list. It will not be readable by any tool.`
    case 'missing':
      return `File not found: ${path}. Use filesystem.list or filesystem.search to find the right path.`
    case 'not-a-file':
      return `"${path}" is not a regular file (it may be a directory - use filesystem.list).`
    case 'too-large':
      return `"${path}" is too large to read as text. ${result.message}`
    case 'binary':
      return `"${path}" is not readable text (binary or not valid UTF-8).`
    default:
      return `Could not read "${path}".`
  }
}

const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

// ------------------------------------------------------------------ filesystem.read

const ReadInput = z.object({
  path: PathArg,
  offset: z.number().int().min(1).optional().describe('1-based line to start from (default 1).'),
  limit: z.number().int().min(1).max(2000).optional().describe('Maximum number of lines to return (default 400).'),
})

export const READ_DEFAULT_LINES = 400

export const filesystemRead: ToolDefinition<z.infer<typeof ReadInput>> = {
  id: 'filesystem.read',
  description:
    'Read a UTF-8 text file from the workspace. Returns its content (default first 400 lines; use offset/limit for more). Read a file before you edit it. Files that hold secrets (.env, keys) and .git internals cannot be read.',
  inputSchema: ReadInput,
  risk: 'safe',
  label: (input) => `read ${input.path}`,
  async run(input, ctx) {
    const path = toolPath(input.path)
    const result = await guard(() => ctx.services.files.readFile(ctx.workspaceId, path))
    if (result.status !== 'ok') return { text: describeReadFailure(path, result), summary: result.status, isError: true }

    ctx.reads.set(path, result.hash)
    const lines = result.content.split('\n')
    // A trailing newline produces one empty final element; do not count it as a line.
    const total = result.content.endsWith('\n') ? lines.length - 1 : lines.length
    const start = Math.min(Math.max(1, input.offset ?? 1), Math.max(1, total))
    const wanted = input.limit ?? READ_DEFAULT_LINES
    let end = Math.min(total, start - 1 + wanted)
    let body = lines.slice(start - 1, end).join('\n')
    let cutByChars = false
    if (body.length > TOOL_OUTPUT_CHAR_CAP) {
      body = body.slice(0, TOOL_OUTPUT_CHAR_CAP)
      const lastNewline = body.lastIndexOf('\n')
      if (lastNewline > 0) body = body.slice(0, lastNewline)
      end = start - 1 + body.split('\n').length
      cutByChars = true
    }
    const partial = start > 1 || end < total
    const header = `${path} - ${partial ? `lines ${start}-${end} of ${total}` : `${total} line${total === 1 ? '' : 's'}`}`
    const more = partial && end < total ? `\n[more: call filesystem.read again with offset=${end + 1}${cutByChars ? ' (output was cut at ' + TOOL_OUTPUT_CHAR_CAP + ' characters)' : ''}]` : ''
    return {
      text: `${header}\n---\n${body}${more}`,
      summary: partial ? `lines ${start}-${end} of ${total}` : `${total} line${total === 1 ? '' : 's'}`,
    }
  },
}

// ------------------------------------------------------------------ filesystem.list

const ListInput = z.object({
  path: z.string().max(4096).optional().describe('Directory relative to the workspace root; omit for the root.'),
})

export const filesystemList: ToolDefinition<z.infer<typeof ListInput>> = {
  id: 'filesystem.list',
  description:
    'List one directory level of the workspace (directories first). Hidden by the deny-list and .gitignore: node_modules, .git, secrets and build output.',
  inputSchema: ListInput,
  risk: 'safe',
  label: (input) => `list ${input.path?.trim() ? input.path : '.'}`,
  async run(input, ctx) {
    const path = toolPath(input.path ?? '', { allowRoot: true })
    const result = await guard(() => ctx.services.files.listDir(ctx.workspaceId, path))
    if (result.entries.length === 0) return { text: `${path || '.'} is empty (or does not exist).`, summary: 'empty' }
    const rows = result.entries.map((e) => (e.kind === 'directory' ? `${e.relativePath}/` : `${e.relativePath}${e.sizeBytes === null ? '' : `  (${formatBytes(e.sizeBytes)})`}`))
    const note = result.truncated ? '\n[listing truncated: the directory has more entries]' : ''
    return { text: `${path || '.'}:\n${rows.join('\n')}${note}`, summary: `${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'}` }
  },
}

// ------------------------------------------------------------------ filesystem.search

const SearchInput = z.object({
  query: z.string().min(1).max(200).describe('Text to look for (plain substring, not a regex).'),
  caseSensitive: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum matches (default 50).'),
})

export const filesystemSearch: ToolDefinition<z.infer<typeof SearchInput>> = {
  id: 'filesystem.search',
  description:
    'Search file contents in the workspace for a plain-text substring. Returns path:line: text for each match. Skips binary files, secrets, node_modules and ignored files.',
  inputSchema: SearchInput,
  risk: 'safe',
  label: (input) => `search "${input.query.length > 40 ? `${input.query.slice(0, 40)}…` : input.query}"`,
  async run(input, ctx) {
    const result = await ctx.services.files.searchText(
      ctx.workspaceId,
      input.query,
      input.caseSensitive ?? false,
      Math.min(input.limit ?? 50, MAX_SEARCH_RESULTS),
    )
    if (result.matches.length === 0) {
      return { text: `No matches for "${input.query}" (${result.filesScanned} files scanned${result.truncated ? '; the scan was cut short' : ''}).`, summary: 'no matches' }
    }
    const rows = result.matches.map((m) => `${m.relativePath}:${m.line}: ${m.preview}`)
    const note = result.truncated ? '\n[results truncated: refine the query]' : ''
    return {
      text: `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'} for "${input.query}":\n${rows.join('\n')}${note}`,
      summary: `${result.matches.length} match${result.matches.length === 1 ? '' : 'es'}`,
    }
  },
}

// ------------------------------------------------------------------ workspace.search

const IndexSearchInput = z.object({
  query: z.string().min(1).max(200).describe('Words to look for in the workspace file index (full-text search).'),
  limit: z.number().int().min(1).max(30).optional(),
})

export const workspaceSearch: ToolDefinition<z.infer<typeof IndexSearchInput>> = {
  id: 'workspace.search',
  description:
    'Full-text search over the workspace file index (word matches, ranked). Faster than filesystem.search on big repositories but only as fresh as the last index, and it matches whole words.',
  inputSchema: IndexSearchInput,
  risk: 'safe',
  label: (input) => `index search "${input.query.length > 40 ? `${input.query.slice(0, 40)}…` : input.query}"`,
  async run(input, ctx) {
    const results = ctx.services.indexSearch(ctx.workspaceId, input.query, input.limit ?? 10)
    if (results.length === 0) {
      return { text: `No indexed matches for "${input.query}". The index may be stale or empty - try filesystem.search.`, summary: 'no matches' }
    }
    return {
      text: results.map((r) => `${r.relativePath}: ${r.snippet.replace(/\s+/g, ' ')}`).join('\n'),
      summary: `${results.length} result${results.length === 1 ? '' : 's'}`,
    }
  },
}

// ------------------------------------------------------------------ writing: shared machinery

interface EditState {
  path: string
  /** Text before the edit (null: the file does not exist yet). */
  before: string | null
  beforeHash: string | null
  after: string
  bom: boolean
  isNew: boolean
}

async function readCurrent(
  ctx: ToolContext,
  path: string,
): Promise<{ exists: false } | { exists: true; content: string; hash: string; sizeBytes: number; bom: boolean }> {
  const result = await guard(() => ctx.services.files.readFile(ctx.workspaceId, path))
  if (result.status === 'missing') return { exists: false }
  if (result.status !== 'ok') throw new ToolError(describeReadFailure(path, result))
  if (result.readOnly) throw new ToolError(`"${path}" is larger than the editable limit; the agent cannot change it.`)
  return { exists: true, content: result.content, hash: result.hash, sizeBytes: result.sizeBytes, bom: result.bom }
}

/** The agent must have read the file in this run, and it must not have changed since. */
function requireFreshRead(ctx: ToolContext, path: string, currentHash: string): void {
  const seen = ctx.reads.get(path)
  if (seen === undefined) {
    throw new ToolError(`You have not read "${path}" in this run. Call filesystem.read on it first, then retry.`)
  }
  if (seen !== currentHash) {
    throw new ToolError(`"${path}" has changed on disk since you last read it (someone or something edited it). Call filesystem.read again, then retry with the current content.`)
  }
}

/** Writes through the Phase 4 file service (atomic, hash-guarded), then re-reads the disk to verify. */
async function applyEdit(ctx: ToolContext, state: EditState): Promise<ToolResult> {
  const { files } = ctx.services
  // Pre-edit bytes, for [revert file]. Read raw so a revert restores the exact bytes (BOM, line endings).
  let beforeBuffer: Buffer | null = null
  if (!state.isNew) {
    const resolved = await guard(() => resolveInRoot(ctx.services.resolveRoot(ctx.workspaceId) ?? '', state.path))
    beforeBuffer = await readFile(resolved.absolutePath)
    if (sha256(beforeBuffer) !== state.beforeHash) {
      throw new ToolError(`"${state.path}" changed while the request was waiting. Read it again and retry.`)
    }
  } else {
    const resolved = await guard(() => resolveInRoot(ctx.services.resolveRoot(ctx.workspaceId) ?? '', state.path))
    await mkdir(dirname(resolved.absolutePath), { recursive: true })
  }

  const written = await guard(() =>
    files.writeFile(ctx.workspaceId, state.path, state.after, state.beforeHash, false, state.bom),
  )
  if (written.status === 'conflict') {
    throw new ToolError(
      written.reason === 'exists'
        ? `"${state.path}" now exists (created after the request was made). Read it first.`
        : `"${state.path}" changed on disk before the edit could be applied (${written.reason}). Read it again and retry.`,
    )
  }

  // Verify: re-read the file from disk and compare with what we meant to write.
  const verify = await files.readFile(ctx.workspaceId, state.path)
  if (verify.status !== 'ok' || verify.content !== state.after || verify.hash !== written.hash) {
    throw new ToolError(`The write to "${state.path}" could not be verified by re-reading the file. Check it with filesystem.read.`)
  }
  ctx.snapshots.record({ path: state.path, beforeContent: beforeBuffer, beforeHash: state.beforeHash, afterHash: written.hash })
  ctx.reads.set(state.path, written.hash)

  const stats = diffStats(state.before ?? '', verify.content)
  const diff = unifiedDiff(state.path, state.before ?? '', verify.content, { isNew: state.isNew })
  const verb = state.isNew ? 'Created' : 'Updated'
  return {
    text: `${verb} ${state.path} (+${stats.added} -${stats.removed}), verified by re-reading the file.\n${truncateDiff(diff, 6000)}`,
    summary: state.isNew ? `new +${stats.added}` : `+${stats.added} -${stats.removed}`,
    detail: diff,
  }
}

// ------------------------------------------------------------------ filesystem.write

const WriteInput = z.object({
  path: PathArg,
  content: z.string().max(AGENT_WRITE_MAX_BYTES).describe('The complete new content of the file.'),
})

export const filesystemWrite: ToolDefinition<z.infer<typeof WriteInput>> = {
  id: 'filesystem.write',
  description: `Create a new file, or replace a small existing file entirely. Missing parent folders are created. To CHANGE part of an existing file use filesystem.patch: this tool refuses to overwrite an existing file larger than ${WRITE_OVERWRITE_MAX_BYTES} bytes, and an existing file must have been read with filesystem.read first.`,
  inputSchema: WriteInput,
  risk: 'write',
  label: (input) => `write ${input.path}`,
  assess: () => ({ risk: 'write', noGrant: false, command: null, grantScopeNote: 'file writes in this workspace' }),
  async prepare(input, ctx) {
    const path = toolPath(input.path)
    if (Buffer.byteLength(input.content, 'utf8') > AGENT_WRITE_MAX_BYTES) throw new ToolError('The content is too large to write in one call.')
    const current = await readCurrent(ctx, path)
    let state: EditState
    if (!current.exists) {
      state = { path, before: null, beforeHash: null, after: input.content, bom: false, isNew: true }
    } else {
      if (current.sizeBytes > WRITE_OVERWRITE_MAX_BYTES) {
        throw new ToolError(
          `"${path}" is ${formatBytes(current.sizeBytes)}: filesystem.write will not overwrite an existing file above ${formatBytes(WRITE_OVERWRITE_MAX_BYTES)}. Make a targeted change with filesystem.patch instead.`,
        )
      }
      requireFreshRead(ctx, path, current.hash)
      state = { path, before: current.content, beforeHash: current.hash, after: input.content, bom: current.bom, isNew: false }
    }
    if (state.before === state.after) throw new ToolError(`"${path}" already has exactly this content; nothing to write.`)
    const diff = unifiedDiff(path, state.before ?? '', state.after, { isNew: state.isNew })
    const stats = diffStats(state.before ?? '', state.after)
    return {
      state,
      preview: {
        kind: 'write',
        path,
        isNew: state.isNew,
        diff: truncateDiff(diff, 20_000),
        added: stats.added,
        removed: stats.removed,
        sizeBytes: Buffer.byteLength(state.after, 'utf8'),
      },
    }
  },
  async run(_input, ctx, prepared) {
    return applyEdit(ctx, (prepared as { state: EditState }).state)
  },
}

// ------------------------------------------------------------------ filesystem.patch

const PatchInput = z.object({
  path: PathArg,
  old_string: z.string().min(1).max(200_000).describe('The exact text to replace, including whitespace and indentation. Must occur EXACTLY ONCE in the file - include enough surrounding lines to make it unique.'),
  new_string: z.string().max(200_000).describe('The replacement text (may be empty to delete the old text).'),
})

export const filesystemPatch: ToolDefinition<z.infer<typeof PatchInput>> = {
  id: 'filesystem.patch',
  description:
    'Make a precise edit: replace old_string with new_string in an existing file. old_string must match the file EXACTLY ONCE (zero or several matches is an error and nothing is written). You must have read the file with filesystem.read first, and it must not have changed since. Prefer this over rewriting a file.',
  inputSchema: PatchInput,
  risk: 'write',
  label: (input) => `patch ${input.path}`,
  assess: () => ({ risk: 'write', noGrant: false, command: null, grantScopeNote: 'file edits in this workspace' }),
  async prepare(input, ctx) {
    const path = toolPath(input.path)
    const current = await readCurrent(ctx, path)
    if (!current.exists) {
      throw new ToolError(`"${path}" does not exist. filesystem.patch edits existing files; use filesystem.write to create one.`)
    }
    requireFreshRead(ctx, path, current.hash)
    if (input.old_string === input.new_string) throw new ToolError('old_string and new_string are identical; nothing to change.')

    // A CRLF file read through the tool shows "\r\n"; accept an old_string typed with plain "\n".
    const crlf = current.content.includes('\r\n')
    const adapt = (text: string): string => (crlf && !text.includes('\r') ? text.replace(/\n/g, '\r\n') : text)
    let oldText = input.old_string
    let newText = input.new_string
    let matches = countOccurrences(current.content, oldText)
    if (matches === 0 && crlf) {
      oldText = adapt(input.old_string)
      newText = adapt(input.new_string)
      matches = countOccurrences(current.content, oldText)
    }
    if (matches === 0) {
      const loose = looseMatchHint(current.content, input.old_string)
      throw new ToolError(
        `old_string was not found in "${path}". It must match the file exactly, including whitespace, indentation and line breaks.${loose} Nothing was written. Re-read the file and copy the text exactly.`,
      )
    }
    if (matches > 1) {
      throw new ToolError(
        `old_string matches ${matches} places in "${path}"; it must match exactly once. Include more surrounding lines so it is unique. Nothing was written.`,
      )
    }
    const index = current.content.indexOf(oldText)
    const after = current.content.slice(0, index) + newText + current.content.slice(index + oldText.length)
    if (Buffer.byteLength(after, 'utf8') > AGENT_WRITE_MAX_BYTES) throw new ToolError('The edited file would be too large.')

    const state: EditState = { path, before: current.content, beforeHash: current.hash, after, bom: current.bom, isNew: false }
    const diff = unifiedDiff(path, current.content, after)
    const stats = diffStats(current.content, after)
    return { state, preview: { kind: 'patch', path, diff: truncateDiff(diff, 20_000), added: stats.added, removed: stats.removed } }
  },
  async run(_input, ctx, prepared) {
    return applyEdit(ctx, (prepared as { state: EditState }).state)
  },
}

/** When the exact text is missing, tell the model if the same text exists apart from whitespace (the usual mistake). */
function looseMatchHint(content: string, needle: string): string {
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
  const target = squash(needle)
  if (target.length < 8) return ''
  if (squash(content).includes(target)) {
    return ' The same text DOES exist apart from whitespace/indentation/line-break differences - copy it exactly as it appears in the file.'
  }
  return ''
}

export const FS_TOOLS = [filesystemRead, filesystemList, filesystemSearch, workspaceSearch, filesystemWrite, filesystemPatch]

