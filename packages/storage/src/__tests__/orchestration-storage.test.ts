import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { MIGRATIONS, runMigrations } from '../migrations/index'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { ConversationRepository } from '../repositories/conversation-repository'
import { MessageRepository } from '../repositories/message-repository'

describe('migration 0005 (orchestration) over a populated pre-Phase-6 database', () => {
  it('keeps every row valid, defaults in_context to 1, and adds only nullable/defaulted columns', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')

    // A database exactly as Phase 4/UI/models.dev builds left it: migrations 1-4 only.
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);`)
    for (const migration of MIGRATIONS.filter((m) => m.version <= 4)) {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        1,
      )
    }

    db.prepare('INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('w1', 'W', null, 1, 1)
    db.prepare('INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('c1', 'w1', 'Old chat', 1, 1)
    const insertMessage = db.prepare(
      'INSERT INTO messages (id, conversation_id, role, provider, model, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    insertMessage.run('m1', 'c1', 'user', null, null, 'complete', 10, 10)
    insertMessage.run('m2', 'c1', 'assistant', 'anthropic', 'claude-sonnet-5', 'complete', 20, 20)
    insertMessage.run('m3', 'c1', 'assistant', 'openai', 'gpt-5.6', 'error', 30, 30)
    db.prepare('INSERT INTO message_parts (id, message_id, type, content, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'm1', 'text', 'hello', 0, 10)
    db.prepare('INSERT INTO message_parts (id, message_id, type, content, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('p2', 'm2', 'text', 'hi!', 0, 20)

    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
    const before = { messages: count('messages'), parts: count('message_parts'), conversations: count('conversations') }

    runMigrations(db)

    expect(count('messages')).toBe(before.messages)
    expect(count('message_parts')).toBe(before.parts)
    expect(count('conversations')).toBe(before.conversations)
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number }).v).toBe(5)

    // Old rows: identical original fields, defaults for the new ones.
    const rows = db.prepare('SELECT * FROM messages ORDER BY created_at').all() as Record<string, unknown>[]
    expect(rows.map((r) => [r.id, r.role, r.provider, r.model, r.status, r.created_at])).toEqual([
      ['m1', 'user', null, null, 'complete', 10],
      ['m2', 'assistant', 'anthropic', 'claude-sonnet-5', 'complete', 20],
      ['m3', 'assistant', 'openai', 'gpt-5.6', 'error', 30],
    ])
    for (const row of rows) {
      expect(row.in_context).toBe(1)
      expect(row.orchestration_mode).toBe('normal')
      expect(row.reply_group_id).toBeNull()
      expect(row.role_label).toBeNull()
      expect(row.auto_reason).toBeNull()
      expect(row.est_cost_usd).toBeNull()
      expect(row.error_text).toBeNull()
    }

    // The repository reads them as ordinary in-context messages.
    const repo = new MessageRepository(db)
    const thread = repo.listByConversation('c1')
    expect(thread.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(thread.every((m) => m.inContext && m.orchestrationMode === 'normal' && m.replyGroupId === null)).toBe(true)
    expect(thread[1]?.parts[0]?.content).toBe('hi!')

    // Running the migrations again is a no-op.
    runMigrations(db)
    expect(count('messages')).toBe(before.messages)
    db.close()
  })

  it('every new column is nullable or defaulted (a pre-Phase-6 INSERT still works)', () => {
    const db = openDatabase(':memory:')
    const cols = db.prepare("PRAGMA table_info('messages')").all() as { name: string; notnull: number; dflt_value: string | null }[]
    const added = cols.filter((c) =>
      [
        'reply_group_id',
        'orchestration_mode',
        'role_label',
        'in_context',
        'auto_reason',
        'reply_index',
        'round_index',
        'input_tokens',
        'output_tokens',
        'latency_ms',
        'est_cost_usd',
        'error_text',
      ].includes(c.name),
    )
    expect(added).toHaveLength(12)
    for (const col of added) expect(col.notnull === 0 || col.dflt_value !== null).toBe(true)
    db.close()
  })
})

describe('MessageRepository — orchestration', () => {
  let db: AppDatabase
  let repo: MessageRepository
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversationId = new ConversationRepository(db).create({ workspaceId }).id
    repo = new MessageRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  const reply = (groupId: string, index: number, model: string, over: Partial<Parameters<MessageRepository['create']>[0]> = {}) =>
    repo.create({
      conversationId,
      role: 'assistant',
      provider: 'anthropic',
      model,
      status: 'complete',
      parts: [{ type: 'text', content: `from ${model}` }],
      replyGroupId: groupId,
      orchestrationMode: 'compare',
      replyIndex: index,
      inContext: false,
      ...over,
    })

  it('plain creates behave as before: in context, normal mode, no group', () => {
    const m = repo.create({ conversationId, role: 'assistant', provider: 'openai', model: 'gpt', status: 'complete', parts: [] })
    expect(m).toMatchObject({ inContext: true, orchestrationMode: 'normal', replyGroupId: null, roleLabel: null, estCostUsd: null })
    expect(repo.get(m.id)).toEqual(m)
  })

  it('persists and reads back orchestration metadata, usage, latency and cost', () => {
    const user = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [{ type: 'text', content: 'q' }] })
    const m = reply(user.id, 2, 'm', {
      roleLabel: 'critique',
      roundIndex: 2,
      autoReason: 'cheapest capable',
      inputTokens: 120,
      outputTokens: 40,
      latencyMs: 1500,
      estCostUsd: 0.0021,
      errorText: 'boom',
      status: 'error',
    })
    expect(repo.get(m.id)).toMatchObject({
      replyGroupId: user.id,
      orchestrationMode: 'compare',
      roleLabel: 'critique',
      replyIndex: 2,
      roundIndex: 2,
      autoReason: 'cheapest capable',
      inputTokens: 120,
      outputTokens: 40,
      latencyMs: 1500,
      estCostUsd: 0.0021,
      errorText: 'boom',
      inContext: false,
    })
  })

  it('lists a group in column order regardless of when each reply finished', () => {
    const user = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] })
    reply(user.id, 2, 'third')
    reply(user.id, 0, 'first')
    reply(user.id, 1, 'second')
    expect(repo.listGroupReplies(user.id).map((m) => m.model)).toEqual(['first', 'second', 'third'])
  })

  it('chooseReply puts exactly one reply of the group in context and deletes nothing', () => {
    const user = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] })
    const a = reply(user.id, 0, 'a', { inContext: true })
    const b = reply(user.id, 1, 'b')
    const c = reply(user.id, 2, 'c')
    const group = repo.chooseReply(c.id)
    expect(group.map((m) => [m.model, m.inContext])).toEqual([
      ['a', false],
      ['b', false],
      ['c', true],
    ])
    expect(repo.get(a.id)?.parts[0]?.content).toBe('from a')
    expect(repo.get(b.id)).not.toBeNull()
    // switching again moves it
    repo.chooseReply(a.id)
    expect(repo.listGroupReplies(user.id).filter((m) => m.inContext).map((m) => m.model)).toEqual(['a'])
  })

  it('chooseReply does not touch other groups or the user message', () => {
    const u1 = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] })
    const u2 = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] })
    const x = reply(u1.id, 0, 'x', { inContext: true })
    const y = reply(u2.id, 0, 'y', { inContext: true })
    const z = reply(u2.id, 1, 'z')
    repo.chooseReply(z.id)
    expect(repo.get(x.id)?.inContext).toBe(true)
    expect(repo.get(y.id)?.inContext).toBe(false)
    expect(repo.get(u2.id)?.inContext).toBe(true)
  })

  it('chooseReply on a legacy reply (no group) just marks it in context', () => {
    const legacy = repo.create({ conversationId, role: 'assistant', provider: 'openai', model: 'gpt', status: 'complete', parts: [], inContext: false })
    expect(repo.chooseReply(legacy.id).map((m) => m.id)).toEqual([legacy.id])
    expect(repo.get(legacy.id)?.inContext).toBe(true)
  })

  it('chooseReply refuses a user message or an unknown id', () => {
    const user = repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] })
    expect(() => repo.chooseReply(user.id)).toThrow(/assistant/)
    expect(() => repo.chooseReply('nope')).toThrow(/not found/)
  })

  it('keeps same-millisecond messages in insertion order', () => {
    const ids = Array.from({ length: 20 }, () =>
      repo.create({ conversationId, role: 'user', provider: null, model: null, status: 'complete', parts: [] }).id,
    )
    expect(repo.listByConversation(conversationId).map((m) => m.id)).toEqual(ids)
  })
})
