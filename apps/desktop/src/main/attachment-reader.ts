import { readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { MAX_ATTACHMENT_BYTES, SUPPORTED_TEXT_EXTENSIONS, type PendingAttachment } from '@ai-workspace/shared'

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

const SUPPORTED_EXTENSION_SET = new Set<string>(SUPPORTED_TEXT_EXTENSIONS)

/**
 * Reads a local file the user picked to attach to a chat message, enforcing
 * the same supported-extension allowlist and size cap used for workspace
 * file indexing (see `SUPPORTED_TEXT_EXTENSIONS`/`MAX_ATTACHMENT_BYTES` in
 * `@ai-workspace/shared`). Throws a user-facing error message on rejection
 * — never silently attaches an unsupported/oversized/binary file.
 */
export function readAttachmentFile(filePath: string): PendingAttachment {
  const ext = extname(filePath).toLowerCase()
  if (!SUPPORTED_EXTENSION_SET.has(ext)) {
    throw new Error(
      `Unsupported file type "${ext || '(no extension)'}". Supported: ${SUPPORTED_TEXT_EXTENSIONS.join(', ')}.`,
    )
  }

  const stat = statSync(filePath)
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `"${basename(filePath)}" is too large to attach (${stat.size} bytes, max ${MAX_ATTACHMENT_BYTES}).`,
    )
  }

  const content = readFileSync(filePath, 'utf8')
  return {
    filename: basename(filePath),
    mimeType: MIME_BY_EXTENSION[ext] ?? 'text/plain',
    sizeBytes: stat.size,
    content,
  }
}
