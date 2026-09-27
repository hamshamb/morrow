import { z } from 'zod'
import { ReasoningEffortSchema } from './model-catalog'

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

export const AppSettingsSchema = z.object({
  theme: ThemeSchema,
  activeWorkspaceId: z.string().nullable(),
  lastModelSelection: LastModelSelectionSchema.nullable(),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPartialSchema = AppSettingsSchema.partial()
export type AppSettingsPartial = z.infer<typeof AppSettingsPartialSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  activeWorkspaceId: null,
  lastModelSelection: null,
}
