import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_EDITABLE_FILE_BYTES, MAX_OPEN_FILE_BYTES } from '@ai-workspace/shared'
import { CodeFileService, decodeUtf8, looksBinary, sha256 } from '../code/file-service'
import { PathSafetyError } from '../code/path-safety'

let base: string
let root: string
let outside: string
let service: CodeFileService

function put(rel: string, content: string | Buffer): void {
  const full = join(root, ...rel.split('/'))
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-files-')))
  root = join(base, 'repo')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'top secret')
  service = new CodeFileService({ resolveRoot: (id) => (id === 'ws' ? root : null) })
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('size / binary / encoding detection', () => {
  it('detects NUL bytes in the first 8 KB as binary', () => {
    expect(looksBinary(Buffer.from('plain text'))).toBe(false)
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true)
    const late = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])])
    expect(looksBinary(late)).toBe(false)
  })

  it('decodes strict UTF-8 and rejects other encodings', () => {
    expect(decodeUtf8(Buffer.from('héllo ✓', 'utf8'))).toBe('héllo ✓')
    expect(decodeUtf8(Buffer.from([0x68, 0xe9, 0x6c]))).toBeNull() // latin-1 "hél"
  })
})

describe('readFile', () => {
  it('opens a text file with a content hash', async () => {
    put('src/a.ts', 'export const a = 1\n')
    const result = await service.readFile('ws', 'src/a.ts')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.content).toBe('export const a = 1\n')
    expect(result.hash).toBe(sha256('export const a = 1\n'))
    expect(result.readOnly).toBe(false)
    expect(result.relativePath).toBe('src/a.ts')
  })

  it('reports a missing file and a directory as states, not crashes', async () => {
    put('src/a.ts', 'x')
    expect((await service.readFile('ws', 'nope.ts')).status).toBe('missing')
    expect((await service.readFile('ws', 'src')).status).toBe('not-a-file')
  })

  it('shows deny-listed files as "denied" without reading them', async () => {
    put('.env', 'API_KEY=hunter2')
    put('keys/server.pem', '-----BEGIN PRIVATE KEY-----')
    put('.git/config', '[core]')
    for (const p of ['.env', 'keys/server.pem', '.git/config', 'sub/.env.local']) {
      const result = await service.readFile('ws', p)
      expect(result.status, p).toBe('denied')
      expect(JSON.stringify(result), p).not.toContain('hunter2')
    }
  })

  it('throws on absolute, traversal and symlink-escape paths', async () => {
    put('src/a.ts', 'x')
    await expect(service.readFile('ws', join(outside, 'secret.txt'))).rejects.toBeInstanceOf(PathSafetyError)
    await expect(service.readFile('ws', '../outside/secret.txt')).rejects.toBeInstanceOf(PathSafetyError)
    try {
      symlinkSync(outside, join(root, 'escape'), 'dir')
    } catch {
      symlinkSync(outside, join(root, 'escape'), 'junction')
    }
    await expect(service.readFile('ws', 'escape/secret.txt')).rejects.toMatchObject({ code: 'escape' })
  })

  it('rejects an unknown workspace / one without a folder', async () => {
    await expect(service.readFile('other', 'a.ts')).rejects.toThrow(/no folder/)
  })

  it('classifies binary files by extension, by NUL bytes and by invalid UTF-8', async () => {
    put('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    put('data.dat', Buffer.from([0x61, 0x00, 0x62]))
    put('latin1.txt', Buffer.from([0x68, 0xe9, 0x6c, 0x6c, 0x6f]))
    for (const p of ['logo.png', 'data.dat', 'latin1.txt']) {
      expect((await service.readFile('ws', p)).status, p).toBe('binary')
    }
  })

  it('opens files over the edit limit read-only and refuses files over the open limit', async () => {
    put('big.txt', 'a'.repeat(MAX_EDITABLE_FILE_BYTES + 10))
    const big = await service.readFile('ws', 'big.txt')
    expect(big.status).toBe('ok')
    if (big.status === 'ok') {
      expect(big.readOnly).toBe(true)
      expect(big.readOnlyReason).toMatch(/read-only/)
    }
    put('huge.txt', 'a'.repeat(MAX_OPEN_FILE_BYTES + 10))
    const huge = await service.readFile('ws', 'huge.txt')
    expect(huge.status).toBe('too-large')
    expect('content' in huge).toBe(false)
  })
})

