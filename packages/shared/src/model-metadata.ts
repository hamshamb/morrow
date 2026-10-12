import { z } from 'zod'

/**
 * Reasoning/thinking effort values that appear in models.dev's
 * `reasoning_options[].values`, in weakest-to-strongest order. `none` means
 * "reasoning off" for models that allow it. A model exposes only the subset it
 * supports (`ModelMetadata.reasoningEfforts`); each provider SDK maps a value
 * to its own request parameter in `@ai-workspace/providers`
 * (`reasoning-options.ts`), and a value an SDK cannot send is never offered.
 *
 * models.dev also contains the sentinel values `default` and `null`; those
 * are not user-selectable levels and are dropped when metadata is normalized.
 */
export const ReasoningEffortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
export type ReasoningEffort = z.infer<typeof ReasoningEffortSchema>
export const REASONING_EFFORT_VALUES = ReasoningEffortSchema.options

/** Sort efforts weakest -> strongest and drop duplicates. */
export function sortEfforts(values: Iterable<ReasoningEffort>): ReasoningEffort[] {
  const set = new Set(values)
  return REASONING_EFFORT_VALUES.filter((v) => set.has(v))
}

/** USD per 1M tokens, as models.dev reports it. */
export const ModelCostSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().nullable(),
  cacheWrite: z.number().nullable(),
})
export type ModelCost = z.infer<typeof ModelCostSchema>

export const ModelStatusSchema = z.enum(['alpha', 'beta', 'deprecated'])

/**
 * Per-model capabilities and limits, sourced from models.dev (https://models.dev,
 * MIT) and joined onto a provider's model list by id. This replaces the old
 * id-regex heuristics (`isReasoningCapableModel`, the "Haiku has no thinking"
 * rule): whether a model reasons, and exactly which effort values it accepts,
 * is read from the data.
 */
export const ModelMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().nullable(),
  reasoning: z.boolean(),
  /** Effort values the model accepts AND this app can send (see ReasoningEffortSchema). */
  reasoningEfforts: z.array(ReasoningEffortSchema),
  /** True when the model can only be switched on/off (no effort levels). */
  reasoningToggle: z.boolean(),
  /** Token-budget thinking range for models that use `budget_tokens`. */
  reasoningBudget: z.object({ min: z.number().nullable(), max: z.number().nullable() }).nullable(),
  /** models.dev `attachment`: accepts file attachments. */
  attachment: z.boolean(),
  /** Accepts image input. */
  vision: z.boolean(),
  inputModalities: z.array(z.string()),
  toolCall: z.boolean(),
  structuredOutput: z.boolean(),
  /** Context window in tokens (null when unknown / zero). */
  contextWindow: z.number().nullable(),
  maxOutput: z.number().nullable(),
  cost: ModelCostSchema.nullable(),
  /** Knowledge cutoff as models.dev writes it (`2026-01` / `2026-01-31`). */
  knowledge: z.string().nullable(),
  releaseDate: z.string().nullable(),
  openWeights: z.boolean(),
  status: ModelStatusSchema.nullable(),
})
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>

/** Where the metadata catalog currently comes from. */
export const ModelsMetadataSourceSchema = z.enum(['bundled', 'cache', 'network'])
export type ModelsMetadataSource = z.infer<typeof ModelsMetadataSourceSchema>

export const ModelsMetadataStatusSchema = z.object({
  source: ModelsMetadataSourceSchema,
  /** Epoch ms the live catalog was last downloaded; null while on the bundled snapshot. */
  fetchedAt: z.number().nullable(),
  /** False when the user turned the network fetch off in Settings. */
  networkEnabled: z.boolean(),
  providerCount: z.number(),
  modelCount: z.number(),
})
export type ModelsMetadataStatus = z.infer<typeof ModelsMetadataStatusSchema>

export const RefreshModelsMetadataResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  status: ModelsMetadataStatusSchema,
})
export type RefreshModelsMetadataResult = z.infer<typeof RefreshModelsMetadataResultSchema>

/** Rough prompt-budget percentage above which the Context panel warns. */
export const CONTEXT_WARN_RATIO = 0.8
