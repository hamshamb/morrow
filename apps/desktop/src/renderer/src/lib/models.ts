import {
  ANTHROPIC_FALLBACK_MODELS,
  PROVIDER_LABELS,
  type ModelCatalogEntry,
  type ProviderId,
} from '@ai-workspace/shared'

export type { ModelCatalogEntry as ModelOption }
export { PROVIDER_LABELS }

/**
 * Static fallback shown before a live fetch has succeeded (or if one
 * fails). Anthropic's fallback (`ANTHROPIC_FALLBACK_MODELS`) lives in
 * `@ai-workspace/shared` since the main process also needs it as the
 * ultimate "nothing cached yet" default. OpenAI has no fallback at all —
 * no confirmed-current OpenAI model ids were available when this was
 * written, so its picker relies entirely on the live catalog (empty/
 * prompt-to-test-connection until a fetch succeeds). Google keeps the small
 * hardcoded list from Phase 2 — live-fetching Google's catalog is a known
 * limitation for now (see DECISIONS.md).
 */
export const STATIC_FALLBACK_MODELS: Record<ProviderId, ModelCatalogEntry[]> = {
  anthropic: ANTHROPIC_FALLBACK_MODELS,
  openai: [],
  google: [
    { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
    { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
  ],
}
