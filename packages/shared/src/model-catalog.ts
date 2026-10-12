import { z } from 'zod'
import { ModelMetadataSchema } from './model-metadata'

/**
 * One model in a provider config's list. `displayName` is whatever the
 * provider's own API gave us (if anything) — never invented client-side.
 * `meta` is the models.dev enrichment joined by id in the main process
 * (`joinCatalog` in `@ai-workspace/providers`); null/absent for ids models.dev
 * does not know (a brand-new model, an Ollama tag, a custom endpoint).
 */
export const ModelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullable(),
  meta: ModelMetadataSchema.nullable().optional(),
})
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>

/** Where a catalog's model list came from. */
export const CatalogSourceSchema = z.enum([
  /** The provider's own models endpoint, enriched with models.dev metadata. */
  'live',
  /** No live list yet (or none exists): models.dev's list for the provider. */
  'metadata',
  /** Nothing known (e.g. a custom endpoint whose /models call failed). */
  'empty',
])
export type CatalogSource = z.infer<typeof CatalogSourceSchema>

/** The model list for one provider config, scoped by `provider_config_id`
 * (a single API key may only have access to a subset of a provider's models,
 * so the catalog is per-config, not per-provider). */
export const ProviderModelCatalogSchema = z.object({
  providerConfigId: z.string(),
  models: z.array(ModelCatalogEntrySchema),
  /** null when a live fetch has never succeeded for this config yet. */
  fetchedAt: z.number().nullable(),
  source: CatalogSourceSchema.optional(),
})
export type ProviderModelCatalog = z.infer<typeof ProviderModelCatalogSchema>

export const RefreshModelCatalogResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  catalog: ProviderModelCatalogSchema,
})
export type RefreshModelCatalogResult = z.infer<typeof RefreshModelCatalogResultSchema>
