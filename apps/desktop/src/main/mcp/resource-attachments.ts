import {
  SUPPORTED_TEXT_EXTENSIONS,
  attachmentMimeType,
  attachmentRejectionReason,
  looksBinary,
  uniqueAttachmentName,
  type AttachFilesResult,
  type McpResourceInfo,
} from '@ai-workspace/shared'
import { base64Bytes } from './result-format'
import { cleanDisplayText } from './tool-adapter'

/**
 * MCP resources become ordinary pending attachments (ADR-049): text only, through the same size cap, binary check and
 * extension allowlist as a file the user picked, and then through the same untrusted `<attached_context>` framing.
 * Nothing about a resource is trusted - not its name, its mime type or its text.
 */

export interface ReadContent {
  uri: string
  mimeType?: string | undefined
  text?: string | undefined
  blob?: string | undefined
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'text/markdown': '.md',
  'text/x-markdown': '.md',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/tab-separated-values': '.tsv',
  'text/html': '.html',
  'text/css': '.css',
  'text/xml': '.xml',
  'application/xml': '.xml',
  'application/json': '.json',
  'application/yaml': '.yaml',
  'application/x-yaml': '.yaml',
  'text/yaml': '.yaml',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'text/x-python': '.py',
  'application/toml': '.toml',
}

const SUPPORTED = new Set<string>(SUPPORTED_TEXT_EXTENSIONS)

function lastSegment(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri
  const parts = withoutQuery.split('/').filter((p) => p !== '')
  const last = parts[parts.length - 1] ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** A safe display / file name: no path separators, control characters or markup, bounded. */
export function resourceFileName(resource: Pick<McpResourceInfo, 'name' | 'uri' | 'mimeType'> | null, content: ReadContent): string {
  const raw = cleanDisplayText(resource?.name?.trim() || lastSegment(content.uri) || 'resource')
  let name = raw.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'resource'
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : ''
  if (!SUPPORTED.has(ext)) {
    const mime = (content.mimeType ?? resource?.mimeType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    name += EXTENSION_BY_MIME[mime] ?? '.txt'
  }
  return name
}

/** Turns the contents of resources/read results into attachments, and says why anything was left out. */
export function resourcesToAttachments(items: { resource: McpResourceInfo | null; contents: ReadContent[] }[]): AttachFilesResult {
  const result: AttachFilesResult = { attachments: [], rejected: [] }
  const taken = new Set<string>()
  for (const { resource, contents } of items) {
    if (contents.length === 0) {
      result.rejected.push({ filename: resource?.name ?? 'resource', reason: 'the server returned no content' })
      continue
    }
    for (const content of contents) {
      const filename = uniqueAttachmentName(taken, resourceFileName(resource, content))
      if (content.text === undefined) {
        const mime = content.mimeType ?? resource?.mimeType ?? 'unknown type'
        result.rejected.push({ filename, reason: `binary content (${mime}, ${base64Bytes(content.blob ?? '').toLocaleString('en-US')} bytes) cannot be attached` })
        continue
      }
      const sizeBytes = Buffer.byteLength(content.text, 'utf8')
      const reason = attachmentRejectionReason(filename, sizeBytes)
      if (reason) {
        result.rejected.push({ filename, reason })
        continue
      }
      if (looksBinary(content.text)) {
        result.rejected.push({ filename, reason: 'binary content' })
        continue
      }
      taken.add(filename)
      result.attachments.push({ filename, mimeType: attachmentMimeType(filename), sizeBytes, content: content.text })
    }
  }
  return result
}

/** The two manager calls this needs (so it can be tested without a real server). */
export interface ResourceSource {
  resources(serverId: string): Promise<McpResourceInfo[]>
  readResource(serverId: string, uri: string): Promise<{ contents: ReadContent[] }>
}

/**
 * Reads the chosen resources from a server and converts them. Only URIs the server itself listed can be read (the
 * renderer cannot make the app ask a server for an arbitrary URI), and one failing resource is reported, not fatal.
 */
export async function readResourceAttachments(
  source: ResourceSource,
  serverId: string,
  uris: readonly string[],
  redact: (text: string) => string,
): Promise<AttachFilesResult> {
  const listed = await source.resources(serverId)
  const byUri = new Map(listed.map((r) => [r.uri, r]))
  const items: { resource: McpResourceInfo | null; contents: ReadContent[] }[] = []
  const failed: AttachFilesResult['rejected'] = []
  for (const uri of new Set(uris)) {
    const resource = byUri.get(uri)
    if (!resource) {
      failed.push({ filename: cleanDisplayText(uri).slice(0, 120), reason: 'the server does not list this resource' })
      continue
    }
    try {
      items.push({ resource, contents: (await source.readResource(serverId, uri)).contents })
    } catch (err) {
      failed.push({ filename: cleanDisplayText(resource.name).slice(0, 120), reason: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) })
    }
  }
  const converted = resourcesToAttachments(items)
  return { attachments: converted.attachments, rejected: [...failed, ...converted.rejected] }
}
