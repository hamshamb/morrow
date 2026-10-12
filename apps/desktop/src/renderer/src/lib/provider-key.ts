import {
  detectProviderByKeyPrefix,
  type ProviderId,
  type ProviderRegistryEntry,
} from '@ai-workspace/shared'

/**
 * Guesses which provider an API key belongs to from its prefix, so key entry
 * can be a single "Paste API key" field. The prefixes come from the provider
 * registry (`ProviderRegistryEntry.keyPrefix`), so new providers are covered
 * without touching the renderer. Returns null when the prefix is unknown or
 * ambiguous (a bare `sk-` is shared by OpenAI and DeepSeek) — the UI then
 * asks the user to pick from the list.
 *
 * Only a convenience for the form: the key is still validated by a real test
 * call to the detected provider before it is saved.
 */
export function detectProviderFromKey(
  rawKey: string,
  registry: readonly Pick<ProviderRegistryEntry, 'id' | 'keyPrefix'>[],
): ProviderId | null {
  const key = rawKey.trim()
  if (key.length < 8) return null
  return detectProviderByKeyPrefix(key, registry)
}

/** Long enough to be worth an automatic connection test (avoids firing a
 * network call on every keystroke of a half-typed key). */
export function looksLikeCompleteKey(rawKey: string): boolean {
  return rawKey.trim().length >= 20 && !/\s/.test(rawKey.trim())
}
