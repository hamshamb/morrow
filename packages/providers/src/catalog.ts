/**
 * Catalog join (ADR-023): a provider config's model list is
 *
 *   live ids  — what this key can actually access (the provider's own
 *               `GET /models`, cached per config) —
 *   enriched by id with models.dev metadata (context window, price,
 *   capabilities, exact reasoning-effort values),
 *
 * or, when no live list exists (not fetched yet, provider has no list
 * endpoint, request failed), models.dev's own model list for the provider.
 */
import type { CatalogSource, ModelCatalogEntry, ModelMetadata } from '@ai-workspace/shared'
import {
  isChatModel,
  isSelectableModel,
  normalizeModel,
  type ModelsDevModel,
  type ModelsDevProvider,
} from './models-dev'
import { usableEfforts } from './reasoning-options'
import type { FactoryKey } from './registry'

/** Date/version suffixes providers append to a base id (`-20250929`, `-2025-09-29`, `:latest`, `@001`). */
const SUFFIX_PATTERNS = [/-\d{8}$/, /-\d{4}-\d{2}-\d{2}$/, /:latest$/, /@\w+$/, /-latest$/]

function lookupModel(provider: ModelsDevProvider | undefined, id: string): ModelsDevModel | undefined {
  if (!provider) return undefined
  const direct = provider.models[id]
  if (direct) return direct
  const lower = id.toLowerCase()
  for (const [key, model] of Object.entries(provider.models)) if (key.toLowerCase() === lower) return model
  // Strip a trailing version/date suffix and retry (live `claude-x-20250929`
  // vs models.dev `claude-x`), then the reverse (models.dev dated, live bare).
  for (const pattern of SUFFIX_PATTERNS) {
    if (pattern.test(lower)) {
      const base = lower.replace(pattern, '')
      for (const [key, model] of Object.entries(provider.models)) if (key.toLowerCase() === base) return model
    }
  }
  return undefined
}

/**
 * Metadata for one model id, with `reasoningEfforts` narrowed to what this
 * provider's SDK can send (so the UI never offers a level that would be
 * dropped). Returns null for ids models.dev does not know.
 */
export function lookupModelMetadata(
  provider: ModelsDevProvider | undefined,
  modelId: string,
  factoryKey: FactoryKey,
): ModelMetadata | null {
  const raw = lookupModel(provider, modelId)
  if (!raw) return null
  const meta = normalizeModel(raw)
  const efforts = usableEfforts(factoryKey, meta.reasoningEfforts)
  return {
    ...meta,
    // Keep the id the user/provider actually uses, not models.dev's alias.
    id: modelId,
    reasoningEfforts: efforts,
    reasoningToggle: meta.reasoningToggle && efforts.length === 0,
  }
}

/** Live ids that are clearly not chat models and have no models.dev entry to say so. */
const NON_CHAT_ID = /(embed|moderation|whisper|tts|dall-e|transcribe|rerank|guard|image-gen)/i

export interface JoinCatalogInput {
  provider: ModelsDevProvider | undefined
  factoryKey: FactoryKey
  /** The provider's live model list for this key; null/empty = none available. */
  live: readonly Pick<ModelCatalogEntry, 'id' | 'displayName'>[] | null | undefined
}

export interface JoinedCatalog {
  models: ModelCatalogEntry[]
  source: CatalogSource
}

export function joinCatalog(input: JoinCatalogInput): JoinedCatalog {
  const { provider, factoryKey, live } = input
  if (live && live.length > 0) {
    const models: ModelCatalogEntry[] = []
    for (const entry of live) {
      const raw = lookupModel(provider, entry.id)
      if (raw && !isChatModel(raw)) continue
      if (!raw && NON_CHAT_ID.test(entry.id)) continue
      const meta = lookupModelMetadata(provider, entry.id, factoryKey)
      models.push({ id: entry.id, displayName: entry.displayName ?? meta?.name ?? null, meta })
    }
    models.sort((a, b) => a.id.localeCompare(b.id))
    return { models, source: 'live' }
  }
  if (!provider) return { models: [], source: 'empty' }
  const models: ModelCatalogEntry[] = []
  for (const raw of Object.values(provider.models)) {
    if (!isSelectableModel(raw)) continue
    const meta = lookupModelMetadata(provider, raw.id, factoryKey)
    models.push({ id: raw.id, displayName: meta?.name ?? null, meta })
  }
  // Newest first reads best for a list the user never fetched themselves.
  models.sort(
    (a, b) =>
      (b.meta?.releaseDate ?? '').localeCompare(a.meta?.releaseDate ?? '') || a.id.localeCompare(b.id),
  )
  return { models, source: models.length > 0 ? 'metadata' : 'empty' }
}

/** Chat-capable on paper, but a poor probe: live/realtime APIs, media
 * generators, translation and agentic specials often reject a plain chat
 * request or carry no free-tier quota (e.g. google `gemini-3.5-live-translate-preview`). */
const SPECIAL_PURPOSE = /live|realtime|audio|tts|speech|image|imagen|veo|lyria|music|video|translate|computer-use|deep-research/i
const UNSTABLE = /(^|[-_.:/])(preview|exp|experimental|beta|alpha)([-_.:/]|$)/i

function isUnstable(m: ModelsDevModel): boolean {
  return UNSTABLE.test(m.id) || m.status === 'beta' || m.status === 'alpha'
}

/**
 * Picks the model to probe a key with (no hardcoded ids): a plain, stable chat
 * model, free or cheapest first. With `availableIds` (the key's own model
 * list) only models the provider currently serves to this key are considered,
 * and a $0 price is trusted, so free models win. Without a list, $0 rows go
 * last (they are often placeholders in models.dev). Newest first on ties.
 * Null when nothing fits — the caller then verifies by listing.
 */
export function pickProbeModel(
  provider: ModelsDevProvider | undefined,
  /** Only consider these ids (the models the key's own list endpoint returned). */
  availableIds?: ReadonlySet<string>,
): string | null {
  if (!provider) return null
  const candidates = Object.values(provider.models).filter(
    (m) =>
      isSelectableModel(m) &&
      !SPECIAL_PURPOSE.test(m.id) &&
      m.cost &&
      (m.cost.input !== undefined || m.cost.output !== undefined) &&
      (!availableIds || availableIds.has(m.id)),
  )
  if (candidates.length === 0) return null
  const price = (m: ModelsDevModel): number => (m.cost?.input ?? 0) + (m.cost?.output ?? 0)
  const freeIsReal = availableIds !== undefined
  const ranked = candidates.sort(
    (a, b) =>
      Number(isUnstable(a)) - Number(isUnstable(b)) ||
      (freeIsReal ? 0 : Number(price(a) === 0) - Number(price(b) === 0)) ||
      price(a) - price(b) ||
      Number(a.reasoning === true) - Number(b.reasoning === true) ||
      (b.release_date ?? '').localeCompare(a.release_date ?? '') ||
      a.id.localeCompare(b.id),
  )
  return ranked[0]!.id
}
