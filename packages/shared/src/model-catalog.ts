import { z } from 'zod'
import type { ProviderId } from './provider'

/**
 * A three-tier reasoning/thinking effort knob shown per-model in the
 * composer. Mapped to each provider's actual API parameter in
 * `packages/providers` (OpenAI's `reasoningEffort`, Anthropic's
 * `thinking`/`effort`) — see ADR "Reasoning effort mapping" in
 * DECISIONS.md. Not every provider/model supports this; see
 * `isReasoningCapableModel`.
 */
export const ReasoningEffortSchema = z.enum(['low', 'medium', 'high'])
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export const REASONING_EFFORT_VALUES = ReasoningEffortSchema.options

/** One model as returned by a provider's live models-list endpoint (or the
 * static Anthropic fallback below). `displayName` is whatever the provider's
 * API gives us, if anything — never invented client-side. */
export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
})
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

/** The cached model list for one provider config, scoped by
 * `provider_config_id` (a single API key may only have access to a subset of
 * a provider's models, so the catalog is per-config, not per-provider). */
export const ProviderModelCatalogSchema = z.object({
  providerConfigId: z.string(),
  models: z.array(ModelCatalogEntrySchema),
  /** null when a live fetch has never succeeded for this config yet. */
  fetchedAt: z.number().nullable(),
})
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>

export const RefreshModelCatalogResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  catalog: ProviderModelCatalogSchema,
})
export type RefreshModelCatalogResult = z.infer<typeof RefreshModelCatalogResultSchema>

/**
 * Static fallback for Anthropic only, used before a live fetch has
 * succeeded (or if one fails) — see ADR "Model catalog: live-fetched with a
 * narrow static fallback" in DECISIONS.md. These are the only ids confirmed
 * current at the time this was written; do not add speculative ids here.
 * Deliberately no OpenAI fallback (no confirmed-current OpenAI ids were
 * available in this session — see DECISIONS.md). Google keeps its small
 * static fallback list in the renderer (`lib/models.ts`) unchanged from
 * Phase 2, since a live Google catalog fetch is a Known limitation for now.
 */
export const ANTHROPIC_FALLBACK_MODELS: ModelCatalogEntry[] = [
  { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5-1', displayName: 'Claude Fable 5.1' },
]

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
}

/**
 * Heuristic for whether a model plausibly supports the reasoning/thinking
 * effort knob, based only on its id (we never hardcode a model allowlist —
 * see ADR-003/DECISIONS.md "Never hard-code current model names as business
 * logic"). Anthropic: every Claude model except Haiku (Haiku does not
 * support extended thinking). OpenAI: the `o`-series reasoning models
 * (`o1`, `o3`, `o4-mini`, ...) and the `gpt-5` family, which are OpenAI's
 * reasoning-capable model lines as of this writing — matched by id prefix
 * rather than an exhaustive list so newly released ids in the same families
 * still match. Google: not wired up in V1 (see DECISIONS.md), always false.
 */
export function isReasoningCapableModel(provider: ProviderId, modelId: string): boolean {
  const id = modelId.trim().toLowerCase()
  if (!id) return false
  switch (provider) {
    case 'anthropic':
      return !id.includes('haiku')
    case 'openai':
      return /^o\d/.test(id) || id.startsWith('gpt-5')
    case 'google':
      return false
  }
}

/**
 * Anthropic extended-thinking token budget tiers for the low/medium/high
 * effort selector, sent as `thinking.budgetTokens` alongside the top-level
 * `effort` field (see ADR "Reasoning effort mapping" in DECISIONS.md for why
 * both are sent). Must each be >= 1024 (Anthropic's documented minimum).
 */
export const ANTHROPIC_THINKING_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  low: 4_000,
  medium: 10_000,
  high: 24_000,
}
