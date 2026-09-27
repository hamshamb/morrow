import {
  AppSettingsSchema,
  DEFAULT_SETTINGS,
  type AppSettings,
  type AppSettingsPartial,
} from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

export class SettingsRepository {
  constructor(private readonly db: AppDatabase) {}

  get(): AppSettings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]
    const stored: Record<string, unknown> = {}
    for (const row of rows) {
      stored[row.key] = JSON.parse(row.value)
    }
    const parsed = AppSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...stored })
    return parsed.success ? parsed.data : DEFAULT_SETTINGS
  }

  set(partial: AppSettingsPartial): AppSettings {
    const next = { ...this.get(), ...partial }
    const validated = AppSettingsSchema.parse(next)
    const upsert = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    const write = this.db.transaction(() => {
      for (const [key, value] of Object.entries(validated)) {
        upsert.run(key, JSON.stringify(value))
      }
    })
    write()
    return validated
  }
}
