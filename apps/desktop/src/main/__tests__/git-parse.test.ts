import { describe, expect, it } from 'vitest'
import { countLines, parseLogLine, parseNumstat, parseStatusV2, statusFromLetter } from '../code/git-parse'

const NUL = '\0'
const sha = '0123456789abcdef0123456789abcdef01234567'

/** A realistic `git status --porcelain=v2 --branch -z` fixture. */
const STATUS_FIXTURE = [
  `# branch.oid ${sha}`,
  '# branch.head feature/code',
  '# branch.upstream origin/feature/code',
  '# branch.ab +2 -1',
  // staged modify, worktree clean
  `1 M. N... 100644 100644 100644 ${sha} ${sha} src/staged.ts`,
  // staged AND unstaged modification
  `1 MM N... 100644 100644 100644 ${sha} ${sha} src/both.ts`,
  // unstaged delete, with spaces in the name
  `1 .D N... 100644 100644 000000 ${sha} ${sha} docs/old notes.md`,
  // staged rename (path, then NUL, then the original path)
  `2 R. N... 100644 100644 100644 ${sha} ${sha} R100 src/new-name.ts${NUL}src/old-name.ts`,
  // unmerged
  `u UU N... 100644 100644 100644 100644 ${sha} ${sha} ${sha} src/conflict.ts`,
  '? notes/todo.txt',
  '? new file with spaces.txt',
  '',
].join(NUL)

describe('parseStatusV2', () => {
  const parsed = parseStatusV2(STATUS_FIXTURE)

  it('reads the branch header', () => {
    expect(parsed.oid).toBe(sha)
    expect(parsed.branch).toEqual({ head: 'feature/code', detached: false, upstream: 'origin/feature/code', ahead: 2, behind: 1 })
  })

  it('reads ordinary, renamed, unmerged and untracked entries', () => {
    expect(parsed.entries).toEqual([
      { path: 'src/staged.ts', origPath: null, index: 'M', worktree: '.', kind: 'ordinary' },
      { path: 'src/both.ts', origPath: null, index: 'M', worktree: 'M', kind: 'ordinary' },
      { path: 'docs/old notes.md', origPath: null, index: '.', worktree: 'D', kind: 'ordinary' },
      { path: 'src/new-name.ts', origPath: 'src/old-name.ts', index: 'R', worktree: '.', kind: 'renamed' },
      { path: 'src/conflict.ts', origPath: null, index: 'U', worktree: 'U', kind: 'unmerged' },
      { path: 'notes/todo.txt', origPath: null, index: '.', worktree: '?', kind: 'untracked' },
      { path: 'new file with spaces.txt', origPath: null, index: '.', worktree: '?', kind: 'untracked' },
    ])
  })

  it('handles a detached HEAD and an unborn branch', () => {
    const detached = parseStatusV2([`# branch.oid ${sha}`, '# branch.head (detached)', ''].join(NUL))
    expect(detached.branch.detached).toBe(true)
    expect(detached.branch.head).toBeNull()
    const unborn = parseStatusV2(['# branch.oid (initial)', '# branch.head main', '? a.txt', ''].join(NUL))
    expect(unborn.oid).toBeNull()
    expect(unborn.branch.head).toBe('main')
    expect(unborn.branch.upstream).toBeNull()
  })

  it('returns nothing for a clean tree with no header lines', () => {
    expect(parseStatusV2('').entries).toEqual([])
  })
})

describe('parseNumstat', () => {
  it('reads counts, binary files and renames (keyed by the new path)', () => {
    const output = [
      `12\t3\tsrc/a.ts`,
      `-\t-\tassets/logo.png`,
      `0\t0\t`, // rename record: empty path, then old and new
      'src/old.ts',
      'src/renamed.ts',
      `5\t5\twith space.txt`,
      '',
    ].join(NUL)
    const map = parseNumstat(output)
    expect(map.get('src/a.ts')).toEqual({ path: 'src/a.ts', additions: 12, deletions: 3, binary: false })
    expect(map.get('assets/logo.png')).toEqual({ path: 'assets/logo.png', additions: null, deletions: null, binary: true })
    expect(map.get('src/renamed.ts')).toMatchObject({ additions: 0, deletions: 0 })
    expect(map.has('src/old.ts')).toBe(false)
    expect(map.get('with space.txt')).toMatchObject({ additions: 5, deletions: 5 })
  })

  it('parses empty output', () => {
    expect(parseNumstat('').size).toBe(0)
  })
})

describe('parseLogLine / countLines / statusFromLetter', () => {
  it('splits sha, short sha and subject (subject may contain anything)', () => {
    expect(parseLogLine(`${sha}${NUL}0123456${NUL}fix: handle a\tb c\n`)).toEqual({ sha, shortSha: '0123456', subject: 'fix: handle a\tb c' })
    expect(parseLogLine('')).toBeNull()
  })

  it('counts lines like git does for new files', () => {
    expect(countLines('')).toBe(0)
    expect(countLines('a')).toBe(1)
    expect(countLines('a\n')).toBe(1)
    expect(countLines('a\nb')).toBe(2)
    expect(countLines('a\r\nb\r\n')).toBe(2)
  })

  it('maps status letters', () => {
    expect(statusFromLetter('M')).toBe('modified')
    expect(statusFromLetter('A')).toBe('added')
    expect(statusFromLetter('D')).toBe('deleted')
    expect(statusFromLetter('R')).toBe('renamed')
    expect(statusFromLetter('T')).toBe('typechange')
    expect(statusFromLetter('U')).toBe('conflicted')
  })
})
