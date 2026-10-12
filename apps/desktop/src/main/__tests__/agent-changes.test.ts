import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentChangeService } from '../agent/agent-changes'
import { buildRunReport, extractModelConcerns } from '../agent/run-report'
import { makeHarness, put, type Harness } from './agent-harness'

let h: Harness
afterEach(() => h?.cleanup())

const ORIGINAL = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('alpha\r\nbeta\r\ngamma\r\n')])

function changes(active = false): AgentChangeService {
  return new AgentChangeService({ repo: h.repo, resolveRoot: (id) => h.services.resolveRoot(id), isRunActive: () => active })
}

async function editAndCreate(): Promise<void> {
  h.answers.push('allow_once', 'allow_once')
  await h.call('filesystem_read', { path: 'exact.txt' })
  await h.call('filesystem_patch', { path: 'exact.txt', old_string: 'beta', new_string: 'BETA\nextra' })
  await h.call('filesystem_write', { path: 'made/new.txt', content: 'brand new\n' })
}

describe('the Changes view backend', () => {
  it('lists what the run changed with +N -M computed from the disk', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    const list = await changes().list(h.runId)
    expect(list).toEqual([
      { path: 'exact.txt', kind: 'modified', added: 2, removed: 1, reverted: false, changedSince: false },
      { path: 'made/new.txt', kind: 'created', added: 1, removed: 0, reverted: false, changedSince: false },
    ])
  })

  it('serves both sides of a diff: before the run, and now', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    const diff = await changes().fileDiff(h.runId, 'exact.txt')
    expect(diff).toEqual({ status: 'ok', path: 'exact.txt', original: 'alpha\r\nbeta\r\ngamma\r\n', modified: 'alpha\r\nBETA\nextra\r\ngamma\r\n' })
    const created = await changes().fileDiff(h.runId, 'made/new.txt')
    expect(created).toMatchObject({ status: 'ok', original: '', modified: 'brand new\n' })
    expect((await changes().fileDiff(h.runId, 'other.txt')).status).toBe('unavailable')
  })

  it('REVERT restores the exact original bytes (BOM and CRLF included)', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    const result = await changes().revert({ runId: h.runId, path: 'exact.txt' })
    expect(result).toEqual({ reverted: ['exact.txt'], skipped: [] })
    expect(readFileSync(join(h.root, 'exact.txt')).equals(ORIGINAL)).toBe(true)
    // The created file is untouched until it is reverted too.
    expect(existsSync(join(h.root, 'made', 'new.txt'))).toBe(true)
    const list = await changes().list(h.runId)
    expect(list.find((c) => c.path === 'exact.txt')).toMatchObject({ reverted: true, added: 0, removed: 0 })
  })

  it('reverting a file the agent CREATED removes it again', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    expect(await changes().revert({ runId: h.runId, path: 'made/new.txt' })).toEqual({ reverted: ['made/new.txt'], skipped: [] })
    expect(existsSync(join(h.root, 'made', 'new.txt'))).toBe(false)
  })

  it('revert all restores every file, and a second revert is a no-op', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    const all = await changes().revert({ runId: h.runId })
    expect(all.reverted.sort()).toEqual(['exact.txt', 'made/new.txt'])
    expect(readFileSync(join(h.root, 'exact.txt')).equals(ORIGINAL)).toBe(true)
    expect(existsSync(join(h.root, 'made', 'new.txt'))).toBe(false)
    expect(await changes().revert({ runId: h.runId })).toEqual({ reverted: [], skipped: [] })
  })

  it('refuses to revert a file edited after the agent wrote it, unless forced', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    writeFileSync(join(h.root, 'exact.txt'), 'the user kept working on this file\n')
    const list = await changes().list(h.runId)
    expect(list.find((c) => c.path === 'exact.txt')?.changedSince).toBe(true)

    const refused = await changes().revert({ runId: h.runId, path: 'exact.txt' })
    expect(refused.reverted).toEqual([])
    expect(refused.skipped[0]).toMatchObject({ path: 'exact.txt', changedSince: true })
    expect(readFileSync(join(h.root, 'exact.txt'), 'utf8')).toBe('the user kept working on this file\n')

    const forced = await changes().revert({ runId: h.runId, path: 'exact.txt', force: true })
    expect(forced.reverted).toEqual(['exact.txt'])
    expect(readFileSync(join(h.root, 'exact.txt')).equals(ORIGINAL)).toBe(true)
  })

  it('revert all skips only the changed-since files and reverts the rest', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    writeFileSync(join(h.root, 'made', 'new.txt'), 'edited since\n')
    const result = await changes().revert({ runId: h.runId })
    expect(result.reverted).toEqual(['exact.txt'])
    expect(result.skipped.map((s) => s.path)).toEqual(['made/new.txt'])
    expect(readFileSync(join(h.root, 'made', 'new.txt'), 'utf8')).toBe('edited since\n')
  })

  it('cannot revert while the run is still going, an unknown run, or a file the run did not change', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    await editAndCreate()
    await expect(changes(true).revert({ runId: h.runId })).rejects.toThrow(/still in progress/)
    await expect(changes().revert({ runId: 'nope' })).rejects.toThrow(/not found/)
    await expect(changes().revert({ runId: h.runId, path: 'README.md' })).rejects.toThrow(/not changed by this run/)
  })

  it('a path in the snapshot table can never reach outside the workspace (revert goes through path safety)', async () => {
    h = makeHarness({ files: { 'exact.txt': ORIGINAL } })
    h.repo.recordWrite({ runId: h.runId, workspaceId: h.workspaceId, path: '../escape.txt', beforeContent: Buffer.from('x'), beforeHash: 'x', afterHash: 'y' })
    await expect(changes().revert({ runId: h.runId, path: '../escape.txt', force: true })).rejects.toThrow()
    expect(existsSync(join(h.root, '..', 'escape.txt'))).toBe(false)
  })
})

