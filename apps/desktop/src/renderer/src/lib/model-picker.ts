import type {
  ModelMetadata,
  ProviderConfigSummary,
  ProviderId,
  ProviderModelCatalog,
} from '@ai-workspace/shared'

export interface ModelPickerOption {
  providerConfigId: string
  provider: ProviderId
  providerLabel: string
  configLabel: string
  modelId: string
  displayName: string | null
  /** Ready-to-render label: the provider's display name if it gave one,
   * otherwise the raw model id. */
  label: string
  /** models.dev metadata (context, price, capabilities, effort values). */
  meta: ModelMetadata | null
}

/**
 * Flattens every configured provider's model list into one searchable list
 * for the picker popover. The main process already joined each list with
 * models.dev metadata (live ids when fetched, else models.dev's own list), so
 * there is no renderer-side fallback table any more. `providerLabel` resolves
 * a provider id to its registry name.
 */
export function buildModelPickerOptions(
  configs: ProviderConfigSummary[],
  catalogs: Record<string, ProviderModelCatalog>,
  providerLabel: (providerId: ProviderId) => string,
): ModelPickerOption[] {
  const options: ModelPickerOption[] = []
  for (const config of configs) {
    for (const model of catalogs[config.id]?.models ?? []) {
      options.push({
        providerConfigId: config.id,
        provider: config.provider,
        providerLabel: providerLabel(config.provider),
        configLabel: config.label,
        modelId: model.id,
        displayName: model.displayName,
        label: model.displayName ?? model.id,
        meta: model.meta ?? null,
      })
    }
  }
  return options
}

/** -1 = no match; lower is otherwise better (an earlier/more-prominent
 * substring match ranks higher). A simple scored substring filter — no
 * fuzzy-matching library, per the "don't over-engineer" guidance. */
function matchScore(option: ModelPickerOption, query: string): number {
  const haystacks = [
    option.modelId.toLowerCase(),
    option.label.toLowerCase(),
    option.configLabel.toLowerCase(),
    option.providerLabel.toLowerCase(),
    option.meta?.family?.toLowerCase() ?? '',
  ]
  let best = -1
  for (let i = 0; i < haystacks.length; i += 1) {
    const idx = haystacks[i]!.indexOf(query)
    if (idx === -1) continue
    // Prefix matches on the model id/label rank above a substring match
    // elsewhere; matching an earlier field (id/label before config/provider
    // name) also ranks slightly higher.
    const positionScore = idx === 0 ? 0 : 1
    const fieldScore = i
    const s = positionScore * 10 + fieldScore
    if (best === -1 || s < best) best = s
  }
  return best
}

export function filterModelPickerOptions(
  options: ModelPickerOption[],
  query: string,
): ModelPickerOption[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) return options
  return options
    .map((option) => ({ option, score: matchScore(option, trimmed) }))
    .filter((x) => x.score !== -1)
    .sort((a, b) => a.score - b.score || a.option.label.localeCompare(b.option.label))
    .map((x) => x.option)
}
