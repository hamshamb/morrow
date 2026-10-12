import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CodeFileService } from '../code/file-service'
import { GitService } from '../code/git-service'

/**
 * End-to-end against the REAL git binary in a throwaway repository: init,
 * commit, modify, stage, diff, commit. The temp repo carries its own local
 * user.name / user.email - global git config is never touched.
 */

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

let base: string
let repo: string
let service: GitService
let files: CodeFileService

function put(rel: string, content: string): void {
  const full = join(repo, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeAll(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-gitint-')))
  repo = join(base, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.name', 'Test User')
  git(repo, 'config', 'user.email', 'test@example.invalid')
  git(repo, 'config', 'commit.gpgsign', 'false')
  git(repo, 'config', 'core.autocrlf', 'false')
  files = new CodeFileService({ resolveRoot: (id) => (id === 'ws' ? repo : null) })
  service = new GitService({ resolveRoot: (id) => (id === 'ws' ? repo : null), files })
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('real git repository', () => {
  it('reports a repository with no commits: branch name, no commit, untracked files', async () => {
    put('hello.txt', 'one\ntwo\nthree\n')
    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(status)}`)
    expect(status.branch.head).toBe('main')
    expect(status.commit).toBeNull()
    expect(status.untracked.map((c) => [c.path, c.additions, c.deletions])).toEqual([['hello.txt', 3, 0]])
    expect(status.staged).toEqual([])
  })

  it('stages and commits the first file (unborn branch), then shows HEAD', async () => {
    await service.stage('ws', ['hello.txt'])
    let status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged.map((c) => [c.path, c.status, c.additions])).toEqual([['hello.txt', 'added', 3]])

    // Unstage on an unborn branch works (no HEAD to restore from) and is reversible.
    await service.unstage('ws', ['hello.txt'])
    status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged).toEqual([])
    expect(status.untracked.map((c) => c.path)).toEqual(['hello.txt'])

    await service.stage('ws', ['hello.txt'])
    const commit = await service.commit('ws', 'feat: add hello')
    expect(commit.subject).toBe('feat: add hello')
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(git(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Test User <test@example.invalid>')

    status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.commit?.subject).toBe('feat: add hello')
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
  })

  it('shows staged vs unstaged changes for a modified file, with line counts and both diff sides', async () => {
    put('hello.txt', 'one\nTWO\nthree\nfour\n') // 1 changed, 1 added vs HEAD
    await service.stage('ws', ['hello.txt'])
    put('hello.txt', 'one\nTWO\nthree\nfour\nfive\n') // one more line, unstaged

    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged.map((c) => [c.path, c.status, c.additions, c.deletions])).toEqual([['hello.txt', 'modified', 2, 1]])
    expect(status.unstaged.map((c) => [c.path, c.status, c.additions, c.deletions])).toEqual([['hello.txt', 'modified', 1, 0]])

    const staged = await service.diff('ws', 'hello.txt', 'staged')
    expect(staged).toEqual({
      status: 'ok',
      original: 'one\ntwo\nthree\n',
      modified: 'one\nTWO\nthree\nfour\n',
      originalLabel: 'HEAD',
      modifiedLabel: 'staged',
    })
    const unstaged = await service.diff('ws', 'hello.txt', 'unstaged')
    expect(unstaged).toMatchObject({
      status: 'ok',
      original: 'one\nTWO\nthree\nfour\n',
      modified: 'one\nTWO\nthree\nfour\nfive\n',
    })
  })

  it('handles awkward file names literally (spaces, shell metacharacters, glob characters)', async () => {
    const names = ['with space.txt', 'semi;colon & amp.txt', 'dollar$HOME.txt', "quote'd.txt", '[brackets].txt']
    // Characters illegal on Windows (* ? " < > |) can't be created here; the glob case is covered by [brackets].
    for (const name of names) put(`odd/${name}`, 'x\n')
    put('odd/other.txt', 'y\n')
    await service.stage('ws', ['odd/[brackets].txt']) // --literal-pathspecs: must not glob-match the other files
    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged.map((c) => c.path).filter((p) => p.startsWith('odd/'))).toEqual(['odd/[brackets].txt'])
    expect(status.untracked.map((c) => c.path)).toEqual(expect.arrayContaining(names.filter((n) => n !== '[brackets].txt').map((n) => `odd/${n}`)))
    // Nothing was executed as a shell command.
    expect(() => readFileSync(join(repo, 'pwned'))).toThrow()
  })

  it('diffs an untracked file against empty and refuses protected files', async () => {
    const result = await service.diff('ws', 'odd/other.txt', 'untracked')
    expect(result).toMatchObject({ status: 'ok', original: '', modified: 'y\n' })
    put('.env', 'API_KEY=hunter2\n')
    const protectedDiff = await service.diff('ws', '.env', 'untracked')
    expect(protectedDiff.status).toBe('protected')
    expect(JSON.stringify(protectedDiff)).not.toContain('hunter2')
    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.untracked.find((c) => c.path === '.env')).toMatchObject({ protected: true, additions: null })
  })

  it('stage all skips protected files; unstage all clears the index; commit needs a staged change and a message', async () => {
    await service.stageAll('ws')
    let status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged.map((c) => c.path)).not.toContain('.env')
    expect(status.untracked.map((c) => c.path)).toEqual(['.env'])
    expect(status.unstaged).toEqual([])

    await service.unstageAll('ws')
    status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged).toEqual([])

    await expect(service.commit('ws', 'nothing staged')).rejects.toThrow(/Nothing is staged/)
    await service.stage('ws', ['hello.txt'])
    await expect(service.commit('ws', '  ')).rejects.toThrow(/empty/)
    const commit = await service.commit('ws', 'fix: edit hello\n\nbody line')
    expect(git(repo, 'log', '-1', '--format=%B')).toBe('fix: edit hello\n\nbody line')
    expect(commit.subject).toBe('fix: edit hello')
  })

  it('tracks deletions and renames', async () => {
    git(repo, 'add', 'odd/other.txt')
    git(repo, 'commit', '-q', '-m', 'add other')
    rmSync(join(repo, 'odd', 'other.txt'))
    let status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.unstaged.find((c) => c.path === 'odd/other.txt')).toMatchObject({ status: 'deleted', additions: 0, deletions: 1 })
    const diff = await service.diff('ws', 'odd/other.txt', 'unstaged')
    expect(diff).toMatchObject({ status: 'ok', original: 'y\n', modified: '' })

    git(repo, 'checkout', '-q', '--', 'odd/other.txt') // test-only restore
    git(repo, 'mv', 'odd/other.txt', 'odd/renamed.txt')
    status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.staged.find((c) => c.path === 'odd/renamed.txt')).toMatchObject({ status: 'renamed', origPath: 'odd/other.txt' })
    const renamed = await service.diff('ws', 'odd/renamed.txt', 'staged', 'odd/other.txt')
    expect(renamed).toMatchObject({ status: 'ok', original: 'y\n', modified: 'y\n' })
  })

  it('reports a binary file without a text diff', async () => {
    writeFileSync(join(repo, 'blob.dat'), Buffer.from([0x61, 0x00, 0x62, 0x00]))
    const diff = await service.diff('ws', 'blob.dat', 'untracked')
    expect(diff.status).toBe('binary')
    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.untracked.find((c) => c.path === 'blob.dat')).toMatchObject({ binary: true })
  })

  it('says "not a repository" for a plain folder', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    const other = new GitService({ resolveRoot: () => plain, files })
    // A parent directory could itself be a repo on some machines; the temp dir is not.
    expect((await other.status('x')).state).toBe('not-a-repo')
  })

  it('works when the workspace folder is a subdirectory of the repository', async () => {
    mkdirSync(join(repo, 'pkg'), { recursive: true })
    put('pkg/inner.ts', 'export {}\n')
    put('outer-only.ts', 'export {}\n')
    const subFiles = new CodeFileService({ resolveRoot: () => join(repo, 'pkg') })
    const sub = new GitService({ resolveRoot: () => join(repo, 'pkg'), files: subFiles })
    const status = await sub.status('x')
    if (status.state !== 'ok') throw new Error('expected ok')
    const paths = status.untracked.map((c) => c.path)
    expect(paths).toContain('inner.ts')
    expect(paths).not.toContain('outer-only.ts')
    await sub.stage('x', ['inner.ts'])
    const after = await sub.status('x')
    if (after.state !== 'ok') throw new Error('expected ok')
    expect(after.staged.map((c) => c.path)).toEqual(['inner.ts'])
  })
})
