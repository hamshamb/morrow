import { z } from 'zod'

/**
 * A provider id is the models.dev provider id (`anthropic`, `openai`,
 * `google`, `xai`, `groq`, `openrouter`, ...) or one of our two synthetic
 * ids (`ollama`, `custom`) — see the registry in `@ai-workspace/providers`.
 *
 * It used to be a closed 3-value enum; it is now a validated string so the
 * provider list can be data-driven (ADR-024). Rows persisted by older builds
 * (`anthropic` / `openai` / `google`) are valid under the new rule, so no data
 * migration is needed. The regex keeps ids safe to use as settings keys, CSS
 * hooks and log fields (lowercase, digits, `.`, `_`, `-`; no whitespace).
 */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
export const ProviderIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(PROVIDER_ID_PATTERN, 'provider id must be lowercase letters, digits, ".", "_" or "-"')
export type ProviderId = z.infer<typeof ProviderIdSchema>

/** Synthetic providers that do not come from models.dev. */
export const OLLAMA_PROVIDER_ID = 'ollama'
export const CUSTOM_PROVIDER_ID = 'custom'
export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'

/**
 * What the renderer is allowed to see about a stored provider credential.
 * Never includes the raw or encrypted key — only a masked preview computed
 * once at creation time (e.g. "sk-...ab12").
 */
export const ProviderConfigSummarySchema = z.object({
  id: z.string(),
  provider: ProviderIdSchema,
  label: z.string(),
  maskedKey: z.string(),
  baseUrl: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type ProviderConfigSummary = z.infer<typeof ProviderConfigSummarySchema>

/**
 * `apiKey` may be empty: local providers (Ollama, LM Studio) and some custom
 * endpoints need no key. Whether a key is *required* depends on the provider
 * (`ProviderRegistryEntry.keyRequired`), which only the main process can look
 * up, so the add/test handlers enforce it there.
 */
export const AddProviderConfigInputSchema = z.object({
  provider: ProviderIdSchema,
  label: z.string().min(1).max(200),
  apiKey: z.string().max(4000),
  baseUrl: z.string().url().nullable().optional(),
})
export type AddProviderConfigInput = z.infer<typeof AddProviderConfigInputSchema>

export const TestProviderConfigInputSchema = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().max(4000),
  baseUrl: z.string().url().nullable().optional(),
})
export type TestProviderConfigInput = z.infer<typeof TestProviderConfigInputSchema>

export const TestProviderConfigResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** The key works, but something the user should know (e.g. the test model is out of quota). */
  warning: z.string().optional(),
})
export type TestProviderConfigResult = z.infer<typeof TestProviderConfigResultSchema>

/** A provider error that means "authenticated, but throttled or out of quota/credits" — not a bad key. */
export function isRateLimitOrQuotaError(raw: string | null | undefined): boolean {
  return /\b429\b|rate[ _-]?limit|too many requests|quota|resource_exhausted|insufficient[ _-]?quota|billing|credit/i.test(raw ?? '')
}

/**
 * How a registry provider is wired up:
 * - `bundled`: models.dev's `npm` package is one we ship (anthropic, openai,
 *   google, xai, mistral, groq, cerebras, togetherai, perplexity, openrouter,
 *   deepseek — the last by explicit override);
 * - `openai-compatible`: not shipped, but models.dev gives a base URL, so it
 *   runs through `@ai-sdk/openai-compatible`;
 * - `local`: Ollama (our own entry) and LM Studio-style localhost endpoints;
 * - `custom`: the user supplies the base URL.
 */
export const ProviderKindSchema = z.enum(['bundled', 'openai-compatible', 'local', 'custom'])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/** One provider the app can run, as shown in onboarding and Settings. */
export const ProviderRegistryEntrySchema = z.object({
  id: ProviderIdSchema,
  name: z.string(),
  kind: ProviderKindSchema,
  /** models.dev documentation link, when the provider has one. */
  doc: z.string().nullable(),
  keyRequired: z.boolean(),
  isLocal: z.boolean(),
  /** Base URL used when the user does not override it (null = SDK default). */
  defaultBaseUrl: z.string().nullable(),
  /** A distinctive API-key prefix (e.g. `xai-`) used for onboarding
   * auto-detection; null when the provider's keys have no reliable prefix. */
  keyPrefix: z.string().nullable(),
  /** 0 = shown first; null = after the popular group, alphabetical. */
  popularRank: z.number().nullable(),
  /** How many chat models the metadata catalog lists for this provider. */
  modelCount: z.number(),
})
export type ProviderRegistryEntry = z.infer<typeof ProviderRegistryEntrySchema>

/**
 * Detects the provider a pasted key belongs to from its prefix. Longer
 * prefixes win (`sk-ant-` / `sk-or-` before a bare `sk-`). Returns null when
 * the prefix is unknown or shared, so the caller asks the user to choose.
 * Only a form convenience — every key is still verified by a real connection
 * test before it is saved.
 */
export function detectProviderByKeyPrefix(
  rawKey: string,
  registry: readonly Pick<ProviderRegistryEntry, 'id' | 'keyPrefix'>[],
): string | null {
  const key = rawKey.trim()
  if (!key) return null
  let best: { id: string; length: number } | null = null
  for (const entry of registry) {
    const prefix = entry.keyPrefix
    if (!prefix || !key.startsWith(prefix)) continue
    if (!best || prefix.length > best.length) best = { id: entry.id, length: prefix.length }
  }
  return best?.id ?? null
}

/** Result of probing the machine for local model servers. */
export const LocalProviderStatusSchema = z.object({
  id: ProviderIdSchema,
  baseUrl: z.string(),
  running: z.boolean(),
  modelCount: z.number(),
})
export type LocalProviderStatus = z.infer<typeof LocalProviderStatusSchema>
