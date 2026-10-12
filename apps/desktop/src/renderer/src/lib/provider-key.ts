import type { ProviderId } from '@ai-workspace/shared'

/**
 * Guesses which provider an API key belongs to from its well-known prefix,
 * so key entry can be a single "Paste API key" field. Returns null when the
 * prefix is unknown or ambiguous — the UI then asks the user to pick.
 *
 * Order matters: `sk-ant-` must be checked before the generic OpenAI `sk-`.
 * Only a convenience for the form — the key is still validated by a real
 * test call to the detected provider before it is saved.
 */
export function detectProviderFromKey(rawKey: string): ProviderId | null {
  const key = rawKey.trim()
  if (key.length < 8) return null
  if (key.startsWith('sk-ant-')) return 'anthropic'
  if (key.startsWith('AIza')) return 'google'
  if (key.startsWith('sk-proj-') || key.startsWith('sk-')) return 'openai'
  return null
}

/** Long enough to be worth an automatic connection test (avoids firing a
 * network call on every keystroke of a half-typed key). */
export function looksLikeCompleteKey(rawKey: string): boolean {
  return rawKey.trim().length >= 20 && !/\s/.test(rawKey.trim())
}
