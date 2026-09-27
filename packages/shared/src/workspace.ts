import { z } from 'zod'

export const WorkspaceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Workspace = z.infer<typeof WorkspaceSchema>

export const CreateWorkspaceInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
})
export type CreateWorkspaceInput = z.infer<typeof CreateWorkspaceInputSchema>

export const UpdateWorkspaceInputSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
})
export type UpdateWorkspaceInput = z.infer<typeof UpdateWorkspaceInputSchema>
