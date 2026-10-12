import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_IDS, WRITE_OVERWRITE_MAX_BYTES, toolWireName } from '@ai-workspace/shared'
import { ALL_TOOL_DEFINITIONS, getToolById, getToolByWireName } from '../agent/tools/registry'
import { git, makeHarness, put, type Harness } from './agent-harness'

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const bytes = (root: string, rel: string): Buffer => readFileSync(join(root, ...rel.split('/')))

const SOURCE = [
  'export function add(a: number, b: number): number {',
  '  return a - b',
  '}',
  '',
  'export function sub(a: number, b: number): number {',
  '  return a - b',
  '}',
  '',
].join('\n')

let h: Harness
afterEach(() => h?.cleanup())

describe('the tool registry', () => {
  it('has exactly the ten required tools, each with a unique wire name and a JSON-schema-able input', () => {
    expect([...TOOL_IDS].sort()).toEqual(
      ['filesystem.list', 'filesystem.patch', 'filesystem.read', 'filesystem.search', 'filesystem.write', 'git.diff', 'git.log', 'git.status', 'terminal.execute', 'workspace.search'].sort(),
    )
    expect(ALL_TOOL_DEFINITIONS.map((t) => t.id).sort()).toEqual([...TOOL_IDS].sort())
    for (const tool of ALL_TOOL_DEFINITIONS) {
      expect(getToolById(tool.id)).toBe(tool)
      expect(getToolByWireName(toolWireName(tool.id))).toBe(tool)
      expect(tool.description.length).toBeGreaterThan(30)
      const schema = z.toJSONSchema(tool.inputSchema, { target: 'draft-7' })
      expect(schema).toMatchObject({ type: 'object' })
    }
  })

  it('has no tool that commits, pushes, resets, checks out or cleans', () => {
    for (const id of TOOL_IDS) expect(id).not.toMatch(/commit|push|reset|checkout|clean|rebase|stash|delete|remove/)
  })

  it('risk classes: reads are safe, edits write, the terminal executes', () => {
    const risk = (id: (typeof TOOL_IDS)[number]) => getToolById(id)?.risk
    for (const id of ['filesystem.read', 'filesystem.list', 'filesystem.search', 'workspace.search', 'git.status', 'git.diff', 'git.log'] as const) expect(risk(id)).toBe('safe')
    expect(risk('filesystem.write')).toBe('write')
    expect(risk('filesystem.patch')).toBe('write')
    expect(risk('terminal.execute')).toBe('execution')
  })
})

