import { z } from 'zod'

/**
 * A local file attached to a chat message. Content is extracted text (V1
 * supports plain-text-like files only — see `SUPPORTED_ATTACHMENT_EXTENSIONS`
 * in `workspace-file.ts`); binary content is never stored. Scoped to a
 * single message (created alongside it, never re-parented) — see
 * ARCHITECTURE.md "Data model".
 */
export const AttachmentSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  content: z.string(),
  createdAt: z.number(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

/** Maximum size (bytes) of a single attached file, enforced when reading it
 * from disk in the main process. Kept small — attachments are meant for
 * pasting a file's worth of context into a message, not bulk ingestion (use
 * workspace file indexing/retrieval for that). */
export const MAX_ATTACHMENT_BYTES = 512 * 1024

/**
 * A file the renderer has read (via `attachments.pickFile`) but not yet sent
 * — content lives in renderer memory until `chat:send-message` persists it
 * as a real `Attachment` row scoped to the new user message.
 */
export const PendingAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().nonnegative(),
  content: z.string().max(MAX_ATTACHMENT_BYTES),
})
export type PendingAttachment = z.infer<typeof PendingAttachmentSchema>
