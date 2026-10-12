import { execFile } from 'node:child_process'
import {
  GIT_MAX_COMMIT_MESSAGE_CHARS,
  MAX_OPEN_FILE_BYTES,
  type GitChange,
  type GitCommitSummary,
  type GitDiffResult,
  type GitArea,
  type GitStatus,
} from '@ai-workspace/shared'
import { countLines, parseLogLine, parseNumstat, parseStatusV2, statusFromLetter, type NumstatEntry, type ParsedEntry } from './git-parse'
import { decodeUtf8, looksBinary, type CodeFileService } from './file-service'
import { PathSafetyError, isSensitivePath, normalizeRelativePath } from './path-safety'

/**
 * Git for the code workspace (ADR-036): the system `git` binary, run with
 * `execFile` and an ARGUMENT ARRAY - never a shell, never string-built
 * commands - so a path or commit message can't inject anything. Only a fixed
 * set of subcommands is ever issued: status, diff (numstat), log, show,
 * rev-parse, add, restore --staged, rm --cached (unborn branch only) and
 * commit. There is deliberately no push, pull, fetch, reset, clean,
 * checkout, rebase or force anything.
 */

export class GitMissingError extends Error {
  constructor() {
    super('git was not found on PATH')
    this.name = 'GitMissingError'
  }
}

export interface GitRunResult {
  code: number
  stdout: Buffer
  stderr: string
}

export interface GitRunOptions {
  cwd: string
  timeoutMs?: number
  /** Adds GIT_OPTIONAL_LOCKS=0 so a refresh never contends with the user's own git. */
  readOnly?: boolean
}

export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitRunResult>

/** Options placed before every subcommand: no fsmonitor hook (a repo can name a program there), no color/pager, literal pathspecs. */
export const GIT_GLOBAL_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'color.ui=false', '--literal-pathspecs', '--no-pager'] as const

/** The exact process invocation for a git call - exported so tests can assert there is no shell. */
export function buildGitInvocation(
  args: readonly string[],
  readOnly: boolean,
  baseEnv: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    file: 'git',
    args: [...GIT_GLOBAL_ARGS, ...args],
    env: {
      ...baseEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_EDITOR: 'true',
      GIT_PAGER: 'cat',
      ...(readOnly ? { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', LANGUAGE: 'C' } : {}),
    },
  }
}

export const runGit: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    const invocation = buildGitInvocation(args, options.readOnly ?? false)
    execFile(
      invocation.file,
      invocation.args,
      {
        cwd: options.cwd,
        env: invocation.env,
        encoding: 'buffer',
        windowsHide: true,
        shell: false,
        maxBuffer: 64 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ENOENT') {
            reject(new GitMissingError())
            return
          }
          if (typeof code === 'number') {
            resolve({ code, stdout, stderr: stderr.toString('utf8') })
            return
          }
          reject(error)
          return
        }
        resolve({ code: 0, stdout, stderr: stderr.toString('utf8') })
      },
    )
  })

export interface GitServiceOptions {
  resolveRoot: (workspaceId: string) => string | null
  files: CodeFileService
  runner?: GitRunner
}

const MAX_STATUS_ENTRIES = 3000
const MAX_UNTRACKED_COUNTED = 200
const MAX_UNTRACKED_COUNT_BYTES = 512 * 1024
const ADD_CHUNK = 100

/** Text of a failed git call, trimmed for display. */
function failure(result: GitRunResult, fallback: string): Error {
  const text = (result.stderr || result.stdout.toString('utf8')).trim()
  return new Error(text.split('\n').slice(0, 6).join('\n') || fallback)
}

export class GitService {
  private readonly run: GitRunner

  constructor(private readonly options: GitServiceOptions) {
    this.run = options.runner ?? runGit
  }

  private root(workspaceId: string): string {
    const root = this.options.resolveRoot(workspaceId)
    if (!root) throw new Error('This workspace has no folder yet')
    return root
  }

  /** Validated, literal, `.git`-free relative paths for add/restore. */
  private pathspecs(paths: readonly string[]): string[] {
    return paths.map((p) => {
      const rel = normalizeRelativePath(p)
      if (rel.split('/').some((s) => s.toLowerCase() === '.git')) {
        throw new PathSafetyError('denied', 'Paths inside .git are not allowed')
      }
      return rel
    })
  }