describe('run report facts', () => {
  it('re-reads the disk: a file edited again after the agent is flagged unverified', async () => {
    h = makeHarness({ files: { 'a.txt': 'one\n' } })
    h.answers.push('allow_once')
    await h.call('filesystem_read', { path: 'a.txt' })
    await h.call('filesystem_patch', { path: 'a.txt', old_string: 'one', new_string: 'two' })
    writeFileSync(join(h.root, 'a.txt'), 'two\nthree\n')
    const report = await buildRunReport({ runStatus: 'completed', toolRuns: h.repo.listToolRuns(h.runId), snapshots: h.repo.listSnapshots(h.runId), root: h.root, modelText: '', changedByCommands: [] })
    expect(report.filesChanged[0]).toMatchObject({ path: 'a.txt', verified: false, added: 2, removed: 1 })
    expect(report.filesChanged[0]?.note).toMatch(/differs from the last write/)
  })

  it('a deleted file is reported as such', async () => {
    h = makeHarness({ files: { 'a.txt': 'one\n' } })
    h.answers.push('allow_once')
    await h.call('filesystem_read', { path: 'a.txt' })
    await h.call('filesystem_patch', { path: 'a.txt', old_string: 'one', new_string: 'two' })
    put(h.root, 'a.txt', 'two\n')
    const { rmSync } = await import('node:fs')
    rmSync(join(h.root, 'a.txt'))
    const report = await buildRunReport({ runStatus: 'completed', toolRuns: h.repo.listToolRuns(h.runId), snapshots: h.repo.listSnapshots(h.runId), root: h.root, modelText: '', changedByCommands: [] })
    expect(report.filesChanged[0]).toMatchObject({ verified: false, note: 'the file no longer exists on disk' })
  })

  it('an empty run has an honest empty report', async () => {
    h = makeHarness()
    const report = await buildRunReport({ runStatus: 'completed', toolRuns: [], snapshots: [], root: h.root, modelText: 'I looked around.', changedByCommands: [] })
    expect(report).toMatchObject({
      filesInspected: [],
      filesChanged: [],
      commands: [],
      tests: { status: 'not_run' },
      refused: [],
      toolCalls: 0,
      stoppedBy: 'finished',
      modelConcerns: null,
    })
  })
})

describe("extractModelConcerns - the model's own words, verbatim, only when it wrote them", () => {
  it.each([
    ['Done.\n\nRemaining concerns: the migration is untested.', 'the migration is untested.'],
    ['Done.\n\nRemaining concerns:\n- flaky test\n- no docs', '- flaky test\n- no docs'],
    ['Done.\n\n**Remaining concerns:** none', 'none'],
    ['Done.\n\n## Remaining concerns\nOne thing.', 'One thing.'],
    ['Done.\nremaining concern: only one', 'only one'],
  ])('%j', (text, expected) => {
    expect(extractModelConcerns(text)).toBe(expected)
  })

  it('returns null when absent or empty', () => {
    expect(extractModelConcerns('Everything is fine.')).toBeNull()
    expect(extractModelConcerns('Remaining concerns:')).toBeNull()
    expect(extractModelConcerns('')).toBeNull()
  })

  it('caps very long text', () => {
    const out = extractModelConcerns(`Remaining concerns: ${'x'.repeat(5000)}`)
    expect(out?.length).toBeLessThanOrEqual(1501)
  })
})
