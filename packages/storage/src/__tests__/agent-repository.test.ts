import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { MIGRATIONS, runMigrations } from '../migrations/index'
import { AgentRepository } from '../repositories/agent-repository'
import { ConversationRepository } from '../repositories/conversation-repository'
import { WorkspaceRepository } from '../repositories/workspace-repository'

function seed(db: AppDatabase) {
  const workspace = new WorkspaceRepository(db).create({ name: 'W' })
  const conversation = new ConversationRepository(db).create({ workspaceId: workspace.id, title: 'C' })
  return { workspaceId: workspace.id, conversationId: conversation.id }
}

describe('AgentRepository', () => {
  let db: AppDatabase
  let repo: AgentRepository
  let ids: { workspaceId: string; conversationId: string }

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new AgentRepository(db)
    ids = seed(db)
  })

  const makeRun = (id = 'run-1') =>
    repo.createRun({ id, ...ids, userMessageId: null, mode: 'build', agentId: 'implementer', provider: 'custom', model: 'm', maxSteps: 25 })

  it('creates a running run and updates it, round-tripping the report', () => {
    const run = makeRun()
    expect(run).toMatchObject({ id: 'run-1', status: 'running', steps: 0, maxSteps: 25, report: null, finishedAt: null })
    const report = {
      filesInspected: ['a.ts'],
      filesChanged: [],
      commands: [],
      tests: { status: 'not_run' as const, command: null, exitCode: null, editsAfterTests: false, detail: 'No test command was run.' },
      refused: [],
      toolCalls: 1,
      toolErrors: 0,
      stoppedBy: 'finished' as const,
      modelConcerns: null,
    }
    const done = repo.updateRun('run-1', { status: 'completed', steps: 3, report, finishedAt: 99, assistantMessageId: 'm9' })
    expect(done).toMatchObject({ status: 'completed', steps: 3, finishedAt: 99, assistantMessageId: 'm9' })
    expect(done.report).toEqual(report)
    expect(repo.listRunsByConversation(ids.conversationId).map((r) => r.id)).toEqual(['run-1'])
  })

  it('returns a null report rather than throwing when the stored JSON is not a valid report', () => {
    makeRun()
    db.prepare("UPDATE agent_runs SET report_json = '{\"nope\":1}' WHERE id = 'run-1'").run()
    expect(repo.getRun('run-1')?.report).toBeNull()
    db.prepare("UPDATE agent_runs SET report_json = 'not json' WHERE id = 'run-1'").run()
    expect(repo.getRun('run-1')?.report).toBeNull()
  })

  it('numbers tool runs in order within a run and keeps them per run', () => {
    makeRun('run-1')
    makeRun('run-2')
    const base = { ...ids, step: 1, toolId: 'filesystem.read' as const, risk: 'safe' as const, inputJson: '{}', status: 'running' as const }
    const a = repo.createToolRun({ ...base, runId: 'run-1', label: 'read a' })
    const b = repo.createToolRun({ ...base, runId: 'run-1', label: 'read b' })
    const c = repo.createToolRun({ ...base, runId: 'run-2', label: 'read c' })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 1])
    const done = repo.updateToolRun(a.id, {
      status: 'ok',
      summary: '12 lines',
      detail: 'x',
      decisionSource: 'default-safe',
      exitCode: 0,
      finishedAt: 5,
      durationMs: 3,
    })
    expect(done).toMatchObject({ status: 'ok', summary: '12 lines', decisionSource: 'default-safe', exitCode: 0, durationMs: 3 })
    expect(repo.listToolRuns('run-1').map((t) => t.label)).toEqual(['read a', 'read b'])
  })

  it('marks runs and tool calls left open by a crash as failed/cancelled', () => {
    makeRun()
    const t = repo.createToolRun({
      ...ids,
      runId: 'run-1',
      step: 1,
      toolId: 'terminal.execute',
      risk: 'execution',
      label: 'run x',
      inputJson: '{}',
      status: 'pending',
    })
    expect(repo.failInterruptedRuns(50)).toBe(1)
    expect(repo.getRun('run-1')).toMatchObject({ status: 'failed', finishedAt: 50 })
    expect(repo.getToolRun(t.id)).toMatchObject({ status: 'cancelled', decisionSource: 'cancelled' })
  })

  it('grants are unique per workspace + tool + risk + command and idempotent', () => {
    const g1 = repo.addGrant({ workspaceId: ids.workspaceId, toolId: 'filesystem.patch', risk: 'write', command: null })
    const g2 = repo.addGrant({ workspaceId: ids.workspaceId, toolId: 'filesystem.patch', risk: 'write', command: null })
    expect(g2.id).toBe(g1.id)
    const t1 = repo.addGrant({ workspaceId: ids.workspaceId, toolId: 'terminal.execute', risk: 'execution', command: 'pnpm test' })
    repo.addGrant({ workspaceId: ids.workspaceId, toolId: 'terminal.execute', risk: 'execution', command: 'pnpm lint' })
    expect(repo.listGrants(ids.workspaceId)).toHaveLength(3)
    expect(repo.findGrant(ids.workspaceId, 'terminal.execute', 'execution', 'pnpm test')?.id).toBe(t1.id)
    // The exact command is part of the key; a different command or risk is not covered.
    expect(repo.findGrant(ids.workspaceId, 'terminal.execute', 'execution', 'pnpm test --run')).toBeNull()
    expect(repo.findGrant(ids.workspaceId, 'terminal.execute', 'destructive', 'pnpm test')).toBeNull()
    expect(repo.findGrant(ids.workspaceId, 'filesystem.patch', 'write', null)?.command).toBeNull()
    repo.deleteGrant(t1.id)
    expect(repo.findGrant(ids.workspaceId, 'terminal.execute', 'execution', 'pnpm test')).toBeNull()
  })

  it('grants are workspace-scoped and die with the workspace', () => {
    const other = new WorkspaceRepository(db).create({ name: 'Other' })
    repo.addGrant({ workspaceId: ids.workspaceId, toolId: 'filesystem.write', risk: 'write', command: null })
    expect(repo.listGrants(other.id)).toEqual([])
    new WorkspaceRepository(db).delete(ids.workspaceId)
    expect(repo.listGrants(ids.workspaceId)).toEqual([])
  })

  it('snapshots keep the FIRST pre-run bytes and only move the after-hash on later writes', () => {
    makeRun()
    const original = Buffer.from([0x68, 0x69, 0x00, 0xff, 0x0d, 0x0a])
    repo.recordWrite({ runId: 'run-1', workspaceId: ids.workspaceId, path: 'a.bin', beforeContent: original, beforeHash: 'h0', afterHash: 'h1' })
    repo.recordWrite({ runId: 'run-1', workspaceId: ids.workspaceId, path: 'a.bin', beforeContent: Buffer.from('h1 content'), beforeHash: 'h1', afterHash: 'h2' })
    const snap = repo.getSnapshot('run-1', 'a.bin')
    expect(snap?.beforeContent?.equals(original)).toBe(true)
    expect(snap).toMatchObject({ beforeHash: 'h0', afterHash: 'h2' })
    repo.recordWrite({ runId: 'run-1', workspaceId: ids.workspaceId, path: 'new.txt', beforeContent: null, beforeHash: null, afterHash: 'n1' })
    expect(repo.getSnapshot('run-1', 'new.txt')?.beforeContent).toBeNull()
    expect(repo.listSnapshots('run-1').map((s) => s.path)).toEqual(['a.bin', 'new.txt'])
    repo.markReverted((snap as { id: string }).id, 7)
    expect(repo.getSnapshot('run-1', 'a.bin')?.revertedAt).toBe(7)
  })

  it('deleting a conversation removes its runs, audit rows and snapshots', () => {
    makeRun()
    repo.createToolRun({ ...ids, runId: 'run-1', step: 1, toolId: 'filesystem.read', risk: 'safe', label: 'read', inputJson: '{}', status: 'ok' })
    repo.recordWrite({ runId: 'run-1', workspaceId: ids.workspaceId, path: 'a', beforeContent: null, beforeHash: null, afterHash: 'x' })
    new ConversationRepository(db).delete(ids.conversationId)
    expect(repo.getRun('run-1')).toBeNull()
    expect(repo.listToolRuns('run-1')).toEqual([])
    expect(repo.listSnapshots('run-1')).toEqual([])
  })
})

