import { describe, expect, it, vi } from 'vitest'
import { CodeFileService } from '../code/file-service'
import {
  GIT_GLOBAL_ARGS,
  GitMissingError,
  GitService,
  buildGitInvocation,
  type GitRunResult,
  type GitRunner,
} from '../code/git-service'

const NUL = '\0'
const sha = 'a'.repeat(40)

function ok(stdout = ''): GitRunResult {
  return { code: 0, stdout: Buffer.from(stdout), stderr: '' }
}
function fail(code: number, stderr = ''): GitRunResult {
  return { code, stdout: Buffer.alloc(0), stderr }
}

/** A scripted git: every call is recorded; `respond` decides the answer by subcommand. */
function fakeGit(respond: (args: string[]) => GitRunResult | undefined) {
  const calls: { args: string[]; cwd: string; readOnly: boolean | undefined }[] = []
  const runner: GitRunner = async (args, options) => {
    calls.push({ args, cwd: options.cwd, readOnly: options.readOnly })
    return respond(args) ?? ok()
  }
  const files = new CodeFileService({ resolveRoot: () => 'C:/does-not-matter' })
  const service = new GitService({ resolveRoot: (id) => (id === 'ws' ? 'C:/repo' : null), files, runner })
  return { calls, service }
}

const subcommand = (args: string[]): string => args[0] as string

describe('buildGitInvocation (how git is launched)', () => {
  it('runs the git binary directly with an argument array - no shell, no string building', () => {
    const inv = buildGitInvocation(['add', '--', 'a; echo pwned & b.txt'], false, { PATH: 'x' })
    expect(inv.file).toBe('git')
    expect(inv.args).toEqual([...GIT_GLOBAL_ARGS, 'add', '--', 'a; echo pwned & b.txt'])
    // The hostile name is ONE argv element, untouched.
    expect(inv.args.at(-1)).toBe('a; echo pwned & b.txt')
  })

  it('disables repo-controlled command hooks for reads and never prompts', () => {
    const inv = buildGitInvocation(['status'], true, {})
    expect(inv.args.join(' ')).toContain('core.fsmonitor=false')
    expect(inv.args).toContain('--literal-pathspecs')
    expect(inv.env['GIT_TERMINAL_PROMPT']).toBe('0')
    expect(inv.env['GIT_OPTIONAL_LOCKS']).toBe('0')
    expect(buildGitInvocation(['commit'], false, {}).env['GIT_OPTIONAL_LOCKS']).toBeUndefined()
  })
})

