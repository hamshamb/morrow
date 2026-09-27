import { safeStorage } from 'electron'

/**
 * Thin wrapper around Electron's `safeStorage` (OS keychain/DPAPI/libsecret
 * backed) — see ADR-004. This is the only place in the app allowed to see a
 * plaintext provider API key outside of the moment it is typed by the user
 * or sent to the provider's network endpoint.
 */
export function encryptSecret(plainText: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS-level credential encryption is not available on this system; refusing to store an API key.',
    )
  }
  return safeStorage.encryptString(plainText)
}

export function decryptSecret(encrypted: Buffer): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is not available on this system.')
  }
  return safeStorage.decryptString(encrypted)
}

/** Non-sensitive display preview, e.g. "sk-...ab12". Never logged, never the full key. */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim()
  if (trimmed.length <= 8) return '****'
  const prefix = trimmed.slice(0, Math.min(6, trimmed.length - 4))
  const suffix = trimmed.slice(-4)
  return `${prefix}...${suffix}`
}
