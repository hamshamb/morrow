import { describe, expect, it } from 'vitest'
import type { FsEntry, GitChange, GitStatus } from '@ai-workspace/shared'
import { ancestorDirs, baseName, dirName, extension, ipcErrorMessage } from '../paths'
import { rankPaths, scorePath } from '../quick-open'
import { EMPTY_TABS, closeTab, cycleTab, openTab, sanitizeSession } from '../tabs'
import { flattenTree, type TreeChildren } from '../tree'
import { buildMarkers, canCommit, commitBlockedReason, diffBars, statusLetter, totals } from '../git-ui'
import { FALLBACK_TOKENS, buildMonacoTheme, buildXtermTheme, isDarkTokens, mix, withAlpha, type ThemeTokens } from '../../monaco/theme'

describe('paths', () => {
  it('splits workspace-relative paths', () => {
    expect(baseName('src/app/main.ts')).toBe('main.ts')
    expect(baseName('README.md')).toBe('README.md')
    expect(dirName('src/app/main.ts')).toBe('src/app')
    expect(dirName('README.md')).toBe('')
    expect(ancestorDirs('a/b/c.ts')).toEqual(['a', 'a/b'])
    expect(ancestorDirs('c.ts')).toEqual([])
    expect(extension('src/Foo.TSX')).toBe('tsx')
    expect(extension('.gitignore')).toBe('')
    expect(extension('Makefile')).toBe('')
  })

  it('unwraps the Electron IPC error prefix', () => {
    expect(ipcErrorMessage(new Error("Error invoking remote method 'fs:read-file': PathSafetyError: Absolute paths are not allowed"))).toBe(
      'Absolute paths are not allowed',
    )
    expect(ipcErrorMessage(new Error("Error invoking remote method 'git:commit': Error: Nothing is staged"))).toBe('Nothing is staged')
    expect(ipcErrorMessage('plain')).toBe('plain')
  })
})

