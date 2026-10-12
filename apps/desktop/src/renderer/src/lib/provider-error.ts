import { isRateLimitOrQuotaError } from '@ai-workspace/shared'

/**
 * Turns a raw provider/network error string (often an HTTP status plus a
 * JSON body from the SDK) into one plain-language sentence for the inline
 * error line under a failed message. Never shows raw JSON or a stack.
 */
export function describeProviderError(
  raw: string | null | undefined,
  /** 'chat' = under a failed message (can point to Settings);
   * 'key' = while entering a key (the user is already fixing it). */
  context: 'chat' | 'key' = 'chat',
): string {
  const text = (raw ?? '').trim()
  const lower = text.toLowerCase()

  if (!text) return context === 'key' ? 'The connection test failed.' : 'The response failed before any text arrived.'
  if (/\b401\b|invalid[ _-]?(x-)?api[ _-]?key|authentication_error|incorrect api key|unauthorized/.test(lower)) {
    return context === 'key'
      ? 'The provider rejected this key. Check that you copied all of it.'
      : 'The provider rejected the API key. Check or replace it in Settings.'
  }
  if (/\b403\b|permission_error|forbidden|not scoped/.test(lower)) {
    return "This API key doesn't have access to that model or workspace."
  }
  if (/\b404\b|not_found_error|model_not_found|does not exist|unknown model/.test(lower)) {
    return "This model isn't available for your key. Try switching models."
  }
  if (isRateLimitOrQuotaError(lower)) {
    return 'Rate limited or out of quota. Wait a moment, or switch models.'
  }
  if (/\b529\b|overloaded/.test(lower)) {
    return 'The provider is overloaded right now. Retry in a moment.'
  }
  if (/\b5\d\d\b|internal server error|server_error|bad gateway|service unavailable/.test(lower)) {
    return 'The provider had a server error. Retry in a moment.'
  }
  if (/abort|cancel/.test(lower)) return 'The response was stopped.'
  if (/enotfound|econnrefused|econnreset|etimedout|fetch failed|network|timed? ?out|offline/.test(lower)) {
    return "Couldn't reach the provider. Check your connection and retry."
  }
  if (/context|too long|maximum.*tokens|token limit/.test(lower)) {
    return 'The conversation is too long for this model. Try a model with a larger context.'
  }

  // Unknown: keep a short, JSON-free first line.
  const firstLine = text.split('\n')[0] ?? text
  const withoutJson = firstLine.replace(/\{[\s\S]*\}/g, '').replace(/\s+/g, ' ').trim()
  const summary = withoutJson || 'Unexpected error from the provider.'
  return summary.length > 140 ? `${summary.slice(0, 139)}…` : summary
}
