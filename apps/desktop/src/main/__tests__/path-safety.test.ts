import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  PathSafetyError,
  isSensitivePath,
  normalizeRelativePath,
  resolveInRoot,
} from '../code/path-safety'

let base: string
let root: string
let outside: string

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-paths-')))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), 'export {}')
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (err) {
    if (err instanceof PathSafetyError) return err.code
    throw err
  }
  return 'accepted'
}

/** Creates a directory link: a real symlink where permitted, else a junction (Windows, no privilege needed). */
function linkDir(target: string, link: string): 'symlink' | 'junction' {
  try {
    symlinkSync(target, link, 'dir')
    return 'symlink'
  } catch {
    symlinkSync(target, link, 'junction')
    return 'junction'
  }
}

describe('normalizeRelativePath', () => {
  it('normalizes separators, dots and duplicate slashes', () => {
    expect(normalizeRelativePath('src\\a.ts')).toBe('src/a.ts')
    expect(normalizeRelativePath('./src//a.ts')).toBe('src/a.ts')
    expect(normalizeRelativePath('src/./sub/')).toBe('src/sub')
  })

  it('rejects absolute paths: POSIX, backslash, drive letter and UNC', () => {
    for (const p of ['/etc/passwd', '\\windows\\system32', 'C:\\Windows\\win.ini', 'c:/x', '\\\\server\\share\\x', '//server/share']) {
      expect(() => normalizeRelativePath(p), p).toThrow(PathSafetyError)
    }
    try {
      normalizeRelativePath('/etc/passwd')
    } catch (err) {
      expect((err as PathSafetyError).code).toBe('absolute')
    }
  })

  it('rejects ".." traversal anywhere in the path', () => {
    for (const p of ['..', '../x', 'a/../../x', 'a/..', 'a\\..\\..\\x', 'a/b/../../../etc']) {
      expect(() => normalizeRelativePath(p), p).toThrow(/traversal/)
    }
  })

  it('rejects NUL bytes, ":" (alternate data streams) and Windows-stripped trailing dots/spaces', () => {
    expect(() => normalizeRelativePath('a\0b')).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath('file.txt:stream')).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath('.git./config')).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath('dir /x')).toThrow(PathSafetyError)
  })

  it('rejects non-strings and, unless allowed, the empty path', () => {
    expect(() => normalizeRelativePath(42)).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath(undefined)).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath('')).toThrow(PathSafetyError)
    expect(() => normalizeRelativePath('.')).toThrow(PathSafetyError)
    expect(normalizeRelativePath('', { allowRoot: true })).toBe('')
    expect(normalizeRelativePath('.', { allowRoot: true })).toBe('')
  })
})

describe('isSensitivePath (deny-list)', () => {
  it('flags .env files, keys, credentials and .git internals at any depth', () => {
    for (const p of [
      '.env',
      '.env.local',
      'apps/web/.env.production',
      'certs/server.pem',
      'deploy/id_rsa',
      'deploy/id_ed25519.pub',
      'config/aws-credentials.json',
      '.git/config',
      '.git/hooks/pre-commit',
      'packages/x/.git/HEAD',
      '.ssh/known_hosts',
      '.GIT/config',
      '.ENV',
    ]) {
      expect(isSensitivePath(p), p).toBe(true)
    }
  })

  it('does not flag ordinary source, dotfiles or noise (noise is hidden, not forbidden)', () => {
    for (const p of ['src/index.ts', '.gitignore', '.github/workflows/ci.yml', 'README.md', 'build/out.js', 'environment.ts', 'src/key-handler.ts']) {
      expect(isSensitivePath(p), p).toBe(false)
    }
  })
})

describe('resolveInRoot', () => {
  it('resolves ordinary and not-yet-existing files inside the root', async () => {
    const a = await resolveInRoot(root, 'src/a.ts')
    expect(a.exists).toBe(true)
    expect(a.relativePath).toBe('src/a.ts')
    expect(a.absolutePath).toBe(join(root, 'src', 'a.ts'))

    const fresh = await resolveInRoot(root, 'src/new-dir/new.ts')
    expect(fresh.exists).toBe(false)
    expect(fresh.absolutePath).toBe(join(root, 'src', 'new-dir', 'new.ts'))

    const top = await resolveInRoot(root, '', { allowRoot: true })
    expect(top.absolutePath).toBe(root)
  })

  it('rejects absolute, traversal and denied paths', async () => {
    expect(await code(resolveInRoot(root, join(outside, 'secret.txt')))).toBe('absolute')
    expect(await code(resolveInRoot(root, '../outside/secret.txt'))).toBe('traversal')
    expect(await code(resolveInRoot(root, 'src/../../outside/secret.txt'))).toBe('traversal')
    expect(await code(resolveInRoot(root, '.env'))).toBe('denied')
    expect(await code(resolveInRoot(root, '.git/config'))).toBe('denied')
    expect(await code(resolveInRoot(root, 'sub/.env.local'))).toBe('denied')
  })

  it('rejects a directory link (symlink or junction) that points outside the root', async () => {
    const kind = linkDir(outside, join(root, 'escape'))
    expect(await code(resolveInRoot(root, 'escape/secret.txt')), `via ${kind}`).toBe('escape')
    // Even a file that doesn't exist yet cannot be created through the link.
    expect(await code(resolveInRoot(root, 'escape/new.txt')), `via ${kind}`).toBe('escape')
    expect(await code(resolveInRoot(root, 'escape'))).toBe('escape')
  })

  it('rejects a FILE symlink that points outside the root (skipped when the OS refuses to create one)', async (ctx) => {
    try {
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file')
    } catch (err) {
      // Windows without Developer Mode / admin: EPERM. The directory-link case above
      // exercises the same realpath containment check, so this is the only skipped path.
      ctx.skip(`cannot create a file symlink here (${(err as NodeJS.ErrnoException).code})`)
      return
    }
    expect(await code(resolveInRoot(root, 'link.txt'))).toBe('escape')
  })

  it('allows a directory link that stays inside the root', async () => {
    linkDir(join(root, 'src'), join(root, 'src-alias'))
    const resolved = await resolveInRoot(root, 'src-alias/a.ts')
    expect(resolved.absolutePath).toBe(join(root, 'src', 'a.ts'))
  })

  it('re-checks the deny-list on the resolved location (a link into .git)', async () => {
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]')
    linkDir(join(root, '.git'), join(root, 'innocent'))
    expect(await code(resolveInRoot(root, 'innocent/config'))).toBe('denied')
  })

  it('refuses Windows 8.3 short-name spellings of .git when the volume has them', async (ctx) => {
    if (process.platform !== 'win32') return ctx.skip('Windows-only')
    mkdirSync(join(root, '.git'))
    writeFileSync(join(root, '.git', 'config'), '[core]')
    let short: string
    try {
      short = realpathSync.native(join(root, 'GIT~1'))
    } catch {
      return ctx.skip('8.3 short names are disabled on this volume')
    }
    expect(short.toLowerCase().endsWith('.git')).toBe(true)
    expect(await code(resolveInRoot(root, 'GIT~1/config'))).toBe('denied')
  })
})