describe('quick open ranking', () => {
  const paths = [
    'src/components/Sidebar.tsx',
    'src/components/SidebarItem.tsx',
    'src/lib/side-effects.ts',
    'docs/sidebar-notes.md',
    'package.json',
    'src/index.ts',
  ]

  it('matches normalized substrings, and compacted queries against punctuated names', () => {
    expect(scorePath('sidebar', 'src/components/Sidebar.tsx')).not.toBeNull()
    expect(scorePath('sideeffects', 'src/lib/side-effects.ts')).not.toBeNull()
    expect(scorePath('zzz', 'src/index.ts')).toBeNull()
    expect(scorePath('', 'anything')).toBe(0)
  })

  it('requires every token (any order) and prefers file-name hits over directory hits', () => {
    const ranked = rankPaths(paths, 'side tsx').map((r) => r.path)
    expect(ranked).toEqual(['src/components/Sidebar.tsx', 'src/components/SidebarItem.tsx'])
    expect(rankPaths(paths, 'components index')).toEqual([])
  })

  it('ranks exact name, then name prefix, then name substring, then directory match', () => {
    const files = ['a/b/xindex.ts', 'index/readme.md', 'src/index.ts', 'src/reindexer.ts', 'src/index']
    const order = rankPaths(files, 'index').map((r) => r.path)
    expect(order[0]).toBe('src/index')
    expect(order.indexOf('src/index.ts')).toBeLessThan(order.indexOf('a/b/xindex.ts'))
    expect(order.indexOf('a/b/xindex.ts')).toBeLessThan(order.indexOf('index/readme.md'))
  })

  it('honors the result limit', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/file${i}.ts`)
    expect(rankPaths(many, 'file', 10)).toHaveLength(10)
  })
})

describe('tab state', () => {
  it('opens a new tab next to the active one and activates it', () => {
    let s = openTab(EMPTY_TABS, 'a')
    s = openTab(s, 'b')
    s = openTab(s, 'c')
    s = openTab({ ...s, active: 'a' }, 'd')
    expect(s.tabs).toEqual(['a', 'd', 'b', 'c'])
    expect(s.active).toBe('d')
  })

  it('re-opening an open file only activates it', () => {
    const s = openTab({ tabs: ['a', 'b'], active: 'a' }, 'b')
    expect(s).toEqual({ tabs: ['a', 'b'], active: 'b' })
  })

  it('closing the active tab activates its right neighbour, else its left, else nothing', () => {
    expect(closeTab({ tabs: ['a', 'b', 'c'], active: 'b' }, 'b')).toEqual({ tabs: ['a', 'c'], active: 'c' })
    expect(closeTab({ tabs: ['a', 'b', 'c'], active: 'c' }, 'c')).toEqual({ tabs: ['a', 'b'], active: 'b' })
    expect(closeTab({ tabs: ['a'], active: 'a' }, 'a')).toEqual({ tabs: [], active: null })
    expect(closeTab({ tabs: ['a', 'b', 'c'], active: 'a' }, 'c')).toEqual({ tabs: ['a', 'b'], active: 'a' })
    expect(closeTab({ tabs: ['a'], active: 'a' }, 'zzz')).toEqual({ tabs: ['a'], active: 'a' })
  })

  it('cycles with wrap-around and sanitizes a restored session', () => {
    expect(cycleTab({ tabs: ['a', 'b', 'c'], active: 'c' }, 1).active).toBe('a')
    expect(cycleTab({ tabs: ['a', 'b', 'c'], active: 'a' }, -1).active).toBe('c')
    expect(cycleTab({ tabs: ['a'], active: 'a' }, 1).active).toBe('a')
    expect(sanitizeSession(['a', 'b', 'a'], 'zzz')).toEqual({ tabs: ['a', 'b'], active: 'a' })
    expect(sanitizeSession([], 'x')).toEqual({ tabs: [], active: null })
  })
})

describe('flattenTree (lazy)', () => {
  const dir = (path: string): FsEntry => ({ name: path.split('/').pop() as string, relativePath: path, kind: 'directory', sizeBytes: null })
  const file = (path: string): FsEntry => ({ name: path.split('/').pop() as string, relativePath: path, kind: 'file', sizeBytes: 1 })

  it('shows children only for expanded, loaded directories', () => {
    const children: TreeChildren = {
      '': [dir('src'), dir('docs'), file('README.md')],
      src: [dir('src/lib'), file('src/index.ts')],
      'src/lib': [file('src/lib/a.ts')],
    }
    const collapsed = flattenTree(children, new Set())
    expect(collapsed.map((r) => r.entry.relativePath)).toEqual(['src', 'docs', 'README.md'])

    const open = flattenTree(children, new Set(['src', 'src/lib']))
    expect(open.map((r) => `${r.depth}:${r.entry.relativePath}`)).toEqual(['0:src', '1:src/lib', '2:src/lib/a.ts', '1:src/index.ts', '0:docs', '0:README.md'])
  })

  it('marks an expanded directory whose listing has not arrived yet, and renders nothing below it', () => {
    const children: TreeChildren = { '': [dir('src')], src: 'loading' }
    const rows = flattenTree(children, new Set(['src']))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ expanded: true, loading: true })
  })
})

const change = (over: Partial<GitChange>): GitChange => ({
  path: 'a.ts',
  origPath: null,
  status: 'modified',
  additions: 1,
  deletions: 0,
  binary: false,
  protected: false,
  ...over,
})

type OkStatus = Extract<GitStatus, { state: 'ok' }>
const okStatus = (staged: GitChange[]): OkStatus => ({
  state: 'ok',
  branch: { head: 'main', detached: false, upstream: null, ahead: 0, behind: 0 },
  commit: null,
  staged,
  unstaged: [],
  untracked: [],
  conflicted: [],
  truncated: false,
})

describe('git ui helpers', () => {
  it('gates the commit button on a staged change, a message and an idle state', () => {
    const staged = okStatus([change({})])
    expect(canCommit(staged, 'feat: x', false)).toBe(true)
    expect(canCommit(staged, '   ', false)).toBe(false)
    expect(canCommit(staged, 'feat: x', true)).toBe(false)
    expect(canCommit(okStatus([]), 'feat: x', false)).toBe(false)
    expect(canCommit({ state: 'not-a-repo' }, 'feat: x', false)).toBe(false)
    expect(canCommit(null, 'feat: x', false)).toBe(false)
    expect(commitBlockedReason(okStatus([]), 'x')).toBe('nothing is staged')
    expect(commitBlockedReason(staged, '')).toBe('write a commit message')
    expect(commitBlockedReason(staged, 'x')).toBeNull()
  })

  it('letters and totals', () => {
    expect(statusLetter('untracked')).toBe('U')
    expect(statusLetter('renamed')).toBe('R')
    expect(totals([change({ additions: 3, deletions: 1 }), change({ additions: null, deletions: null, binary: true }), change({ additions: 2, deletions: 4 })])).toEqual({
      additions: 5,
      deletions: 5,
    })
  })

  it('builds one tree marker per path with conflicts and untracked files taking priority', () => {
    const status: OkStatus = {
      ...okStatus([change({ path: 'a.ts', status: 'added' }), change({ path: 'b.ts', status: 'modified' })]),
      unstaged: [change({ path: 'b.ts', status: 'deleted' })],
      untracked: [change({ path: 'c.ts', status: 'untracked' })],
      conflicted: [change({ path: 'a.ts', status: 'conflicted' })],
    }
    expect(Object.fromEntries(buildMarkers(status))).toEqual({ 'a.ts': '!', 'b.ts': 'D', 'c.ts': 'U' })
    expect(buildMarkers(null).size).toBe(0)
    expect(buildMarkers({ state: 'not-a-repo' }).size).toBe(0)
  })

  it('allocates the five-block bar in proportion, giving each non-zero side a block', () => {
    expect(diffBars(0, 0)).toEqual(['neutral', 'neutral', 'neutral', 'neutral', 'neutral'])
    expect(diffBars(10, 0)).toEqual(['add', 'add', 'add', 'add', 'add'])
    expect(diffBars(0, 7)).toEqual(['delete', 'delete', 'delete', 'delete', 'delete'])
    const mixed = diffBars(1, 99)
    expect(mixed.filter((b) => b === 'add')).toHaveLength(1)
    expect(mixed).toHaveLength(5)
    const half = diffBars(5, 5)
    expect(half.filter((b) => b === 'add').length + half.filter((b) => b === 'delete').length).toBe(5)
  })
})

const DARK: ThemeTokens = {
  paper: '#131312',
  raised: '#1b1b19',
  sunken: '#0d0d0c',
  ink: '#e9e5da',
  muted: '#a39f94',
  rule: '#3b3a36',
  ruleStrong: '#77746b',
  signal: '#f07361',
  link: '#8db0ff',
  ok: '#74c294',
  highlight: '#4a4320',
  focus: '#8db0ff',
  selection: '#2b3d63',
  codeFunction: '#e3a866',
  codeChanged: '#d9bd5c',
}

describe('editor / terminal themes derive from the nochan tokens', () => {
  it('color helpers', () => {
    expect(withAlpha('#74c294', 0.5)).toBe('#74c29480')
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('detects dark vs light from the page background', () => {
    expect(isDarkTokens(DARK)).toBe(true)
    expect(isDarkTokens(FALLBACK_TOKENS)).toBe(false)
  })

  it('builds the Monaco theme from tokens - dark and light', () => {
    const dark = buildMonacoTheme(DARK)
    expect(dark.base).toBe('vs-dark')
    expect(dark.colors['editor.background']).toBe(DARK.paper)
    expect(dark.colors['editor.foreground']).toBe(DARK.ink)
    expect(dark.colors['editor.selectionBackground']).toBe(DARK.selection)
    expect(dark.rules.find((r) => r.token === 'keyword')?.foreground).toBe('8db0ff')
    expect(dark.rules.find((r) => r.token === 'string')?.foreground).toBe('74c294')
    expect(dark.rules.find((r) => r.token === 'comment')?.foreground).toBe('a39f94')

    const light = buildMonacoTheme(FALLBACK_TOKENS)
    expect(light.base).toBe('vs')
    expect(light.colors['editor.background']).toBe(FALLBACK_TOKENS.paper)
    // Every color the theme sets is a hex Monaco accepts.
    for (const value of Object.values({ ...dark.colors, ...light.colors })) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
  })

  it('builds the xterm theme from the same tokens', () => {
    const t = buildXtermTheme(DARK)
    expect(t.background).toBe(DARK.sunken)
    expect(t.foreground).toBe(DARK.ink)
    expect(t.red).toBe(DARK.signal)
    expect(t.green).toBe(DARK.ok)
    expect(t.blue).toBe(DARK.link)
    expect(t.yellow).toBe(DARK.codeChanged)
    for (const value of Object.values(t)) expect(value).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/)
    expect(buildXtermTheme(FALLBACK_TOKENS).background).toBe(FALLBACK_TOKENS.sunken)
  })
})
