import { parseModelsDevCatalog, type ModelsDevCatalog } from './models-dev'
import snapshot from './data/models-dev-snapshot.json'

/**
 * The offline / first-run floor of the metadata catalog: a trimmed copy of
 * https://models.dev/api.json committed in `data/models-dev-snapshot.json` and
 * regenerated with `pnpm models:snapshot` (scripts/update-models-snapshot.ts).
 * Parsed lazily and once.
 */
let cached: ModelsDevCatalog | null = null
export function loadBundledCatalog(): ModelsDevCatalog {
  cached ??= parseModelsDevCatalog(snapshot)
  return cached
}