describe('GitService argument construction', () => {
  it('stages literal paths after "--" and rejects absolute, traversal and .git paths', async () => {
    const { calls, service } = fakeGit(() => undefined)
    await service.stage('ws', ['src/a.ts', 'weird name; rm -rf x.txt', '--force', '*.ts'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toEqual(['add', '--', 'src/a.ts', 'weird name; rm -rf x.txt', '--force', '*.ts'])
    expect(calls[0]?.cwd).toBe('C:/repo')

    await expect(service.stage('ws', ['/etc/passwd'])).rejects.toMatchObject({ code: 'absolute' })
    await expect(service.stage('ws', ['C:\\x'])).rejects.toMatchObject({ code: 'absolute' })
    await expect(service.stage('ws', ['../outside.txt'])).rejects.toMatchObject({ code: 'traversal' })
    await expect(service.stage('ws', ['.git/config'])).rejects.toMatchObject({ code: 'denied' })
    await expect(service.stage('ws', ['sub/.GIT/hooks/x'])).rejects.toMatchObject({ code: 'denied' })
    expect(calls).toHaveLength(1) // nothing else reached git
  })

  it('chunks a large stage so the command line stays short', async () => {
    const { calls, service } = fakeGit(() => undefined)
    await service.stage('ws', Array.from({ length: 250 }, (_, i) => `f${i}.txt`))
    expect(calls.map((c) => c.args.length - 2)).toEqual([100, 100, 50])
  })

  it('unstages with restore --staged, or drops from the index on a repo with no commits', async () => {
    const withHead = fakeGit(() => undefined)
    await withHead.service.unstage('ws', ['a.ts'])
    expect(withHead.calls.map((c) => c.args)).toEqual([
      ['rev-parse', '--verify', '-q', 'HEAD'],
      ['restore', '--staged', '--', 'a.ts'],
    ])

    const unborn = fakeGit((args) => (subcommand(args) === 'rev-parse' ? fail(1) : undefined))
    await unborn.service.unstage('ws', ['a.ts'])
    expect(unborn.calls.at(-1)?.args).toEqual(['rm', '--cached', '-r', '-q', '--', 'a.ts'])
  })

  it('commits with -m as a single argument, only when something is staged and the message is non-empty', async () => {
    const message = '-m "; rm -rf /\nsecond line'
    const { calls, service } = fakeGit((args) => {
      if (subcommand(args) === 'diff') return fail(1) // staged changes exist
      if (subcommand(args) === 'log') return ok(`${sha}${NUL}aaaaaaa${NUL}subject\n`)
      return undefined
    })
    const summary = await service.commit('ws', message)
    expect(summary).toEqual({ sha, shortSha: 'aaaaaaa', subject: 'subject' })
    const commit = calls.find((c) => subcommand(c.args) === 'commit')
    expect(commit?.args).toEqual(['commit', '-m', message])

    const before = calls.length
    await expect(service.commit('ws', '   \n ')).rejects.toThrow(/empty/)
    expect(calls).toHaveLength(before) // rejected before touching git

    const nothing = fakeGit((args) => (subcommand(args) === 'diff' ? ok() : undefined))
    await expect(nothing.service.commit('ws', 'msg')).rejects.toThrow(/Nothing is staged/)
    expect(nothing.calls.some((c) => subcommand(c.args) === 'commit')).toBe(false)
  })

  it('surfaces a failing commit (e.g. no user.name) as an error with git\'s own words', async () => {
    const { service } = fakeGit((args) => {
      if (subcommand(args) === 'diff') return fail(1)
      if (subcommand(args) === 'commit') return fail(128, 'fatal: unable to auto-detect email address\n')
      return undefined
    })
    await expect(service.commit('ws', 'msg')).rejects.toThrow(/unable to auto-detect email/)
  })

  it('only ever issues the allow-listed read/stage/commit subcommands - never push, reset, clean, checkout or fetch', async () => {
    const { calls, service } = fakeGit((args) => {
      if (subcommand(args) === 'rev-parse' && args.includes('--is-inside-work-tree')) return ok('true\n\n')
      if (subcommand(args) === 'status') {
        return ok([`# branch.oid ${sha}`, '# branch.head main', `1 .M N... 100644 100644 100644 ${sha} ${sha} a.ts`, '? b.ts', ''].join(NUL))
      }
      if (subcommand(args) === 'diff' && args.includes('--quiet')) return fail(1)
      if (subcommand(args) === 'log') return ok(`${sha}${NUL}aaaaaaa${NUL}s`)
      return undefined
    })
    await service.status('ws')
    await service.diff('ws', 'a.ts', 'staged').catch(() => undefined)
    await service.diff('ws', 'a.ts', 'unstaged').catch(() => undefined)
    await service.stage('ws', ['a.ts'])
    await service.unstage('ws', ['a.ts'])
    await service.stageAll('ws')
    await service.unstageAll('ws')
    await service.commit('ws', 'm')
    const used = new Set(calls.map((c) => subcommand(c.args)))
    const allowed = new Set(['rev-parse', 'status', 'diff', 'log', 'show', 'add', 'restore', 'rm', 'commit'])
    for (const name of used) expect(allowed.has(name), name).toBe(true)
    for (const forbidden of ['push', 'pull', 'fetch', 'reset', 'clean', 'checkout', 'rebase', 'merge', 'stash', 'config', 'clone']) {
      expect(used.has(forbidden), forbidden).toBe(false)
    }
    for (const call of calls) expect(call.args.some((a) => /^--force|^-f$|--hard/.test(a)), call.args.join(' ')).toBe(false)
  })

  it('stage all skips files that match the secrets deny-list', async () => {
    const { calls, service } = fakeGit((args) => {
      if (subcommand(args) === 'rev-parse' && args.includes('--is-inside-work-tree')) return ok('true\n\n')
      if (subcommand(args) === 'status') {
        return ok(['# branch.oid (initial)', '# branch.head main', '? .env', '? keys/server.pem', '? src/ok.ts', ''].join(NUL))
      }
      return undefined
    })
    await service.stageAll('ws')
    const add = calls.find((c) => subcommand(c.args) === 'add')
    expect(add?.args).toEqual(['add', '--', 'src/ok.ts'])
  })
})

describe('GitService.status states', () => {
  it('reports git-missing without throwing', async () => {
    const files = new CodeFileService({ resolveRoot: () => 'C:/x' })
    const service = new GitService({
      resolveRoot: () => 'C:/repo',
      files,
      runner: () => Promise.reject(new GitMissingError()),
    })
    expect(await service.status('ws')).toEqual({ state: 'git-missing' })
  })

  it('reports not-a-repo when rev-parse fails', async () => {
    const { service } = fakeGit((args) => (subcommand(args) === 'rev-parse' ? fail(128, 'fatal: not a git repository') : undefined))
    expect(await service.status('ws')).toEqual({ state: 'not-a-repo' })
  })

  it('groups changes: staged vs unstaged vs untracked, with +N -M from numstat and protected flags', async () => {
    const { service } = fakeGit((args) => {
      if (subcommand(args) === 'rev-parse') return ok('true\n\n')
      if (subcommand(args) === 'status') {
        return ok(
          [
            `# branch.oid ${sha}`,
            '# branch.head main',
            `1 MM N... 100644 100644 100644 ${sha} ${sha} src/both.ts`,
            `1 A. N... 000000 100644 100644 ${sha} ${sha} src/added.ts`,
            '? .env',
            '',
          ].join(NUL),
        )
      }
      if (subcommand(args) === 'diff') {
        return args.includes('--cached')
          ? ok(`10\t2\tsrc/both.ts${NUL}4\t0\tsrc/added.ts${NUL}`)
          : ok(`1\t1\tsrc/both.ts${NUL}`)
      }
      if (subcommand(args) === 'log') return ok(`${sha}${NUL}aaaaaaa${NUL}init`)
      return undefined
    })
    const status = await service.status('ws')
    if (status.state !== 'ok') throw new Error('expected ok')
    expect(status.branch.head).toBe('main')
    expect(status.commit).toEqual({ sha, shortSha: 'aaaaaaa', subject: 'init' })
    expect(status.staged.map((c) => [c.path, c.status, c.additions, c.deletions])).toEqual([
      ['src/both.ts', 'modified', 10, 2],
      ['src/added.ts', 'added', 4, 0],
    ])
    expect(status.unstaged.map((c) => [c.path, c.status, c.additions, c.deletions])).toEqual([['src/both.ts', 'modified', 1, 1]])
    expect(status.untracked.map((c) => [c.path, c.protected])).toEqual([['.env', true]])
  })
})

describe('readOnly status calls', () => {
  it('marks every inspection call readOnly and every mutation not', async () => {
    const run = vi.fn<GitRunner>(async (args) => {
      if (subcommand(args) === 'rev-parse' && args.includes('--is-inside-work-tree')) return ok('true\n\n')
      return ok()
    })
    const files = new CodeFileService({ resolveRoot: () => 'C:/x' })
    const service = new GitService({ resolveRoot: () => 'C:/repo', files, runner: run })
    await service.status('ws')
    for (const [, options] of run.mock.calls) expect(options.readOnly).toBe(true)
    run.mockClear()
    await service.stage('ws', ['a'])
    expect(run.mock.calls[0]?.[1].readOnly).toBeFalsy()
  })
})
