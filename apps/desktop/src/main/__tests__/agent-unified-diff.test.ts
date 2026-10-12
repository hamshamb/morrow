import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { diffStats, truncateDiff, unifiedDiff } from '../agent/unified-diff'

const cases: [string, string, string][] = [
  ['one changed line', 'a\nb\nc\n', 'a\nB\nc\n'],
  ['insertion', 'a\nc\n', 'a\nb\nc\n'],
  ['deletion', 'a\nb\nc\n', 'a\nc\n'],
  ['append at end', 'a\n', 'a\nb\nc\n'],
  ['no trailing newline -> trailing newline', 'a\nb', 'a\nb\n'],
  ['CRLF line changed', 'a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n'],
  ['two far-apart hunks', Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n', Array.from({ length: 40 }, (_, i) => (i === 2 ? 'CHANGED' : i === 37 ? 'ALSO' : `line ${i}`)).join('\n') + '\n'],
  ['unicode', 'héllo\n✓ done\n', 'héllo\n✗ not done\n'],
]

describe('unifiedDiff', () => {
  it.each(cases)('is a valid patch that reproduces the new text: %s', (_name, before, after) => {
    const patch = unifiedDiff('f.txt', before, after)
    expect(patch.startsWith('--- a/f.txt\n+++ b/f.txt\n')).toBe(true)
    expect(applyPatch(before, patch)).toBe(after)
  })

  it('uses /dev/null for a new file and is empty when nothing changed', () => {
    const patch = unifiedDiff('new.txt', '', 'x\ny\n', { isNew: true })
    expect(patch.startsWith('--- /dev/null\n+++ b/new.txt\n')).toBe(true)
    expect(patch).toContain('+x\n+y')
    expect(unifiedDiff('f.txt', 'same\n', 'same\n')).toBe('')
  })

  it('agrees with `git diff` about the hunks it shows (same changed lines)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiw-diff-'))
    try {
      const before = Array.from({ length: 12 }, (_, i) => `row ${i}`).join('\n') + '\n'
      const after = before.replace('row 5', 'row five').replace('row 9\n', 'row 9\nrow 9b\n')
      writeFileSync(join(dir, 'a.txt'), before)
      writeFileSync(join(dir, 'b.txt'), after)
      let gitOut = ''
      try {
        execFileSync('git', ['diff', '--no-index', '--no-color', 'a.txt', 'b.txt'], { cwd: dir, encoding: 'utf8' })
      } catch (err) {
        // `git diff --no-index` exits 1 when the files differ.
        gitOut = String((err as { stdout?: string }).stdout ?? '')
      }
      const changed = (patch: string): string[] => patch.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
      expect(changed(unifiedDiff('x', before, after))).toEqual(changed(gitOut))
      expect(changed(gitOut).length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('diffStats', () => {
  it('counts a changed line as one removed and one added', () => {
    expect(diffStats('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1 })
    expect(diffStats('a\n', 'a\nb\nc\n')).toEqual({ added: 2, removed: 0 })
    expect(diffStats('a\nb\nc\n', 'a\n')).toEqual({ added: 0, removed: 2 })
    expect(diffStats('', 'x\ny\n')).toEqual({ added: 2, removed: 0 })
    expect(diffStats('same\n', 'same\n')).toEqual({ added: 0, removed: 0 })
  })
})

describe('truncateDiff', () => {
  it('keeps short diffs and cuts long ones on a line boundary with a note', () => {
    expect(truncateDiff('short', 100)).toBe('short')
    const long = Array.from({ length: 200 }, (_, i) => `+line ${i}`).join('\n')
    const cut = truncateDiff(long, 300)
    expect(cut.length).toBeLessThan(400)
    expect(cut).toMatch(/diff truncated/)
    expect(cut.split('\n')[0]).toBe('+line 0')
  })
})
