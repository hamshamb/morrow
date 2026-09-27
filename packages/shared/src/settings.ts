import { z } from 'zod'

export const ThemeSchema = z.enum(['light', 'dark', 'system'])
export type Theme = z.infer<typeof ThemeSchema>

export const AppSettingsSchema = z.object({
  theme: ThemeSchema,
  activeWorkspaceId: z.string().nullable(),
})
export type AppSettings = z.infer<typeof AppSettingsSchema>

export const AppSettingsPartialSchema = AppSettingsSchema.partial()
export type AppSettingsPartial = z.infer<typeof AppSettingsPartialSchema>

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  activeWorkspaceId: null,
}
