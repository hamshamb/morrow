import type Database from 'better-sqlite3'
import type { Migration } from './types'

export const migration0004ModelCatalog: Migration = {
  version: 4,
  name: 'model_catalog',
  up(db: Database.Database) {
    db.exec(`
      -- Live-fetched model catalog cache, scoped per provider config (not
      -- per provider) since two API keys for the same provider can have
      -- access to different model sets. Fully replaced on every refresh
      -- (same replace-wholesale pattern as workspace_files in migration
      -- 0003) rather than diffed. Cascades when the owning provider config
      -- is deleted.
      CREATE TABLE model_catalog (
        id                  TEXT PRIMARY KEY,
        provider_config_id  TEXT NOT NULL REFERENCES provider_configs(id) ON DELETE CASCADE,
        model_id            TEXT NOT NULL,
        display_name        TEXT,
        fetched_at          INTEGER NOT NULL,
        UNIQUE(provider_config_id, model_id)
      );

      CREATE INDEX idx_model_catalog_provider_config_id ON model_catalog(provider_config_id);
    `)
  },
}
