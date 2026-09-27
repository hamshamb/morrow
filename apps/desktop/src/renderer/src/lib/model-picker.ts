import type { ProviderConfigSummary, ProviderId, ProviderModelCatalog } from '@ai-workspace/shared'
import { PROVIDER_LABELS, STATIC_FALLBACK_MODELS } from './models'

export interface ModelPickerOption {
  providerConfigId: string
  provider: ProviderId
  configLabel: string
  modelId: string
  displayName: string | null
  /** Ready-to-render label: the provider's display name if it gave one,
   * otherwise the raw model id. */
  label: string
}

/**
 * Flattens every configured provider's model list (live-fetched cache when
 * present and non-empty, else that provider's static fallback — see
 * `STATIC_FALLBACK_MODELS`) into one searchable list for the picker
 * popover.
 */
export function buildModelPickerOptions(
  configs: ProviderConfigSummary[],
  catalogs: Record<string, ProviderModelCatalog>,
): ModelPickerOption[] {
  const options: ModelPickerOption[] = []
  for (const config of configs) {
    const cached = catalogs[config.id]
    const models = cached && cached.models.length > 0 ? cached.models : STATIC_FALLBACK_MODELS[config.provider]
    for (const model of models) {
      options.push({
        providerConfigId: config.id,
        provider: config.provider,
        configLabel: config.label,
        modelId: model.id,
        displayName: model.displayName,
        label: model.displayName ?? model.id,
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
    PROVIDER_LABELS[option.provider].toLowerCase(),
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
