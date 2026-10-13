import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { MIGRATIONS, runMigrations } from '../migrations/index'
import { McpNameTakenError, McpServerRepository, type McpServerWrite } from '../repositories/mcp-server-repository'

const stdio = (over: Partial<McpServerWrite> = {}): McpServerWrite => ({
  name: 'files',
  transport: 'stdio',
  command: 'node',
  args: ['server.js', '--root', 'C:/data'],
  cwd: null,
  env: [{ key: 'LOG', value: 'debug' }],
  secretEnvKeys: ['API_TOKEN'],
  url: '',
  headers: [],
  secretHeaderKeys: [],
  secrets: Buffer.from('ciphertext-not-plaintext'),
  enabled: true,
  ...over,
})

describe('McpServerRepository', () => {
  let db: AppDatabase
  let repo: McpServerRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new McpServerRepository(db)
  })

  it('round-trips a stdio server; a secret reads back as a key with no value', () => {
    const created = repo.create(stdio())
    expect(created).toMatchObject({ name: 'files', transport: 'stdio', command: 'node', args: ['server.js', '--root', 'C:/data'], cwd: null, enabled: true, disabledTools: [] })
    expect(created.env).toEqual([
      { key: 'LOG', value: 'debug', secret: false },
      { key: 'API_TOKEN', value: null, secret: true },
    ])
    expect(repo.get(created.id)).toEqual(created)
    expect(repo.list()).toEqual([created])
  })

  it('stores secrets only in the blob column, as given (the caller encrypts)', () => {
    const created = repo.create(stdio({ env: [], secretEnvKeys: ['TOKEN'], secrets: Buffer.from([1, 2, 3, 250]) }))
    expect(repo.getSecrets(created.id)).toEqual(Buffer.from([1, 2, 3, 250]))
    // No plain column holds a value for the secret key.
    const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(created.id) as Record<string, unknown>
    const plain = JSON.stringify({ ...row, secrets: undefined })
    expect(plain).not.toContain('250')
    expect(JSON.parse(row['env_json'] as string)).toEqual([])
    expect(JSON.parse(row['secret_env_keys'] as string)).toEqual(['TOKEN'])
  })

  it('round-trips an http server with headers', () => {
    const created = repo.create(
      stdio({ name: 'remote', transport: 'http', command: '', args: [], env: [], secretEnvKeys: [], url: 'https://mcp.example.com/mcp', headers: [{ key: 'X-Client', value: 'morrow' }], secretHeaderKeys: ['Authorization'] }),
    )
    expect(created.transport).toBe('http')
    expect(created.url).toBe('https://mcp.example.com/mcp')
    expect(created.headers).toEqual([
      { key: 'X-Client', value: 'morrow', secret: false },
      { key: 'Authorization', value: null, secret: true },
    ])
  })

  it('names are unique, on create and on rename', () => {
    const a = repo.create(stdio())
    repo.create(stdio({ name: 'other' }))
    expect(() => repo.create(stdio())).toThrow(McpNameTakenError)
    expect(() => repo.update(a.id, stdio({ name: 'other' }))).toThrow(McpNameTakenError)
    // Keeping its own name is fine.
    expect(repo.update(a.id, stdio({ command: 'python' })).command).toBe('python')
  })

  it('update replaces every field; the secrets blob is replaced with it', () => {
    const a = repo.create(stdio())
    const updated = repo.update(a.id, stdio({ args: [], env: [], secretEnvKeys: [], secrets: null, enabled: false }))
    expect(updated.env).toEqual([])
    expect(updated.enabled).toBe(false)
    expect(repo.getSecrets(a.id)).toBeNull()
    expect(updated.updatedAt).toBeGreaterThanOrEqual(a.updatedAt)
  })

  it('enables, disables tools (deduplicated) and deletes', () => {
    const a = repo.create(stdio())
    expect(repo.setEnabled(a.id, false).enabled).toBe(false)
    expect(repo.setDisabledTools(a.id, ['x', 'y', 'x']).disabledTools).toEqual(['x', 'y'])
    repo.delete(a.id)
    expect(repo.get(a.id)).toBeNull()
    expect(() => repo.setEnabled(a.id, true)).toThrow(/not found/)
  })

  it('survives hand-corrupted JSON columns without throwing', () => {
    const a = repo.create(stdio())
    db.prepare("UPDATE mcp_servers SET args_json = 'not json', env_json = '{\"x\":1}', disabled_tools_json = '5' WHERE id = ?").run(a.id)
    const read = repo.get(a.id)
    expect(read?.args).toEqual([])
    expect(read?.env.filter((e) => !e.secret)).toEqual([])
    expect(read?.disabledTools).toEqual([])
  })
})

describe('migration 0007 (mcp) over a populated pre-Phase-7 database', () => {
  it('adds only the mcp_servers table and leaves every existing row untouched', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);')
    for (const migration of MIGRATIONS.filter((m) => m.version <= 6)) {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(migration.version, migration.name, 1)
    }
    db.prepare('INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('w1', 'W', null, 1, 1)
    db.prepare('INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('c1', 'w1', 'Old chat', 1, 1)
    db.prepare("INSERT INTO settings (key, value) VALUES ('theme', '\"dark\"')").run()
    db.prepare("INSERT INTO permission_grants (id, workspace_id, tool_id, risk, command, created_at) VALUES ('g1', 'w1', 'terminal.execute', 'execution', 'pnpm test', 5)").run()

    const tables = (): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)
    const before = tables()
    const snapshot = (table: string): unknown[] => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()
    const beforeRows = Object.fromEntries(['workspaces', 'conversations', 'settings', 'permission_grants'].map((t) => [t, snapshot(t)]))

    runMigrations(db)

    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(7)
    expect(tables().filter((t) => !before.includes(t))).toEqual(['mcp_servers'])
    for (const [table, rows] of Object.entries(beforeRows)) expect(snapshot(table)).toEqual(rows)

    runMigrations(db)
    expect((db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(7)
  })
})
