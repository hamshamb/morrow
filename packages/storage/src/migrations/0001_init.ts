import type Database from 'better-sqlite3'
import type { Migration } from './types'

export const migration0001Init: Migration = {
  version: 1,
  name: 'init',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE workspaces (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );

      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  },
}
