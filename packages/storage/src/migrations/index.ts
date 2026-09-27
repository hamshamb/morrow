import type Database from 'better-sqlite3'
import type { Migration } from './types'
import { migration0001Init } from './0001_init'

export type { Migration } from './types'

/** Ordered by version. Add new migrations here — never edit an applied one. */
export const MIGRATIONS: Migration[] = [migration0001Init]

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `)

  const appliedVersions = new Set(
    db
      .prepare('SELECT version FROM schema_migrations')
      .all()
      .map((row) => (row as { version: number }).version),
  )

  const pending = MIGRATIONS.filter((m) => !appliedVersions.has(m.version)).sort(
    (a, b) => a.version - b.version,
  )

  for (const migration of pending) {
    const apply = db.transaction(() => {
      migration.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      )
    })
    apply()
  }
}
