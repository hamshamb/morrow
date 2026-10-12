/**
 * Opens a COPY of a workspace.sqlite3, runs the migrations, and checks that
 * every provider_configs / conversations / messages row survives and still
 * validates against the current zod schemas. Never point this at the live DB.
 *
 *   tsx scripts/check-db-copy.ts <path-to-copy>
 */
import { existsSync } from 'node:fs'
import { ProviderConfigSummarySchema, MessageSchema } from '../packages/shared/src/index'
import { ProviderConfigRepository, MessageRepository, SettingsRepository, openDatabase } from '../packages/storage/src/index'

const path = process.argv[2]
if (!path || !existsSync(path)) throw new Error('usage: tsx scripts/check-db-copy.ts <path-to-copy-of-workspace.sqlite3>')

const db = openDatabase(path) // runs pending migrations on open
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map((r) => r.version)

const configs = new ProviderConfigRepository(db).list()
for (const c of configs) ProviderConfigSummarySchema.parse(c)

const conversationIds = (db.prepare('SELECT id FROM conversations').all() as { id: string }[]).map((r) => r.id)
const messages = new MessageRepository(db)
let messageRows = 0
for (const id of conversationIds) {
  for (const m of messages.listByConversation(id)) {
    MessageSchema.parse(m)
    messageRows++
  }
}
const settings = new SettingsRepository(db).get()

console.log({
  migrations: versions,
  providerConfigs: configs.map((c) => ({ provider: c.provider, label: c.label })),
  conversations: count('conversations'),
  messagesRaw: count('messages'),
  messagesValidated: messageRows,
  settings,
})
db.close()