describe('writeFile (atomic + stale-write protection)', () => {
  it('saves over an unchanged file and leaves no temp files behind', async () => {
    put('src/a.ts', 'one')
    const opened = await service.readFile('ws', 'src/a.ts')
    if (opened.status !== 'ok') throw new Error('expected ok')
    const result = await service.writeFile('ws', 'src/a.ts', 'two', opened.hash)
    expect(result.status).toBe('saved')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('two')
    if (result.status === 'saved') expect(result.hash).toBe(sha256('two'))
    expect(readdirSync(join(root, 'src'))).toEqual(['a.ts'])
  })

  it('returns a conflict, and leaves the file alone, when it changed on disk since it was opened', async () => {
    put('src/a.ts', 'one')
    const opened = await service.readFile('ws', 'src/a.ts')
    if (opened.status !== 'ok') throw new Error('expected ok')
    writeFileSync(join(root, 'src', 'a.ts'), 'edited elsewhere')
    const result = await service.writeFile('ws', 'src/a.ts', 'mine', opened.hash)
    expect(result).toEqual({ status: 'conflict', reason: 'changed', currentHash: sha256('edited elsewhere') })
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('edited elsewhere')
  })

  it('overwrites a conflicting file only when told to after the prompt', async () => {
    put('src/a.ts', 'one')
    const opened = await service.readFile('ws', 'src/a.ts')
    if (opened.status !== 'ok') throw new Error('expected ok')
    writeFileSync(join(root, 'src', 'a.ts'), 'edited elsewhere')
    const forced = await service.writeFile('ws', 'src/a.ts', 'mine', opened.hash, true)
    expect(forced.status).toBe('saved')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toBe('mine')
  })

  it('reports a file deleted since it was opened as a conflict', async () => {
    put('a.txt', 'one')
    const opened = await service.readFile('ws', 'a.txt')
    if (opened.status !== 'ok') throw new Error('expected ok')
    rmSync(join(root, 'a.txt'))
    expect(await service.writeFile('ws', 'a.txt', 'x', opened.hash)).toEqual({ status: 'conflict', reason: 'deleted', currentHash: null })
  })

  it('creates a new file (expectedHash null) but refuses to create over an existing one', async () => {
    expect((await service.writeFile('ws', 'fresh.ts', 'hi', null)).status).toBe('saved')
    expect(readFileSync(join(root, 'fresh.ts'), 'utf8')).toBe('hi')
    expect(await service.writeFile('ws', 'fresh.ts', 'again', null)).toMatchObject({ status: 'conflict', reason: 'exists' })
    await expect(service.writeFile('ws', 'no-such-dir/x.ts', 'hi', null)).rejects.toThrow(/does not exist/)
  })

  it('rejects absolute, traversal, symlink-escape and deny-listed targets', async () => {
    await expect(service.writeFile('ws', join(outside, 'x.txt'), 'x', null)).rejects.toMatchObject({ code: 'absolute' })
    await expect(service.writeFile('ws', '../outside/x.txt', 'x', null)).rejects.toMatchObject({ code: 'traversal' })
    await expect(service.writeFile('ws', '.env', 'KEY=1', null)).rejects.toMatchObject({ code: 'denied' })
    await expect(service.writeFile('ws', 'cfg/.env.production', 'KEY=1', null)).rejects.toMatchObject({ code: 'denied' })
    await expect(service.writeFile('ws', '.git/hooks/pre-commit', '#!/bin/sh', null)).rejects.toMatchObject({ code: 'denied' })
    try {
      symlinkSync(outside, join(root, 'escape'), 'dir')
    } catch {
      symlinkSync(outside, join(root, 'escape'), 'junction')
    }
    await expect(service.writeFile('ws', 'escape/pwned.txt', 'x', null)).rejects.toMatchObject({ code: 'escape' })
    await expect(service.writeFile('ws', 'escape/secret.txt', 'x', sha256('top secret'))).rejects.toMatchObject({ code: 'escape' })
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('top secret')
    expect(readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('refuses to write a directory or an oversized payload', async () => {
    put('src/a.ts', 'x')
    await expect(service.writeFile('ws', 'src', 'x', null)).rejects.toThrow(/regular file/)
    await expect(service.writeFile('ws', 'big.txt', 'a'.repeat(MAX_OPEN_FILE_BYTES + 1), null)).rejects.toThrow(/Refusing/)
  })

  it('preserves non-ASCII content and CRLF exactly', async () => {
    put('win.txt', 'a\r\nb\r\n')
    const opened = await service.readFile('ws', 'win.txt')
    if (opened.status !== 'ok') throw new Error('expected ok')
    await service.writeFile('ws', 'win.txt', 'a\r\nb\r\nc ✓\r\n', opened.hash)
    expect(readFileSync(join(root, 'win.txt'), 'utf8')).toBe('a\r\nb\r\nc ✓\r\n')
  })
})

describe('listDir / listPaths (deny-list + .gitignore reuse)', () => {
  beforeEach(() => {
    put('.gitignore', 'ignored.log\ntmp/\n')
    put('src/a.ts', 'a')
    put('src/b.ts', 'b')
    put('README.md', '# hi')
    put('ignored.log', 'x')
    put('tmp/cache.txt', 'x')
    put('node_modules/pkg/index.js', 'x')
    put('dist/out.js', 'x')
    put('.env', 'SECRET=1')
    put('.git/HEAD', 'ref: refs/heads/main')
    put('logo.png', Buffer.from([1, 2, 3]))
  })

  it('lists one level lazily: directories first, hiding deny-listed and gitignored entries', async () => {
    const top = await service.listDir('ws', '')
    expect(top.entries.map((e) => `${e.kind[0]}:${e.name}`)).toEqual(['d:src', 'f:.gitignore', 'f:README.md'])
    const src = await service.listDir('ws', 'src')
    expect(src.entries.map((e) => e.relativePath)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(src.entries[0]).toMatchObject({ kind: 'file', sizeBytes: 1 })
  })

  it('refuses to list a secret directory or to escape the root', async () => {
    await expect(service.listDir('ws', '.git')).rejects.toMatchObject({ code: 'denied' })
    await expect(service.listDir('ws', '..')).rejects.toMatchObject({ code: 'traversal' })
    await expect(service.listDir('ws', outside)).rejects.toMatchObject({ code: 'absolute' })
  })

  it('does not follow a link out of the root', async () => {
    try {
      symlinkSync(outside, join(root, 'escape'), 'dir')
    } catch {
      symlinkSync(outside, join(root, 'escape'), 'junction')
    }
    const top = await service.listDir('ws', '')
    expect(top.entries.map((e) => e.name)).not.toContain('escape')
  })

  it('lists the same visible paths flat for quick open', async () => {
    const { paths, truncated } = await service.listPaths('ws')
    expect(truncated).toBe(false)
    expect(paths).toEqual(['.gitignore', 'README.md', 'src/a.ts', 'src/b.ts'])
  })
})

describe('searchText (bounded scan with line numbers)', () => {
  beforeEach(() => {
    put('src/a.ts', 'const alpha = 1\nconst Beta = 2\n// alpha again\n')
    put('src/b.ts', 'nothing here\r\nBETA appears\r\n')
    put('.env', 'alpha=secret')
    put('node_modules/p/i.js', 'alpha')
    put('data.bin', Buffer.from([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00]))
  })

  it('finds matches with 1-based line and column, case-insensitively by default', async () => {
    const result = await service.searchText('ws', 'ALPHA')
    expect(result.matches).toEqual([
      { relativePath: 'src/a.ts', line: 1, column: 7, preview: 'const alpha = 1' },
      { relativePath: 'src/a.ts', line: 3, column: 4, preview: '// alpha again' },
    ])
    expect(result.truncated).toBe(false)
  })

  it('honors case sensitivity and handles CRLF lines', async () => {
    const sensitive = await service.searchText('ws', 'BETA', true)
    expect(sensitive.matches.map((m) => `${m.relativePath}:${m.line}`)).toEqual(['src/b.ts:2'])
    const insensitive = await service.searchText('ws', 'beta')
    expect(insensitive.matches.map((m) => `${m.relativePath}:${m.line}`).sort()).toEqual(['src/a.ts:2', 'src/b.ts:2'])
  })

  it('never searches secrets, ignored folders or binaries', async () => {
    const result = await service.searchText('ws', 'alpha')
    const files = new Set(result.matches.map((m) => m.relativePath))
    expect(files).toEqual(new Set(['src/a.ts']))
  })

  it('stops at the result limit and says so', async () => {
    put('many.txt', Array.from({ length: 50 }, () => 'needle').join('\n'))
    const result = await service.searchText('ws', 'needle', false, 5)
    expect(result.matches).toHaveLength(5)
    expect(result.truncated).toBe(true)
  })
})