describe('filesystem.read', () => {
  beforeEach(() => {
    h = makeHarness({ files: { 'src/a.ts': SOURCE, 'big.txt': Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join('\n') + '\n' } })
  })

  it('returns the file content and remembers its hash for later edits', async () => {
    const out = await h.call('filesystem_read', { path: 'src/a.ts' })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('return a - b')
    expect(out.text).toContain('src/a.ts')
    expect(h.executor.reads.get('src/a.ts')).toBe(sha(SOURCE))
  })

  it('does not ask for permission (safe) and records an audit row', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    expect(h.prompts).toHaveLength(0)
    const rows = h.repo.listToolRuns(h.runId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ toolId: 'filesystem.read', risk: 'safe', status: 'ok', decisionSource: 'default-safe', label: 'read src/a.ts' })
  })

  it('pages with offset and limit and says how to continue', async () => {
    const first = await h.call('filesystem_read', { path: 'big.txt', limit: 10 })
    expect(first.text).toContain('lines 1-10 of 1000')
    expect(first.text).toContain('offset=11')
    expect(first.text).not.toContain('line 11\n')
    const mid = await h.call('filesystem_read', { path: 'big.txt', offset: 500, limit: 3 })
    expect(mid.text).toContain('line 500\nline 501\nline 502')
    expect(mid.text).toContain('lines 500-502 of 1000')
  })

  it('caps a long read at the default line count', async () => {
    const out = await h.call('filesystem_read', { path: 'big.txt' })
    expect(out.text).toContain('lines 1-400 of 1000')
    expect(out.text).toContain('offset=401')
  })

  it('refuses secrets and .git internals, without leaking content', async () => {
    put(h.root, '.env', 'API_KEY=supersecretvalue123\n')
    for (const path of ['.env', '.git/config', '.git/HEAD']) {
      const out = await h.call('filesystem_read', { path })
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/blocked|deny-list|not available|secret/i)
    }
    const env = await h.call('filesystem_read', { path: '.env' })
    expect(env.text).not.toContain('supersecretvalue123')
  })

  it('rejects absolute paths, traversal and odd spellings with an actionable message', async () => {
    for (const path of ['/etc/passwd', 'C:\\Windows\\win.ini', '..\\outside.txt', '../outside.txt', 'src/../../x', 'a:b', 'src/a.ts.', '\\\\server\\share\\x']) {
      const out = await h.call('filesystem_read', { path })
      expect(out.isError, path).toBe(true)
      expect(out.text, path).toMatch(/relative|not allowed|blocked|traversal|absolute/i)
    }
  })

  it('refuses a symlink / junction that points outside the workspace', async () => {
    const outside = join(h.root, '..', `aiw-outside-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'outside content')
    try {
      symlinkSync(outside, join(h.root, 'link'), 'junction')
    } catch {
      return // this OS refused to create the link; path-safety.test.ts covers the same check
    }
    const out = await h.call('filesystem_read', { path: 'link/secret.txt' })
    expect(out.isError).toBe(true)
    expect(out.text).not.toContain('outside content')
  })

  it('explains a missing file, a directory and a binary file', async () => {
    put(h.root, 'logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    expect((await h.call('filesystem_read', { path: 'nope.ts' })).text).toMatch(/not found/i)
    expect((await h.call('filesystem_read', { path: 'src' })).text).toMatch(/not a regular file|directory/i)
    expect((await h.call('filesystem_read', { path: 'logo.png' })).text).toMatch(/binary|not readable text/i)
  })

  it('rejects malformed arguments before doing anything', async () => {
    const out = await h.call('filesystem_read', { path: 42 })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/Invalid arguments/)
    expect(h.repo.listToolRuns(h.runId)[0]).toMatchObject({ status: 'error', decisionSource: 'not-asked' })
  })
})

describe('filesystem.list and search', () => {
  beforeEach(() => {
    h = makeHarness({
      files: { 'src/a.ts': SOURCE, 'src/lib/util.ts': 'export const answer = 42\n', 'docs/readme.md': '# hi\nthe answer is here\n' },
    })
    mkdirSync(join(h.root, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(h.root, 'node_modules', 'pkg', 'index.js'), 'answer')
    put(h.root, '.env', 'TOKEN=abcdef123456')
  })

  it('lists one level, directories first, hiding deny-listed and ignored entries', async () => {
    const root = await h.call('filesystem_list', {})
    expect(root.text).toContain('src/')
    expect(root.text).toContain('docs/')
    expect(root.text).not.toContain('node_modules')
    expect(root.text).not.toContain('.git/')
    expect(root.text).not.toContain('.env')
    const src = await h.call('filesystem_list', { path: 'src' })
    expect(src.text).toContain('src/a.ts')
    expect(src.text).toContain('src/lib/')
    expect(src.text.indexOf('src/lib/')).toBeLessThan(src.text.indexOf('src/a.ts'))
  })

  it('searches content with line numbers and never searches secrets or ignored folders', async () => {
    const out = await h.call('filesystem_search', { query: 'answer' })
    expect(out.text).toContain('src/lib/util.ts:1:')
    expect(out.text).toContain('docs/readme.md:2:')
    expect(out.text).not.toContain('node_modules')
    const secret = await h.call('filesystem_search', { query: 'abcdef123456' })
    expect(secret.text).toMatch(/No matches/)
    expect(secret.text).not.toContain('.env')
  })

  it('reports no matches plainly', async () => {
    const out = await h.call('filesystem_search', { query: 'zzz-not-there' })
    expect(out.text).toMatch(/No matches/)
    expect(h.repo.listToolRuns(h.runId).at(-1)?.summary).toBe('no matches')
  })

  it('workspace.search uses the FTS index', async () => {
    const { WorkspaceFileRepository } = await import('@ai-workspace/storage')
    new WorkspaceFileRepository(h.db).replaceIndex(h.workspaceId, [
      { relativePath: 'docs/readme.md', sizeBytes: 10, mtimeMs: 1, content: 'the quick brown fox' },
    ])
    const hit = await h.call('workspace_search', { query: 'fox' })
    expect(hit.text).toContain('docs/readme.md')
    const miss = await h.call('workspace_search', { query: 'unicorn' })
    expect(miss.text).toMatch(/No indexed matches/)
  })
})

describe('filesystem.patch', () => {
  beforeEach(() => {
    h = makeHarness({ files: { 'src/a.ts': SOURCE } })
    h.answers.push('allow_once', 'allow_once', 'allow_once', 'allow_once')
  })

  const patch = (extra: Record<string, unknown> = {}) =>
    h.call('filesystem_patch', {
      path: 'src/a.ts',
      old_string: 'export function add(a: number, b: number): number {\n  return a - b\n}',
      new_string: 'export function add(a: number, b: number): number {\n  return a + b\n}',
      ...extra,
    })

  it('applies an exact-once replacement, verifies it by re-reading, and returns a correct unified diff', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    const out = await patch()
    expect(out.isError).toBe(false)
    const expected = SOURCE.replace('return a - b\n}\n\nexport function sub', 'return a + b\n}\n\nexport function sub')
    expect(bytes(h.root, 'src/a.ts').toString('utf8')).toBe(expected)
    expect(out.text).toContain('+1 -1')
    expect(out.text).toContain('verified by re-reading')
    expect(out.text).toContain('--- a/src/a.ts')
    expect(out.text).toContain('+++ b/src/a.ts')
    expect(out.text).toContain('-  return a - b')
    expect(out.text).toContain('+  return a + b')
    const row = h.repo.listToolRuns(h.runId).find((r) => r.toolId === 'filesystem.patch')
    expect(row).toMatchObject({ status: 'ok', summary: '+1 -1', decisionSource: 'prompt-once' })
    expect(row?.detail).toContain('+  return a + b')
  })

  it('asks first, with the diff in the prompt, and writes nothing before the answer', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    h.autoAnswer = false
    let seen = ''
    h.onPrompt = (request) => {
      seen = readFileSync(join(h.root, 'src', 'a.ts'), 'utf8')
      expect(request.preview).toMatchObject({ kind: 'patch', path: 'src/a.ts', added: 1, removed: 1 })
      expect((request.preview as { diff: string }).diff).toContain('+  return a + b')
      h.engine.respond({ requestId: request.requestId, decision: 'allow_once' })
    }
    const out = await patch()
    expect(out.isError).toBe(false)
    expect(seen).toBe(SOURCE) // still the original while the prompt was open
    expect(h.prompts).toHaveLength(1)
  })

  it('deny leaves the file byte-identical and tells the model not to retry', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    h.answers.length = 0
    h.answers.push('deny')
    const before = bytes(h.root, 'src/a.ts')
    const out = await patch()
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/DENIED/)
    expect(bytes(h.root, 'src/a.ts').equals(before)).toBe(true)
    expect(h.repo.listToolRuns(h.runId).find((r) => r.toolId === 'filesystem.patch')).toMatchObject({ status: 'denied', decisionSource: 'prompt-deny' })
    expect(h.repo.listSnapshots(h.runId)).toEqual([])
  })

  it('zero matches: error back to the model, nothing written, no prompt', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    const before = bytes(h.root, 'src/a.ts')
    const out = await patch({ old_string: 'return a * b' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/not found/i)
    expect(bytes(h.root, 'src/a.ts').equals(before)).toBe(true)
    expect(h.prompts).toHaveLength(0)
  })

  it('hints when the text exists apart from whitespace', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    const out = await patch({ old_string: 'export function add(a: number, b: number): number {\n    return a - b\n}' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/apart from whitespace/i)
  })

  it('several matches: error, nothing written', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    const before = bytes(h.root, 'src/a.ts')
    const out = await patch({ old_string: 'return a - b', new_string: 'return a + b' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/matches 2 places/)
    expect(bytes(h.root, 'src/a.ts').equals(before)).toBe(true)
    expect(h.prompts).toHaveLength(0)
  })

  it('refuses an empty old_string and an identical replacement', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    expect((await patch({ old_string: '' })).isError).toBe(true)
    expect((await patch({ old_string: 'return a - b\n}\n\nexport', new_string: 'return a - b\n}\n\nexport' })).text).toMatch(/identical/)
  })

  it('refuses to edit a file the agent has not read in this run', async () => {
    const before = bytes(h.root, 'src/a.ts')
    const out = await patch()
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/have not read/)
    expect(bytes(h.root, 'src/a.ts').equals(before)).toBe(true)
  })

  it('STALE hash: a file edited after the agent read it is refused with an instruction to re-read', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    writeFileSync(join(h.root, 'src', 'a.ts'), SOURCE + '// edited by the user in the meantime\n')
    const edited = bytes(h.root, 'src/a.ts')
    const out = await patch()
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/changed on disk since you last read it/)
    expect(out.text).toMatch(/filesystem\.read again/)
    expect(bytes(h.root, 'src/a.ts').equals(edited)).toBe(true)
    expect(h.prompts).toHaveLength(0)
    // After re-reading, the same patch goes through.
    await h.call('filesystem_read', { path: 'src/a.ts' })
    expect((await patch()).isError).toBe(false)
    expect(bytes(h.root, 'src/a.ts').toString('utf8')).toContain('// edited by the user in the meantime')
  })

  it('a file edited WHILE the permission prompt is open is not overwritten', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    h.onPrompt = () => {
      writeFileSync(join(h.root, 'src', 'a.ts'), SOURCE.replace('sub', 'subtract'))
    }
    const out = await patch()
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/changed while the request was waiting|changed on disk/)
    expect(bytes(h.root, 'src/a.ts').toString('utf8')).toBe(SOURCE.replace('sub', 'subtract'))
  })

  it('after its own patch, a second patch needs no re-read (the agent knows its own write)', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    expect((await patch()).isError).toBe(false)
    const second = await h.call('filesystem_patch', { path: 'src/a.ts', old_string: 'export function sub(a: number, b: number): number {\n  return a - b', new_string: 'export function sub(a: number, b: number): number {\n  return a - b + 0' })
    expect(second.isError).toBe(false)
  })

  it('works on CRLF files when old_string is typed with LF, and keeps CRLF', async () => {
    put(h.root, 'win.txt', 'one\r\ntwo\r\nthree\r\n')
    await h.call('filesystem_read', { path: 'win.txt' })
    const out = await h.call('filesystem_patch', { path: 'win.txt', old_string: 'two\nthree', new_string: 'TWO\nTHREE' })
    expect(out.isError).toBe(false)
    expect(bytes(h.root, 'win.txt').toString('utf8')).toBe('one\r\nTWO\r\nTHREE\r\n')
  })

  it('keeps a UTF-8 BOM', async () => {
    put(h.root, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\nbeta\n')]))
    await h.call('filesystem_read', { path: 'bom.txt' })
    const out = await h.call('filesystem_patch', { path: 'bom.txt', old_string: 'beta', new_string: 'gamma' })
    expect(out.isError).toBe(false)
    const written = bytes(h.root, 'bom.txt')
    expect([...written.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(written.subarray(3).toString('utf8')).toBe('alpha\ngamma\n')
  })

  it('cannot patch secrets, .git, paths outside the workspace, or a file that does not exist', async () => {
    put(h.root, '.env', 'KEY=value1234\n')
    for (const path of ['.env', '.git/config', '../outside.txt', '/etc/hosts']) {
      const out = await h.call('filesystem_patch', { path, old_string: 'a', new_string: 'b' })
      expect(out.isError, path).toBe(true)
    }
    const missing = await h.call('filesystem_patch', { path: 'nope.ts', old_string: 'a', new_string: 'b' })
    expect(missing.text).toMatch(/does not exist/)
    expect(readFileSync(join(h.root, '.env'), 'utf8')).toBe('KEY=value1234\n')
  })

  it('snapshots the exact pre-edit bytes (CRLF, BOM, odd bytes) so a revert can restore them', async () => {
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('keep\r\nthis\r\nexactly\r\n')])
    put(h.root, 'exact.txt', original)
    await h.call('filesystem_read', { path: 'exact.txt' })
    await h.call('filesystem_patch', { path: 'exact.txt', old_string: 'this', new_string: 'that' })
    const snap = h.repo.getSnapshot(h.runId, 'exact.txt')
    expect(snap?.beforeContent?.equals(original)).toBe(true)
    expect(snap?.beforeHash).toBe(sha(original))
    expect(snap?.afterHash).toBe(sha(bytes(h.root, 'exact.txt')))
  })

  it('a later edit to the same file keeps the FIRST pre-run snapshot', async () => {
    await h.call('filesystem_read', { path: 'src/a.ts' })
    await patch()
    await h.call('filesystem_patch', { path: 'src/a.ts', old_string: 'export function sub', new_string: 'export function minus' })
    const snap = h.repo.getSnapshot(h.runId, 'src/a.ts')
    expect(snap?.beforeContent?.toString('utf8')).toBe(SOURCE)
    expect(snap?.afterHash).toBe(sha(bytes(h.root, 'src/a.ts')))
  })
})

describe('filesystem.write', () => {
  beforeEach(() => {
    h = makeHarness({ files: { 'src/a.ts': SOURCE, 'small.txt': 'old\n', 'large.txt': 'x'.repeat(WRITE_OVERWRITE_MAX_BYTES + 100) + '\n' } })
    h.answers.push('allow_once', 'allow_once', 'allow_once', 'allow_once')
  })

  it('creates a new file, including missing parent folders, and snapshots "did not exist"', async () => {
    const out = await h.call('filesystem_write', { path: 'src/new/deep/file.ts', content: 'export const x = 1\n' })
    expect(out.isError).toBe(false)
    expect(readFileSync(join(h.root, 'src', 'new', 'deep', 'file.ts'), 'utf8')).toBe('export const x = 1\n')
    expect(out.text).toMatch(/Created/)
    expect(h.repo.getSnapshot(h.runId, 'src/new/deep/file.ts')?.beforeContent).toBeNull()
    const request = h.prompts[0]
    expect(request?.preview).toMatchObject({ kind: 'write', isNew: true, path: 'src/new/deep/file.ts' })
  })

  it('refuses to overwrite an existing file that was not read first', async () => {
    const out = await h.call('filesystem_write', { path: 'small.txt', content: 'new\n' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/have not read/)
    expect(readFileSync(join(h.root, 'small.txt'), 'utf8')).toBe('old\n')
  })

  it('overwrites a small file after it was read', async () => {
    await h.call('filesystem_read', { path: 'small.txt' })
    const out = await h.call('filesystem_write', { path: 'small.txt', content: 'new\n' })
    expect(out.isError).toBe(false)
    expect(readFileSync(join(h.root, 'small.txt'), 'utf8')).toBe('new\n')
  })

  it(`refuses to overwrite an existing file above ${WRITE_OVERWRITE_MAX_BYTES} bytes and points at filesystem.patch`, async () => {
    await h.call('filesystem_read', { path: 'large.txt' })
    const before = bytes(h.root, 'large.txt')
    const out = await h.call('filesystem_write', { path: 'large.txt', content: 'tiny\n' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/filesystem\.patch/)
    expect(bytes(h.root, 'large.txt').equals(before)).toBe(true)
    expect(h.prompts).toHaveLength(0)
  })

  it('but a NEW large file is fine (the rule protects existing content)', async () => {
    const out = await h.call('filesystem_write', { path: 'fresh-large.txt', content: 'y'.repeat(WRITE_OVERWRITE_MAX_BYTES * 3) })
    expect(out.isError).toBe(false)
    expect(bytes(h.root, 'fresh-large.txt').length).toBe(WRITE_OVERWRITE_MAX_BYTES * 3)
  })

  it('refuses identical content, secrets paths and traversal', async () => {
    await h.call('filesystem_read', { path: 'small.txt' })
    expect((await h.call('filesystem_write', { path: 'small.txt', content: 'old\n' })).text).toMatch(/nothing to write/)
    for (const path of ['.env', '.git/hooks/pre-commit', '../escape.txt', 'C:\\x.txt', '.env.local']) {
      const out = await h.call('filesystem_write', { path, content: 'x' })
      expect(out.isError, path).toBe(true)
    }
    expect(existsSync(join(h.root, '.env'))).toBe(false)
    expect(existsSync(join(h.root, '.git', 'hooks', 'pre-commit'))).toBe(false)
  })

  it('refuses to write through a link that leaves the workspace', async () => {
    const outside = join(h.root, '..', `aiw-outside-w-${Date.now()}`)
    mkdirSync(outside, { recursive: true })
    try {
      symlinkSync(outside, join(h.root, 'link'), 'junction')
    } catch {
      return
    }
    const out = await h.call('filesystem_write', { path: 'link/pwned.txt', content: 'x' })
    expect(out.isError).toBe(true)
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false)
  })
})

describe('git tools (read-only)', () => {
  beforeEach(() => {
    h = makeHarness({ files: { 'src/a.ts': SOURCE, 'notes.txt': 'one\n' } })
  })

  it('status: clean, then with staged, modified and untracked files and counts', async () => {
    expect((await h.call('git_status', {})).text).toMatch(/Working tree clean/)
    put(h.root, 'src/a.ts', SOURCE + '// more\n')
    put(h.root, 'new.txt', 'a\nb\n')
    put(h.root, 'notes.txt', 'one\ntwo\n')
    git(h.root, 'add', 'notes.txt')
    const out = await h.call('git_status', {})
    expect(out.text).toMatch(/On branch main/)
    expect(out.text).toMatch(/Staged:[\s\S]*notes\.txt[\s\S]*\+1 -0/)
    expect(out.text).toMatch(/Modified \(not staged\):[\s\S]*src\/a\.ts[\s\S]*\+1 -0/)
    expect(out.text).toMatch(/Untracked:[\s\S]*new\.txt/)
  })

  it('diff: lists changes, then shows a unified diff for one file, and honours the staged area', async () => {
    put(h.root, 'src/a.ts', SOURCE.replace('return a - b\n}\n\nexport function sub', 'return a + b\n}\n\nexport function sub'))
    const list = await h.call('git_diff', {})
    expect(list.text).toMatch(/unstaged\s+modified\s+src\/a\.ts/)
    const one = await h.call('git_diff', { path: 'src/a.ts' })
    expect(one.text).toContain('-  return a - b')
    expect(one.text).toContain('+  return a + b')
    git(h.root, 'add', 'src/a.ts')
    expect((await h.call('git_diff', { path: 'src/a.ts' })).text).toMatch(/No unstaged changes/)
    expect((await h.call('git_diff', { path: 'src/a.ts', area: 'staged' })).text).toContain('+  return a + b')
  })

  it('diff of a secrets file is refused', async () => {
    put(h.root, '.env', 'TOKEN=abc123456')
    const out = await h.call('git_diff', { path: '.env', area: 'untracked' })
    expect(out.text).not.toContain('abc123456')
  })

  it('log lists commits and can filter by path', async () => {
    put(h.root, 'notes.txt', 'one\ntwo\n')
    git(h.root, 'commit', '-q', '-am', 'second commit about notes')
    const all = await h.call('git_log', {})
    expect(all.text).toMatch(/second commit about notes/)
    expect(all.text).toMatch(/initial commit/)
    const filtered = await h.call('git_log', { path: 'src/a.ts' })
    expect(filtered.text).toMatch(/initial commit/)
    expect(filtered.text).not.toMatch(/second commit/)
  })

  it('reports "not a repository" plainly', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-plain-')))
    writeFileSync(join(dir, 'x.txt'), 'x')
    const plain = makeHarness({ root: dir })
    try {
      const out = await plain.call('git_status', {})
      expect(out.isError).toBe(true)
      expect(out.text).toMatch(/not a git repository/)
    } finally {
      plain.cleanup()
    }
  })
})
