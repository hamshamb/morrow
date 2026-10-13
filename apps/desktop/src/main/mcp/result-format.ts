/**
 * Turns an MCP `tools/call` result into the one string a model gets back. The result is DATA from an untrusted server:
 * nothing is added that could read as an instruction, images and audio are not forwarded (only a placeholder says they
 * existed), and the caller caps and redacts the text.
 */

export interface FormattedToolResult {
  text: string
  isError: boolean
}

type Block = Record<string, unknown>

const isRecord = (value: unknown): value is Block => typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Decoded size of a base64 payload, without decoding it. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s/g, '')
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function formatBlock(block: unknown): { text: string; isText: boolean } {
  if (!isRecord(block)) return { text: '[unsupported content block]', isText: false }
  switch (block['type']) {
    case 'text':
      return { text: str(block['text']) ?? '', isText: true }
    case 'image':
    case 'audio': {
      const kind = block['type']
      return { text: `[${kind} omitted: ${str(block['mimeType']) ?? 'unknown type'}, ${base64Bytes(str(block['data']) ?? '')} bytes]`, isText: false }
    }
    case 'resource': {
      const resource = isRecord(block['resource']) ? block['resource'] : {}
      const text = str(resource['text'])
      if (text !== null) return { text, isText: true }
      const uri = str(resource['uri']) ?? 'unknown uri'
      return { text: `[binary resource omitted: ${uri}, ${str(resource['mimeType']) ?? 'unknown type'}, ${base64Bytes(str(resource['blob']) ?? '')} bytes]`, isText: false }
    }
    case 'resource_link':
      return { text: str(block['uri']) ?? '[resource link without a uri]', isText: false }
    default:
      return { text: `[unsupported content block: ${typeof block['type'] === 'string' ? block['type'].slice(0, 40) : 'unknown'}]`, isText: false }
  }
}

export function formatCallToolResult(result: unknown): FormattedToolResult {
  const r = isRecord(result) ? result : {}
  const isError = r['isError'] === true
  const content = Array.isArray(r['content']) ? (r['content'] as unknown[]) : null
  const parts: string[] = []
  let hasText = false
  for (const block of content ?? []) {
    const formatted = formatBlock(block)
    if (formatted.isText) hasText = true
    if (formatted.text !== '') parts.push(formatted.text)
  }
  // Structured results (and old servers' `toolResult`) matter only when the server said nothing in prose.
  if (!hasText) {
    const structured = r['structuredContent'] ?? (content === null ? r['toolResult'] : undefined)
    if (structured !== undefined) parts.push(JSON.stringify(structured, null, 2))
  }
  const text = parts.join('\n')
  if (text.trim() === '') {
    return { text: isError ? 'The tool reported an error without a message.' : '(the tool returned no content)', isError }
  }
  return { text, isError }
}

/** Keeps the head of `text` within `cap` characters and says how much was cut. */
export function capToolText(text: string, cap: number): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false }
  const omitted = text.length - cap
  return { text: `${text.slice(0, cap)}\n[output truncated: ${omitted.toLocaleString('en-US')} more characters]`, truncated: true }
}
