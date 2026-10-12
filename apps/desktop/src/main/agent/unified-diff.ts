import { createTwoFilesPatch, structuredPatch } from 'diff'

export interface DiffStats {
  added: number
  removed: number
}

/** Line counts of the change from `before` to `after` (a changed line counts as one removed + one added). */
export function diffStats(before: string, after: string): DiffStats {
  if (before === after) return { added: 0, removed: 0 }
  const patch = structuredPatch('a', 'b', before, after, '', '', { context: 0 })
  let added = 0
  let removed = 0
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { added, removed }
}

/** A standard unified diff (3 lines of context), `a/<path>` -> `b/<path>`; empty string when nothing changed. */
export function unifiedDiff(path: string, before: string, after: string, options: { isNew?: boolean } = {}): string {
  if (before === after) return ''
  const oldName = options.isNew ? '/dev/null' : `a/${path}`
  const patch = createTwoFilesPatch(oldName, `b/${path}`, before, after, '', '', { context: 3 })
  // jsdiff prefixes an "Index:" banner and an "====" rule; a unified diff proper starts at ---.
  const start = patch.indexOf('--- ')
  return start >= 0 ? patch.slice(start) : patch
}

/** Cuts a long diff to a size the prompt and the model can take, keeping the head. */
export function truncateDiff(diff: string, maxChars: number): string {
  if (diff.length <= maxChars) return diff
  const cut = diff.slice(0, maxChars)
  const lastNewline = cut.lastIndexOf('\n')
  return `${cut.slice(0, lastNewline > 0 ? lastNewline : maxChars)}\n... (diff truncated, ${diff.length - maxChars} more characters)`
}
