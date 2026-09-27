import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { walkWorkspaceFiles } from '../workspace-file-indexer'

describe('walkWorkspaceFiles', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ai-workspace-indexer-test-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function write(relativePath: string, content = 'x'): void {
    const fullPath = join(root, relativePath)
    mkdirSync(join(fullPath, '..'), { recursive: true })
    writeFileSync(fullPath, content, 'utf8')
  }

  it('indexes an eligible source file with its content', () => {
    write('src/index.ts', 'export const x = 1')
    const files = walkWorkspaceFiles(root)
    const entry = files.find((f) => f.relativePath === 'src/index.ts')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('export const x = 1')
  })

  it('lists a file with an unsupported (but not denied) extension without ever reading its content', () => {
    write('notes.docx', 'binary-ish content')
    const files = walkWorkspaceFiles(root)
    const entry = files.find((f) => f.relativePath === 'notes.docx')
    expect(entry).toBeDefined()
    expect(entry?.content).toBeNull()
  })

  it('never indexes or lists a known binary extension at all (deny-listed, not just content-skipped)', () => {
    write('logo.png', 'binary-ish content')
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath === 'logo.png')).toBe(false)
  })

  it('never indexes or lists a .env file, regardless of .gitignore contents', () => {
    write('.env', 'SECRET_KEY=abc123')
    write('.gitignore', '') // empty — deny-list must apply even with no .gitignore rules
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath === '.env')).toBe(false)
  })

  it('never indexes or lists anything under node_modules/', () => {
    write('node_modules/some-pkg/index.js', 'module.exports = {}')
    write('src/app.ts', 'console.log(1)')
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath.startsWith('node_modules/'))).toBe(false)
    expect(files.some((f) => f.relativePath === 'src/app.ts')).toBe(true)
  })

  it('never indexes or lists anything under .git/', () => {
    write('.git/config', '[core]')
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath.startsWith('.git/'))).toBe(false)
  })

  it('never indexes a private key file', () => {
    write('id_rsa', '-----BEGIN OPENSSH PRIVATE KEY-----')
    write('server.pem', '-----BEGIN CERTIFICATE-----')
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath === 'id_rsa')).toBe(false)
    expect(files.some((f) => f.relativePath === 'server.pem')).toBe(false)
  })

  it('respects an additional exclusion from the workspace .gitignore', () => {
    write('.gitignore', 'scratch/\n')
    write('scratch/notes.txt', 'temp notes')
    write('src/keep.ts', 'export {}')
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath.startsWith('scratch/'))).toBe(false)
    expect(files.some((f) => f.relativePath === 'src/keep.ts')).toBe(true)
  })

  it('does not follow symlinks', () => {
    write('real/target.txt', 'real content')
    try {
      symlinkSync(join(root, 'real'), join(root, 'link'), 'junction')
    } catch {
      // Symlink creation can require elevated privileges on some Windows
      // configurations — skip rather than fail the suite in that case.
      return
    }
    const files = walkWorkspaceFiles(root)
    expect(files.some((f) => f.relativePath.startsWith('link/'))).toBe(false)
    expect(files.some((f) => f.relativePath === 'real/target.txt')).toBe(true)
  })

  it('combines a whole fixture tree and only ever surfaces the safe files', () => {
    write('.env.local', 'DB_PASSWORD=hunter2')
    write('node_modules/left-pad/index.js', 'module.exports = leftPad')
    write('.git/HEAD', 'ref: refs/heads/main')
    write('dist/bundle.js', 'console.log("built")')
    write('id_ed25519', 'private key material')
    write('README.md', '# Project')
    write('src/main.ts', 'console.log("hi")')

    const files = walkWorkspaceFiles(root)
    const paths = files.map((f) => f.relativePath).sort()

    expect(paths).toEqual(['README.md', 'src/main.ts'])
  })
})
