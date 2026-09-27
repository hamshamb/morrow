import { randomUUID } from 'node:crypto'
import type { ModelCatalogEntry, ProviderModelCatalog } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface ModelCatalogRow {
  model_id: string
  display_name: string | null
  fetched_at: number
}

/**
 * Caches the live-fetched model list per provider config (see migration
 * 0004). `replaceForProviderConfig` fully replaces the set in one
 * transaction, matching the wholesale-replace pattern already used for
 * `workspace_files` (see ADR-011) — simpler than incremental diffing and the
 * catalog is small (dozens of rows at most).
 */
export class ModelCatalogRepository {
  constructor(private readonly db: AppDatabase) {}

  listForProviderConfig(providerConfigId: string): ProviderModelCatalog {
    const rows = this.db
      .prepare(
        'SELECT model_id, display_name, fetched_at FROM model_catalog WHERE provider_config_id = ? ORDER BY model_id ASC',
      )
      .all(providerConfigId) as ModelCatalogRow[]
    const models: ModelCatalogEntry[] = rows.map((row) => ({
      id: row.model_id,
      displayName: row.display_name,
    }))
    const fetchedAt = rows.length > 0 ? Math.max(...rows.map((r) => r.fetched_at)) : null
    return { providerConfigId, models, fetchedAt }
  }

  replaceForProviderConfig(
    providerConfigId: string,
    models: ModelCatalogEntry[],
    fetchedAt: number,
  ): ProviderModelCatalog {
    const clear = this.db.prepare('DELETE FROM model_catalog WHERE provider_config_id = ?')
    const insert = this.db.prepare(
      `INSERT INTO model_catalog (id, provider_config_id, model_id, display_name, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    const write = this.db.transaction(() => {
      clear.run(providerConfigId)
      for (const model of models) {
        insert.run(randomUUID(), providerConfigId, model.id, model.displayName, fetchedAt)
      }
    })
    write()
    return { providerConfigId, models, fetchedAt: models.length > 0 ? fetchedAt : null }
  }
}
