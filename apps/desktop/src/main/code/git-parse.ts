import type { GitBranch, GitChangeStatus } from '@ai-workspace/shared'

/**
 * Pure parsers for the machine-readable output of the handful of read-only
 * `git` commands the code workspace runs (ADR-036). All of them use `-z`
 * (NUL-separated, never quoted) so any file name round-trips.
 */

export interface ParsedEntry {
  path: string
  origPath: string | null
  /** Index (staged) status letter, '.' when unchanged. */
  index: string
  /** Working-tree status letter, '.' when unchanged. */
  worktree: string
  kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked'
}

export interface ParsedStatus {
  branch: GitBranch
  /** Full object id of HEAD, or null on an unborn branch. */
  oid: string | null
  entries: ParsedEntry[]
}

const STATUS_LETTERS: Record<string, GitChangeStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
  U: 'conflicted',
}

export function statusFromLetter(letter: string): GitChangeStatus {
  return STATUS_LETTERS[letter] ?? 'modified'
}

/**
 * Parses `git status --porcelain=v2 --branch -z`.
 *
 *   # branch.oid <sha>|(initial)      # branch.head <name>|(detached)
 *   # branch.upstream <name>          # branch.ab +<ahead> -<behind>
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
 *   ? <path>          ! <path>
 */
export function parseStatusV2(output: string): ParsedStatus {
  const branch: GitBranch = { head: null, detached: false, upstream: null, ahead: 0, behind: 0 }
  let oid: string | null = null
  const entries: ParsedEntry[] = []
  const tokens = output.split('\0')

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    if (token === '') continue
    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') {
        branch.detached = value === '(detached)'
        branch.head = branch.detached ? null : value
      } else if (key === 'branch.upstream') branch.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) {
          branch.ahead = Number(m[1])
          branch.behind = Number(m[2])
        }
      }
      continue
    }
    const kind = token[0]
    if (kind === '1') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      entries.push({ path: fields.slice(8).join(' '), origPath: null, index: xy[0] ?? '.', worktree: xy[1] ?? '.', kind: 'ordinary' })
    } else if (kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const origPath = tokens[i + 1] ?? ''
      i += 1
      entries.push({ path: fields.slice(9).join(' '), origPath, index: xy[0] ?? '.', worktree: xy[1] ?? '.', kind: 'renamed' })
    } else if (kind === 'u') {
      const fields = token.split(' ')
      const xy = fields[1] ?? 'UU'
      entries.push({ path: fields.slice(10).join(' '), origPath: null, index: xy[0] ?? 'U', worktree: xy[1] ?? 'U', kind: 'unmerged' })
    } else if (kind === '?') {
      entries.push({ path: token.slice(2), origPath: null, index: '.', worktree: '?', kind: 'untracked' })
    }
    // '!' (ignored) is not requested; anything else is ignored.
  }
  return { branch, oid, entries }
}

export interface NumstatEntry {
  path: string
  additions: number | null
  deletions: number | null
  binary: boolean
}

/**
 * Parses `git diff [--cached] --numstat -z`: `<add>\t<del>\t<path>\0`, and for
 * renames/copies `<add>\t<del>\t\0<old>\0<new>\0`. Binary files report `-`.
 * Keyed by the NEW path.
 */
export function parseNumstat(output: string): Map<string, NumstatEntry> {
  const result = new Map<string, NumstatEntry>()
  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string
    if (token === '') continue
    const firstTab = token.indexOf('\t')
    const secondTab = token.indexOf('\t', firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const add = token.slice(0, firstTab)
    const del = token.slice(firstTab + 1, secondTab)
    let path = token.slice(secondTab + 1)
    if (path === '') {
      // rename/copy: next two tokens are the old and the new path
      path = tokens[i + 2] ?? ''
      i += 2
    }
    const binary = add === '-' && del === '-'
    result.set(path, {
      path,
      additions: binary ? null : Number(add),
      deletions: binary ? null : Number(del),
      binary,
    })
  }
  return result
}

/** Parses `git log -1 --format=%H%x00%h%x00%s` (no trailing newline guaranteed). */
export function parseLogLine(output: string): { sha: string; shortSha: string; subject: string } | null {
  const [sha, shortSha, ...subject] = output.replace(/\r?\n$/, '').split('\0')
  if (!sha || !shortSha) return null
  return { sha, shortSha, subject: subject.join('\0') }
}

/** Counts text lines the way `git diff --numstat` does for a new file (a final line without a newline still counts). */
export function countLines(text: string): number {
  if (text === '') return 0
  let count = 0
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) count += 1
  return text.endsWith('\n') ? count : count + 1
}