describe('migration 0006 (agent) over a populated pre-Phase-5 database', () => {
  it('adds only new tables and leaves every existing row untouched', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);')
    for (const migration of MIGRATIONS.filter((m) => m.version <= 5)) {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, 1)
    }
    db.prepare('INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('w1', 'W', null, 1, 1)
    db.prepare('INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('c1', 'w1', 'Old chat', 1, 1)
    db.prepare("INSERT INTO messages (id, conversation_id, role, provider, model, status, created_at, updated_at) VALUES ('m1', 'c1', 'user', NULL, NULL, 'complete', 10, 10)").run()
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', '\"dark\"')").run()

    const tables = (): string[] =>
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    const before = tables()
    const snapshot = (table: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    const beforeRows = Object.fromEntries(['workspaces', 'conversations', 'messages', 'settings'].map((t) => [t, snapshot(t)]))
    const columnsBefore = (db.prepare('PRAGMA table_info(messages)').all() as unknown[]).length

    runMigrations(db)

    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(6)
    expect(tables().filter((t) => !before.includes(t))).toEqual(['agent_file_snapshots', 'agent_runs', 'permission_grants', 'tool_runs'])
    for (const [table, rows] of Object.entries(beforeRows)) expect(snapshot(table)).toEqual(rows)
    expect((db.prepare('PRAGMA table_info(messages)').all() as unknown[]).length).toBe(columnsBefore)

    // And running the whole thing again is a no-op.
    runMigrations(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(6)
  })
})
