import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { openDatabase, type AppDatabase } from '@ai-workspace/storage'

let dbInstance: AppDatabase | null = null

export function getDatabase(): AppDatabase {
  if (dbInstance) return dbInstance
  const dataDir = join(app.getPath('userData'), 'data')
  mkdirSync(dataDir, { recursive: true })
  dbInstance = openDatabase(join(dataDir, 'workspace.sqlite3'))
  return dbInstance
}
