import { z } from 'zod'
import { ReasoningEffortSchema } from './model-metadata'
import { AutoPreferenceSchema, DEFAULT_AUTO_PREFERENCE } from './orchestration'

export const ThemeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof ThemeSchema>

/**
 * What the composer had selected the last time the user changed
 * provider/model/effort — restored as the default selection on the next
 * app start / new conversation instead of always picking
 * `providerConfigs[0]` + that provider's first model (see ChatPanel and
 * ADR "Persisted last-used model selection" in DECISIONS.md). Nullable as a
 * whole (never selected anything yet) rather than each field optional,
 * since a partial selection isn't meaningful on its own.
 */
export const LastModelSelectionSchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
  effort: ReasoningEffortSchema.nullable(),
})
export type LastModelSelection = z.infer<typeof LastModelSelectionSchema>

/** A model the user starred in the picker (provider-config scoped, like
 * the catalog — the same model id under two keys is two entries). */
export const ModelRefSchema = z.object({
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
})
export type ModelRef = z.infer<typeof ModelRefSchema>

/** Caps keep the stored JSON small and the picker's top groups short. */
export const MAX_FAVORITE_MODELS = 20
export const MAX_RECENT_MODELS = 3

/** Field definitions without defaults — the partial (update) schema is built
 * from these. Zod 4 re-applies `.default()` values when a defaulted field is
 * absent even under `.partial()`, which would let `settings.set({ theme })`
 * silently reset favorites and re-enable the models.dev fetch. */
const appSettingsFields = {
  theme: ThemeSchema,
  activeWorkspaceId: z.string().nullable(),
  lastModelSelection: LastModelSelectionSchema.nullable(),
  /** Starred models, shown first in the model picker and in the command palette. */
  favoriteModels: z.array(ModelRefSchema).max(MAX_FAVORITE_MODELS),
  /** Most-recently-used selections, newest first (see `pushRecentModel`). */
  recentModels: z.array(LastModelSelectionSchema).max(MAX_RECENT_MODELS),
  /** Whether the app may download the models.dev catalog (https://models.dev/api.json,
   * ~5 MB, refreshed at most every 24h; nothing about the user is sent). When
   * false the app runs entirely on the bundled snapshot — ADR-021. */
  modelsDevFetchEnabled: z.boolean(),
  /** Auto mode's cost/quality preference: cheapest | balanced | best (ADR-030). */
  autoPreference: AutoPreferenceSchema,
}

export const AppSettingsSchema = z.object({
  ...appSettingsFields,
  // Additive fields are defaulted so settings written by older builds still
  // parse; the key/value `settings` table needs no migration.
  favoriteModels: appSettingsFields.favoriteModels.default([]),
  recentModels: appSettingsFields.recentModels.default([]),
  modelsDevFetchEnabled: appSettingsFields.modelsDevFetchEnabled.default(true),
  autoPreference: appSettingsFields.autoPreference.default(DEFAULT_AUTO_PREFERENCE),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPartialSchema = z.object(appSettingsFields).partial()
export type AppSettingsPartial = z.infer<typeof AppSettingsPartialSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  activeWorkspaceId: null,
  lastModelSelection: null,
  favoriteModels: [],
  recentModels: [],
  modelsDevFetchEnabled: true,
  autoPreference: DEFAULT_AUTO_PREFERENCE,
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.providerConfigId === b.providerConfigId && a.model === b.model
}

export function isFavoriteModel(favorites: ModelRef[], ref: ModelRef): boolean {
  return favorites.some((f) => sameModel(f, ref))
}

/** Adds `ref` if absent (appended, capped), removes it if present. Pure. */
export function toggleFavoriteModel(favorites: ModelRef[], ref: ModelRef): ModelRef[] {
  if (isFavoriteModel(favorites, ref)) return favorites.filter((f) => !sameModel(f, ref))
  return [...favorites, { providerConfigId: ref.providerConfigId, model: ref.model }].slice(
    -MAX_FAVORITE_MODELS,
  )
}

/** Moves `selection` to the front of the recents list (deduped by
 * provider config + model, keeping the newest effort), capped. Pure. */
export function pushRecentModel(
  recents: LastModelSelection[],
  selection: LastModelSelection,
  max: number = MAX_RECENT_MODELS,
): LastModelSelection[] {
  return [selection, ...recents.filter((r) => !sameModel(r, selection))].slice(0, max)
}

/** Drops entries whose provider config no longer exists (e.g. a key was
 * removed in Settings). Pure. */
export function pruneModelRefs<T extends ModelRef>(refs: T[], existingConfigIds: string[]): T[] {
  return refs.filter((r) => existingConfigIds.includes(r.providerConfigId))
}
