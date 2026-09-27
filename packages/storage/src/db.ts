import Database from 'better-sqlite3'
import { runMigrations } from './migrations/index'

export type AppDatabase = Database.Database

export function openDatabase(filePath: string): AppDatabase {
  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}
