import { z } from 'zod'
import { SUPPORTED_TEXT_EXTENSIONS } from './workspace-file'

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

/** How many files one message can carry (also enforced by the send schema). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20

/**
 * A file the renderer has read (picked via `attachments.pickFiles`, or
 * dropped on the composer) but not yet sent — content lives in renderer
 * memory until `chat:send-message` persists it as a real `Attachment` row
 * scoped to the new user message.
 */
export const PendingAttachmentSchema = z.object({
  filename: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(200),
  sizeBytes: z.number().nonnegative(),
  content: z.string().max(MAX_ATTACHMENT_BYTES),
})
export type PendingAttachment = z.infer<typeof PendingAttachmentSchema>

export interface AttachmentRejection {
  filename: string
  reason: string
}

/** Result of picking/dropping several files: what was attached and what was skipped, and why. */
export interface AttachFilesResult {
  attachments: PendingAttachment[]
  rejected: AttachmentRejection[]
}

const MIME_BY_EXTENSION: Record<string, string> = {
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.json': 'application/json',
  '.jsonc': 'application/json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
}

const SUPPORTED_EXTENSIONS = new Set<string>(SUPPORTED_TEXT_EXTENSIONS)

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot).toLowerCase() : ''
}

export function attachmentMimeType(filename: string): string {
  return MIME_BY_EXTENSION[extensionOf(filename)] ?? 'text/plain'
}

/** Why a file can't be attached, or null if it can (type + size; content is checked separately). */
export function attachmentRejectionReason(filename: string, sizeBytes: number): string | null {
  const ext = extensionOf(filename)
  if (!SUPPORTED_EXTENSIONS.has(ext)) return `unsupported type ${ext || '(no extension)'}`
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return `too large (${Math.ceil(sizeBytes / 1024)} kB, max ${MAX_ATTACHMENT_BYTES / 1024} kB)`
  }
  return null
}

/** Text decoded from a binary file (images, archives, executables) contains NUL characters. */
export function looksBinary(content: string): boolean {
  return content.includes('\u0000')
}

/** `notes.md` → `notes (2).md` when the name is taken, so two same-named files never replace each other. */
export function uniqueAttachmentName(taken: ReadonlySet<string>, filename: string): string {
  if (!taken.has(filename)) return filename
  const ext = extensionOf(filename)
  const stem = ext ? filename.slice(0, -ext.length) : filename
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/**
 * Appends `incoming` to `existing`: renames same-named files instead of
 * replacing them, and stops at MAX_ATTACHMENTS_PER_MESSAGE (the overflow is
 * reported as rejected, never silently dropped). Pure.
 */
export function mergeAttachments(existing: PendingAttachment[], incoming: PendingAttachment[]): AttachFilesResult {
  const attachments = existing.slice()
  const rejected: AttachmentRejection[] = []
  const taken = new Set(existing.map((a) => a.filename))
  for (const file of incoming) {
    if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejected.push({ filename: file.filename, reason: `limit of ${MAX_ATTACHMENTS_PER_MESSAGE} files per message` })
      continue
    }
    const filename = uniqueAttachmentName(taken, file.filename)
    taken.add(filename)
    attachments.push({ ...file, filename })
  }
  return { attachments, rejected }
}
