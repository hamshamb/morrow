import {
  CONTEXT_WARN_RATIO,
  type ModelCost,
  type ModelMetadata,
  type ProviderModelCatalog,
  type ReasoningEffort,
} from '@ai-workspace/shared'

/** `1_000_000` -> `1M`, `18_300` -> `18K`, `1_500` -> `1.5K`, `950` -> `950`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000, 1)}M`
  if (n >= 10_000) return `${Math.round(n / 1_000)}K`
  if (n >= 1_000) return `${trim(n / 1_000, 1)}K`
  return String(Math.round(n))
}

function trim(value: number, decimals: number): string {
  return String(Number(value.toFixed(decimals)))
}

/** `1M ctx`, or null when the window is unknown. */
export function formatContext(contextWindow: number | null | undefined): string | null {
  return contextWindow ? `${formatTokens(contextWindow)} ctx` : null
}

function formatUsd(n: number): string {
  return `$${Number(n.toFixed(n < 1 ? 3 : 2))}`
}

/** `$2/$10` (USD per 1M input/output tokens), `free`, or null when unpriced. */
export function formatPrice(cost: ModelCost | null | undefined): string | null {
  if (!cost) return null
  if (cost.input === 0 && cost.output === 0) return 'free'
  return `${formatUsd(cost.input)}/${formatUsd(cost.output)}`
}

export type Capability = 'vision' | 'tools' | 'reasoning'

/** Small capability marks shown on one muted line, in a stable order. */
export function capabilityMarks(meta: ModelMetadata | null | undefined): Capability[] {
  if (!meta) return []
  const marks: Capability[] = []
  if (meta.vision) marks.push('vision')
  if (meta.toolCall) marks.push('tools')
  if (meta.reasoning) marks.push('reasoning')
  return marks
}

/** `1M ctx · $2/$10 · vision tools reasoning` — empty string when nothing is known. */
export function metaSummary(meta: ModelMetadata | null | undefined): string {
  if (!meta) return ''
  const parts = [formatContext(meta.contextWindow), formatPrice(meta.cost)].filter((p): p is string => !!p)
  const marks = capabilityMarks(meta)
  if (marks.length > 0) parts.push(marks.join(' '))
  return parts.join(' · ')
}

/**
 * The model to preselect for a provider with no remembered choice: the most
 * recently released one that supports tool calling (a sensible chat default),
 * else simply the first listed. Uses models.dev release dates, not id patterns.
 */
export function pickDefaultModel(
  models: readonly { id: string; meta?: ModelMetadata | null | undefined }[],
): string | null {
  let best: { id: string; date: string } | null = null
  for (const model of models) {
    const meta = model.meta
    if (!meta?.toolCall || !meta.releaseDate) continue
    if (!best || meta.releaseDate > best.date) best = { id: model.id, date: meta.releaseDate }
  }
  return best?.id ?? models[0]?.id ?? null
}

export function findModelMeta(
  catalogs: Record<string, ProviderModelCatalog>,
  providerConfigId: string | null | undefined,
  modelId: string | null | undefined,
): ModelMetadata | null {
  if (!providerConfigId || !modelId) return null
  return catalogs[providerConfigId]?.models.find((m) => m.id === modelId)?.meta ?? null
}

/** Exactly the effort values the model accepts (empty = hide the control). */
export function effortsOf(meta: ModelMetadata | null | undefined): ReasoningEffort[] {
  return meta?.reasoning ? meta.reasoningEfforts : []
}

/** Keeps a selected effort only if the (new) model supports it. */
export function keepEffort(
  effort: ReasoningEffort | null,
  meta: ModelMetadata | null | undefined,
): ReasoningEffort | null {
  return effort !== null && effortsOf(meta).includes(effort) ? effort : null
}

/** `none` is "reasoning off"; everything else is shown as the model names it. */
export function effortLabel(effort: ReasoningEffort): string {
  return effort === 'none' ? 'off' : effort
}

export type BudgetLevel = 'ok' | 'warn' | 'over' | 'unknown'

export interface ContextBudget {
  usedTokens: number
  limit: number | null
  /** used / limit, null when the limit is unknown. */
  ratio: number | null
  level: BudgetLevel
  /** `~18K / 1M`, or `~18K` when the limit is unknown. */
  label: string
}

/** The Context panel's budget: estimated prompt tokens against the model's window. */
export function contextBudget(usedTokens: number, limit: number | null | undefined): ContextBudget {
  const used = Math.max(0, Math.round(usedTokens))
  if (!limit) {
    return { usedTokens: used, limit: null, ratio: null, level: 'unknown', label: `~${formatTokens(used)}` }
  }
  const ratio = used / limit
  const level: BudgetLevel = ratio >= 1 ? 'over' : ratio >= CONTEXT_WARN_RATIO ? 'warn' : 'ok'
  return { usedTokens: used, limit, ratio, level, label: `~${formatTokens(used)} / ${formatTokens(limit)}` }
}
