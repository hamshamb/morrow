import type { AutoCandidate, ProviderConfigSummary, ProviderModelCatalog } from '@ai-workspace/shared'

/**
 * Auto's candidate pool: every model of every provider config the user has
 * saved (a saved config is a key, or a deliberately keyless local/custom
 * endpoint). A config whose catalog cannot be read is skipped rather than
 * failing the whole pick.
 */
export function buildAutoCandidates(
  configs: ProviderConfigSummary[],
  listCatalog: (providerConfigId: string) => ProviderModelCatalog,
): AutoCandidate[] {
  const candidates: AutoCandidate[] = []
  for (const config of configs) {
    let catalog: ProviderModelCatalog
    try {
      catalog = listCatalog(config.id)
    } catch {
      continue
    }
    for (const model of catalog.models) {
      candidates.push({
        providerConfigId: config.id,
        provider: config.provider,
        modelId: model.id,
        name: model.displayName ?? model.meta?.name ?? model.id,
        hasKey: true,
        meta: model.meta ?? null,
      })
    }
  }
  return candidates
}
