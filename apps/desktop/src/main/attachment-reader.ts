import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  attachmentMimeType,
  attachmentRejectionReason,
  looksBinary,
  type AttachFilesResult,
  type PendingAttachment,
} from '@ai-workspace/shared'

/**
 * Reads a local file the user picked to attach to a chat message, enforcing
 * the shared attachment rules (supported-extension allowlist,
 * MAX_ATTACHMENT_BYTES, no binary content). Throws a user-facing message on
 * rejection — never silently attaches an unsupported/oversized/binary file.
 */
export function readAttachmentFile(filePath: string): PendingAttachment {
  const filename = basename(filePath)
  const stat = statSync(filePath)
  const reason = attachmentRejectionReason(filename, stat.size)
  if (reason) throw new Error(`${filename}: ${reason}`)

  const content = readFileSync(filePath, 'utf8')
  if (looksBinary(content)) throw new Error(`${filename}: binary file`)
  return { filename, mimeType: attachmentMimeType(filename), sizeBytes: stat.size, content }
}

/** Reads several picked files; one bad file is reported, not fatal to the rest. */
export function readAttachmentFiles(filePaths: string[]): AttachFilesResult {
  const result: AttachFilesResult = { attachments: [], rejected: [] }
  for (const filePath of filePaths) {
    try {
      result.attachments.push(readAttachmentFile(filePath))
    } catch (err) {
      const filename = basename(filePath)
      const message = err instanceof Error ? err.message : String(err)
      result.rejected.push({ filename, reason: message.startsWith(`${filename}: `) ? message.slice(filename.length + 2) : message })
    }
  }
  return result
}
