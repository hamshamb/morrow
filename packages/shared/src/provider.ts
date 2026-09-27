import { z } from 'zod'

/**
 * Supported AI providers. Kept intentionally small (Phase 2 scope) — no
 * gateway/aggregator option, no "auto" provider. Provider-direct calls with
 * user-supplied API keys are the default and only path (see ADR-003).
 */
export const ProviderIdSchema = z.enum(['anthropic', 'openai', 'google'])
export type ProviderId = z.infer<typeof ProviderIdSchema>

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

export const AddProviderConfigInputSchema = z.object({
  provider: ProviderIdSchema,
  label: z.string().min(1).max(200),
  apiKey: z.string().min(1).max(4000),
  baseUrl: z.string().url().nullable().optional(),
})
export type AddProviderConfigInput = z.infer<typeof AddProviderConfigInputSchema>

export const TestProviderConfigInputSchema = z.object({
  provider: ProviderIdSchema,
  apiKey: z.string().min(1).max(4000),
  baseUrl: z.string().url().nullable().optional(),
})
export type TestProviderConfigInput = z.infer<typeof TestProviderConfigInputSchema>

export const TestProviderConfigResultSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
})
export type TestProviderConfigResult = z.infer<typeof TestProviderConfigResultSchema>
