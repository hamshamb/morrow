import type { GitChange, GitChangeStatus, GitStatus } from '@ai-workspace/shared'

/** Single-letter marker for a change, as in the tree decorations and change rows. */
export function statusLetter(status: GitChangeStatus): string {
  switch (status) {
    case 'modified':
      return 'M'
    case 'added':
      return 'A'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    case 'typechange':
      return 'T'
    case 'untracked':
      return 'U'
    case 'conflicted':
      return '!'
  }
}

export function statusWord(status: GitChangeStatus): string {
  return status === 'typechange' ? 'type changed' : status
}

/** The commit button is live only with a non-empty message AND something staged. */
export function canCommit(status: GitStatus | null, message: string, busy: boolean): boolean {
  if (busy || status === null || status.state !== 'ok') return false
  return status.staged.length > 0 && message.trim().length > 0
}

/** Why the commit button is disabled (shown as its title). */
export function commitBlockedReason(status: GitStatus | null, message: string): string | null {
  if (status === null || status.state !== 'ok') return 'not a git repository'
  if (status.staged.length === 0) return 'nothing is staged'
  if (message.trim().length === 0) return 'write a commit message'
  return null
}

/** Total lines added/removed across a group of changes (binary / unknown counts ignored). */
export function totals(changes: readonly GitChange[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const c of changes) {
    additions += c.additions ?? 0
    deletions += c.deletions ?? 0
  }
  return { additions, deletions }
}

/**
 * One marker letter per changed path for the file-tree decorations: a
 * conflict wins, then an untracked file, then the working-tree change, then
 * the staged one.
 */
export function buildMarkers(status: GitStatus | null): Map<string, string> {
  const markers = new Map<string, string>()
  if (status === null || status.state !== 'ok') return markers
  for (const c of status.staged) markers.set(c.path, statusLetter(c.status))
  for (const c of status.unstaged) markers.set(c.path, statusLetter(c.status))
  for (const c of status.untracked) markers.set(c.path, statusLetter(c.status))
  for (const c of status.conflicted) markers.set(c.path, statusLetter(c.status))
  return markers
}

export type BarBlock = 'add' | 'delete' | 'neutral'

/**
 * Five-block mini bar for a file's +N -M summary: blocks are allocated in
 * proportion to additions vs deletions (each non-zero side gets at least one),
 * the rest stay neutral. Adapted from the "bars" variant of opencode's
 * `diff-changes.tsx` (MIT, https://github.com/anomalyco/opencode); the
 * allocation arithmetic here is our own rounding rule.
 */
export function diffBars(additions: number, deletions: number, blocks = 5): BarBlock[] {
  const total = additions + deletions
  if (total <= 0) return Array.from({ length: blocks }, () => 'neutral')
  let add = additions > 0 ? Math.max(1, Math.round((additions / total) * blocks)) : 0
  let del = deletions > 0 ? Math.max(1, Math.round((deletions / total) * blocks)) : 0
  while (add + del > blocks) {
    if (add >= del && add > 1) add -= 1
    else if (del > 1) del -= 1
    else break
  }
  const result: BarBlock[] = []
  for (let i = 0; i < add; i += 1) result.push('add')
  for (let i = 0; i < del; i += 1) result.push('delete')
  while (result.length < blocks) result.push('neutral')
  return result.slice(0, blocks)
}
