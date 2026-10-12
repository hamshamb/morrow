/**
 * Opens a COPY of a workspace.sqlite3, runs the migrations, and checks that
 * every provider_configs / conversations / messages row survives and still
 * validates against the current zod schemas. Prints per-table row counts
 * BEFORE (raw, no migrations) and AFTER the migrations ran. Never point this
 * at the live DB — copy the .sqlite3 + -wal + -shm files first.
 *
 *   tsx scripts/check-db-copy.ts <path-to-copy>
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import type BetterSqlite3 from 'better-sqlite3'
import { ProviderConfigSummarySchema, MessageSchema } from '../packages/shared/src/index'
import { ProviderConfigRepository, MessageRepository, SettingsRepository, openDatabase } from '../packages/storage/src/index'

const path = process.argv[2]
if (!path || !existsSync(path)) throw new Error('usage: tsx scripts/check-db-copy.ts <path-to-copy-of-workspace.sqlite3>')

// better-sqlite3 is a dependency of packages/storage only; resolve it from there.
const requireFromStorage = createRequire(resolve('packages/storage/package.json'))
const RawDatabase = requireFromStorage('better-sqlite3') as typeof BetterSqlite3

function tableCounts(db: BetterSqlite3.Database): Record<string, number> {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name")
      .all() as { name: string }[]
  ).map((r) => r.name)
  const out: Record<string, number> = {}
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n
  return out
}

const appliedVersions = (db: BetterSqlite3.Database): number[] =>
  (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)

// BEFORE: raw open, no migrations.
const raw = new RawDatabase(path)
const before = { migrations: appliedVersions(raw), counts: tableCounts(raw), messageColumns: (raw.prepare("PRAGMA table_info('messages')").all() as unknown[]).length }
raw.close()

const db = openDatabase(path) // runs pending migrations on open
const after = { migrations: appliedVersions(db), counts: tableCounts(db), messageColumns: (db.prepare("PRAGMA table_info('messages')").all() as unknown[]).length }

const configs = new ProviderConfigRepository(db).list()
for (const c of configs) ProviderConfigSummarySchema.parse(c)

const conversationIds = (db.prepare('SELECT id FROM conversations').all() as { id: string }[]).map((r) => r.id)
const messages = new MessageRepository(db)
let messageRows = 0
let inContextRows = 0
let normalModeRows = 0
for (const id of conversationIds) {
  for (const m of messages.listByConversation(id)) {
    MessageSchema.parse(m)
    messageRows++
    if (m.inContext) inContextRows++
    if (m.orchestrationMode === 'normal' && m.replyGroupId === null) normalModeRows++
  }
}
const settings = new SettingsRepository(db).get()

// schema_migrations legitimately gains a row per applied migration.
const unchanged = Object.entries(before.counts).every(([table, n]) => table === 'schema_migrations' || after.counts[table] === n)
console.log(
  JSON.stringify(
    {
      before,
      after,
      everyPreExistingTableCountUnchanged: unchanged,
      providerConfigs: configs.map((c) => ({ provider: c.provider, label: c.label })),
      messagesValidatedAgainstZod: messageRows,
      messagesInContext: inContextRows,
      messagesPlainNormalNoGroup: normalModeRows,
      settings,
    },
    null,
    2,
  ),
)
db.close()
