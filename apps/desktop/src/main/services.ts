import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadBundledCatalog } from '@ai-workspace/providers'
import { ModelCatalogRepository, ProviderConfigRepository, SettingsRepository } from '@ai-workspace/storage'
import { getDatabase } from './db'
import { decryptSecret } from './credential-store'
import { ModelsDevService } from './models-dev-service'
import { ProviderCatalogService } from './provider-catalog-service'

let models: ModelsDevService | null = null
let providers: ProviderCatalogService | null = null

/** The process-wide models.dev metadata service (created on first use). */
export function getModelsDevService(): ModelsDevService {
  if (models) return models
  const settings = new SettingsRepository(getDatabase())
  models = new ModelsDevService({
    cachePath: join(app.getPath('userData'), 'models-dev-cache.json'),
    bundled: loadBundledCatalog,
    fetch: (url, init) => fetch(url, init),
    files: {
      read: (path) => {
        try {
          return readFileSync(path, 'utf8')
        } catch {
          return null
        }
      },
      write: (path, data) => {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, data)
      },
    },
    isFetchEnabled: () => settings.get().modelsDevFetchEnabled,
  })
  return models
}

/** The process-wide provider registry / catalog service (created on first use). */
export function getProviderCatalogService(): ProviderCatalogService {
  if (providers) return providers
  const db = getDatabase()
  providers = new ProviderCatalogService({
    models: getModelsDevService(),
    configs: new ProviderConfigRepository(db),
    catalogs: new ModelCatalogRepository(db),
    decrypt: decryptSecret,
  })
  return providers
}
