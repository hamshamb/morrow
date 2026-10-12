import { z } from 'zod'
import { MAX_ATTACHMENTS_PER_MESSAGE, PendingAttachmentSchema } from './attachment'

/**
 * Rough token estimate used throughout the Context Inspector: characters /
 * 4. This is a heuristic, not a real tokenizer — good enough to give the
 * user a sense of scale without adding a tokenizer dependency (see
 * DECISIONS.md). Always label numbers derived from this as an estimate.
 */
export function estimateTokens(characterCount: number): number {
  return Math.ceil(characterCount / 4)
}

/** Total character budget for the context block actually injected into a
 * single chat turn (across attachments + selected workspace files +
 * retrieval snippets combined). Sources are included in the order given and
 * truncated/dropped once this cap is hit — see DECISIONS.md. */
export const CONTEXT_TOTAL_CHAR_CAP = 60_000

/** Per-source cap so one huge file can't crowd out every other selected
 * source. */
export const CONTEXT_PER_SOURCE_CHAR_CAP = 20_000

export const ContextSourceTypeSchema = z.enum([
  'conversation-history',
  'attachment',
  'workspace-file',
  'retrieval-snippet',
])
export type ContextSourceType = z.infer<typeof ContextSourceTypeSchema>

/**
 * One toggleable item the Context Inspector shows the user before a message
 * is sent. `id` is stable within a single inspector response and is echoed
 * back (minus excluded ids) in `ContextSelectionSchema` at send time — see
 * DECISIONS.md for why selection is id-based rather than re-derived.
 */
export const ContextSourceSchema = z.object({
  id: z.string(),
  type: ContextSourceTypeSchema,
  label: z.string(),
  detail: z.string().nullable(),
  characterCount: z.number(),
  estimatedTokens: z.number(),
  /** Whether this source is pre-checked when the inspector is first shown.
   * History and explicitly attached/selected files default on; auto-surfaced
   * retrieval snippets default on only for the strongest few matches. */
  includedByDefault: z.boolean(),
  /** True once this source (combined with everything before it, in order)
   * would exceed CONTEXT_TOTAL_CHAR_CAP — shown so the user understands why
   * toggling it on may not change what's actually sent. */
  exceedsBudget: z.boolean(),
})
export type ContextSource = z.infer<typeof ContextSourceSchema>

export const ContextInspectorStateSchema = z.object({
  sources: z.array(ContextSourceSchema),
  totalCharacterCount: z.number(),
  totalEstimatedTokens: z.number(),
  budgetCharacterCap: z.number(),
})
export type ContextInspectorState = z.infer<typeof ContextInspectorStateSchema>

export const GetContextInspectorInputSchema = z.object({
  workspaceId: z.string().min(1),
  conversationId: z.string().min(1),
  /** The message about to be sent — included so the history source's count
   * reflects the turn that's about to happen, and so retrieval snippets can
   * be surfaced from it. */
  draftContent: z.string().max(100_000).default(''),
  pendingAttachments: z.array(PendingAttachmentSchema).default([]),
  /** Workspace files the user has explicitly picked (from search/browse) to
   * include, by path relative to the workspace file root. */
  selectedWorkspaceFilePaths: z.array(z.string()).max(50).default([]),
})
export type GetContextInspectorInput = z.infer<typeof GetContextInspectorInputSchema>

/**
 * What actually gets sent for one chat turn — the renderer resolves this
 * from a `ContextInspectorState` by keeping only sources the user left
 * toggled on. `chat:send-message` uses exactly this (not a re-fetched
 * inspector state) so what was inspected is what gets sent.
 */
export const ContextSelectionSchema = z.object({
  includeHistory: z.boolean().default(true),
  attachments: z.array(PendingAttachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
  workspaceFilePaths: z.array(z.string()).max(50).default([]),
  retrievalSnippetPaths: z.array(z.string()).max(50).default([]),
})
export type ContextSelection = z.infer<typeof ContextSelectionSchema>