  async status(workspaceId: string): Promise<GitStatus> {
    const cwd = this.root(workspaceId)
    try {
      const probe = await this.run(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd, readOnly: true })
      const [inside = '', prefix = ''] = probe.stdout.toString('utf8').split(/\r?\n/)
      if (probe.code !== 0 || inside.trim() !== 'true') return { state: 'not-a-repo' }

      const statusResult = await this.run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], { cwd, readOnly: true })
      if (statusResult.code !== 0) return { state: 'error', message: failure(statusResult, 'git status failed').message }
      const parsed = parseStatusV2(statusResult.stdout.toString('utf8'))

      const unstagedStat = await this.numstat(cwd, false)
      const stagedStat = await this.numstat(cwd, true)

      const head = await this.run(['log', '-1', '--format=%H%x00%h%x00%s'], { cwd, readOnly: true })
      const commit: GitCommitSummary | null = head.code === 0 ? parseLogLine(head.stdout.toString('utf8')) : null

      const strip = (path: string): string | null => {
        if (!prefix) return path
        return path.startsWith(prefix) ? path.slice(prefix.length) : null
      }

      const staged: GitChange[] = []
      const unstaged: GitChange[] = []
      const untracked: GitChange[] = []
      const conflicted: GitChange[] = []
      let truncated = false
      let counted = 0
      let total = 0

      for (const entry of parsed.entries) {
        const path = strip(entry.path)
        if (path === null || path.endsWith('/')) continue
        const origPath = entry.origPath === null ? null : strip(entry.origPath)
        if (total >= MAX_STATUS_ENTRIES) {
          truncated = true
          break
        }
        total += 1
        const base = { path, origPath, protected: isSensitivePath(path) }

        if (entry.kind === 'untracked') {
          let additions: number | null = null
          let binary = false
          if (!base.protected && counted < MAX_UNTRACKED_COUNTED) {
            counted += 1
            const count = await this.countUntracked(workspaceId, path)
            additions = count.additions
            binary = count.binary
          }
          untracked.push({ ...base, status: 'untracked', additions, deletions: additions === null ? null : 0, binary })
        } else if (entry.kind === 'unmerged') {
          conflicted.push({ ...base, status: 'conflicted', additions: null, deletions: null, binary: false })
        } else {
          if (entry.index !== '.') staged.push(change(base, statusFromLetter(entry.index), stagedStat.get(entry.path)))
          if (entry.worktree !== '.') unstaged.push(change({ ...base, origPath: null }, statusFromLetter(entry.worktree), unstagedStat.get(entry.path)))
        }
      }

      return {
        state: 'ok',
        branch: parsed.branch,
        commit,
        staged,
        unstaged,
        untracked,
        conflicted,
        truncated,
      }
    } catch (err) {
      if (err instanceof GitMissingError) return { state: 'git-missing' }
      return { state: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  private async numstat(cwd: string, cached: boolean): Promise<Map<string, NumstatEntry>> {
    const args = ['diff', ...(cached ? ['--cached'] : []), '--numstat', '-z', '--no-ext-diff', '--no-textconv']
    const result = await this.run(args, { cwd, readOnly: true })
    return result.code === 0 ? parseNumstat(result.stdout.toString('utf8')) : new Map()
  }

  private async countUntracked(workspaceId: string, path: string): Promise<{ additions: number | null; binary: boolean }> {
    try {
      const file = await this.options.files.readFile(workspaceId, path)
      if (file.status === 'binary') return { additions: null, binary: true }
      if (file.status !== 'ok' || file.sizeBytes > MAX_UNTRACKED_COUNT_BYTES) return { additions: null, binary: false }
      return { additions: countLines(file.content), binary: false }
    } catch {
      return { additions: null, binary: false }
    }
  }

  /** Both sides of one file's change, for the diff editor. */
  async diff(workspaceId: string, path: string, area: GitArea, origPath?: string | null): Promise<GitDiffResult> {
    const cwd = this.root(workspaceId)
    const [rel] = this.pathspecs([path])
    if (!rel) throw new Error('Empty path')
    if (isSensitivePath(rel)) return { status: 'protected', message: 'This file matches the secrets deny-list - its content is never shown here' }
    const previous = origPath ? (this.pathspecs([origPath])[0] ?? rel) : rel

    let original = ''
    let modified = ''
    let originalLabel = ''
    let modifiedLabel = ''

    if (area === 'staged') {
      const before = await this.showBlob(cwd, `HEAD:./${previous}`)
      const after = await this.showBlob(cwd, `:./${rel}`)
      for (const side of [before, after]) {
        if (side.kind === 'too-large') return tooLarge()
        if (side.kind === 'binary') return binaryResult()
      }
      original = before.kind === 'text' ? before.text : ''
      modified = after.kind === 'text' ? after.text : ''
      originalLabel = 'HEAD'
      modifiedLabel = 'staged'
    } else if (area === 'unstaged') {
      const before = await this.showBlob(cwd, `:./${rel}`)
      if (before.kind === 'too-large') return tooLarge()
      if (before.kind === 'binary') return binaryResult()
      original = before.kind === 'text' ? before.text : ''
      originalLabel = 'index'
      modifiedLabel = 'working tree'
    } else {
      originalLabel = '(empty)'
      modifiedLabel = 'working tree'
    }

    if (area !== 'staged') {
      const file = await this.options.files.readFile(workspaceId, rel)
      if (file.status === 'ok') modified = file.content
      else if (file.status === 'missing') modified = ''
      else if (file.status === 'binary') return binaryResult()
      else if (file.status === 'too-large') return tooLarge()
      else if (file.status === 'denied') return { status: 'protected', message: file.message }
      else return { status: 'binary', message: file.message }
    }
    return { status: 'ok', original, modified, originalLabel, modifiedLabel }
  }

  /** Contents of `rev:path` as text; `missing` when the object doesn't exist (a new/deleted side). */
  private async showBlob(cwd: string, spec: string): Promise<Blob> {
    const result = await this.run(['show', '--no-textconv', spec], { cwd, readOnly: true })
    if (result.code !== 0) {
      const text = result.stderr.toLowerCase()
      if (/does not exist|exists on disk, but not in|not in the index|unknown revision|invalid object name|bad revision|ambiguous argument/.test(text)) {
        return { kind: 'missing' }
      }
      throw failure(result, 'git show failed')
    }
    if (result.stdout.length > MAX_OPEN_FILE_BYTES) return { kind: 'too-large' }
    if (looksBinary(result.stdout)) return { kind: 'binary' }
    const text = decodeUtf8(result.stdout)
    return text === null ? { kind: 'binary' } : { kind: 'text', text }
  }

  async stage(workspaceId: string, paths: readonly string[]): Promise<void> {
    const cwd = this.root(workspaceId)
    const specs = this.pathspecs(paths)
    for (let i = 0; i < specs.length; i += ADD_CHUNK) {
      const result = await this.run(['add', '--', ...specs.slice(i, i + ADD_CHUNK)], { cwd })
      if (result.code !== 0) throw failure(result, 'git add failed')
    }
  }

  async unstage(workspaceId: string, paths: readonly string[]): Promise<void> {
    const cwd = this.root(workspaceId)
    const specs = this.pathspecs(paths)
    const unborn = await this.isUnborn(cwd)
    for (let i = 0; i < specs.length; i += ADD_CHUNK) {
      const chunk = specs.slice(i, i + ADD_CHUNK)
      // `restore --staged` needs a HEAD to restore from; on a repository with no
      // commits yet the equivalent is dropping the paths from the index.
      const args = unborn ? ['rm', '--cached', '-r', '-q', '--', ...chunk] : ['restore', '--staged', '--', ...chunk]
      const result = await this.run(args, { cwd })
      if (result.code !== 0) throw failure(result, 'git unstage failed')
    }
  }

  /** Stage everything except files matching the secrets deny-list. */
  async stageAll(workspaceId: string): Promise<void> {
    const status = await this.status(workspaceId)
    if (status.state !== 'ok') throw new Error('Not a git repository')
    const paths = [...status.unstaged, ...status.untracked].filter((c) => !c.protected).map((c) => c.path)
    if (paths.length > 0) await this.stage(workspaceId, [...new Set(paths)])
  }

  async unstageAll(workspaceId: string): Promise<void> {
    const status = await this.status(workspaceId)
    if (status.state !== 'ok') throw new Error('Not a git repository')
    const paths = status.staged.flatMap((c) => (c.origPath ? [c.path, c.origPath] : [c.path]))
    if (paths.length > 0) await this.unstage(workspaceId, [...new Set(paths)])
  }

  private async isUnborn(cwd: string): Promise<boolean> {
    const result = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, readOnly: true })
    return result.code !== 0
  }

  async commit(workspaceId: string, message: string): Promise<GitCommitSummary> {
    const cwd = this.root(workspaceId)
    if (message.trim() === '') throw new Error('Commit message is empty')
    if (message.length > GIT_MAX_COMMIT_MESSAGE_CHARS) throw new Error('Commit message is too long')
    // `diff --cached --quiet` exits 0 when nothing is staged.
    const staged = await this.run(['diff', '--cached', '--quiet', '--no-ext-diff'], { cwd, readOnly: true })
    if (staged.code === 0) throw new Error('Nothing is staged')
    if (staged.code !== 1) throw failure(staged, 'Could not read the index')

    const result = await this.run(['commit', '-m', message], { cwd, timeoutMs: 120_000 })
    if (result.code !== 0) throw failure(result, 'git commit failed')
    const head = await this.run(['log', '-1', '--format=%H%x00%h%x00%s'], { cwd, readOnly: true })
    const summary = head.code === 0 ? parseLogLine(head.stdout.toString('utf8')) : null
    if (!summary) throw new Error('Committed, but could not read the new commit')
    return summary
  }
}

type Blob = { kind: 'text'; text: string } | { kind: 'missing' } | { kind: 'binary' } | { kind: 'too-large' }

function binaryResult(): GitDiffResult {
  return { status: 'binary', message: 'Binary file - no text diff' }
}

function tooLarge(): GitDiffResult {
  return { status: 'too-large', message: 'File is too large for the diff editor' }
}

function change(
  base: { path: string; origPath: string | null; protected: boolean },
  status: GitChange['status'],
  stat: NumstatEntry | undefined,
): GitChange {
  return {
    ...base,
    status,
    additions: stat?.additions ?? null,
    deletions: stat?.deletions ?? null,
    binary: stat?.binary ?? false,
  }
}

export type { ParsedEntry }
