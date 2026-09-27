import { ipcMain } from 'electron'
import {
  AddProviderConfigInputSchema,
  IPC_CHANNELS,
  TestProviderConfigInputSchema,
  type ProviderId,
  type TestProviderConfigResult,
} from '@ai-workspace/shared'
import { ModelCatalogRepository, ProviderConfigRepository } from '@ai-workspace/storage'
import { createProvider } from '@ai-workspace/providers'
import { getDatabase } from '../db'
import { decryptSecret, encryptSecret, maskApiKey } from '../credential-store'
import { refreshModelCatalog } from './model-catalog'

/** A minimal, cheap request used purely to verify a key/base URL actually work. */
async function testConnection(
  provider: Parameters<typeof createProvider>[0],
  apiKey: string,
  baseUrl: string | null | undefined,
): Promise<TestProviderConfigResult> {
  const chatProvider = createProvider(provider, { apiKey, baseUrl: baseUrl ?? null })
  const model = {
    anthropic: 'claude-haiku-4-5-20251001',
    openai: 'gpt-4o-mini',
    google: 'gemini-2.0-flash',
  }[provider]
  try {
    for await (const event of chatProvider.streamChat({
      model,
      messages: [{ role: 'user', content: 'ping' }],
    })) {
      if (event.type === 'error') {
        return { ok: false, message: event.error }
      }
      if (event.type === 'text-delta' || event.type === 'done') {
        return { ok: true }
      }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

export function registerProviderConfigIpc(): void {
  const repo = new ProviderConfigRepository(getDatabase())
  const catalogRepo = new ModelCatalogRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.providerConfigsList, () => repo.list())

  ipcMain.handle(IPC_CHANNELS.providerConfigsAdd, (_event, input: unknown) => {
    const parsed = AddProviderConfigInputSchema.parse(input)
    const encryptedKey = encryptSecret(parsed.apiKey)
    const created = repo.create({
      provider: parsed.provider,
      label: parsed.label,
      maskedKey: maskApiKey(parsed.apiKey),
      encryptedKey,
      baseUrl: parsed.baseUrl ?? null,
    })
    // Best-effort: warm the model catalog cache right away so the picker
    // has real data as soon as possible, without making the caller wait on
    // a second network round trip. Never lets a fetch failure surface as
    // an error from providerConfigsAdd — the user can always hit "Refresh
    // models" manually (see ipc/model-catalog.ts).
    void refreshModelCatalog(repo, catalogRepo, created.id).catch(() => {})
    return created
  })

  ipcMain.handle(IPC_CHANNELS.providerConfigsRemove, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('provider config id must be a string')
    repo.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.providerConfigsTest, async (_event, input: unknown) => {
    const parsed = TestProviderConfigInputSchema.parse(input)
    return testConnection(parsed.provider, parsed.apiKey, parsed.baseUrl)
  })
}

export interface DecryptedCredential {
  provider: ProviderId
  apiKey: string
  baseUrl: string | null
}

/** Exposed for the chat IPC handler — decrypts a stored credential in-memory, on demand. */
export function loadDecryptedCredential(
  repo: ProviderConfigRepository,
  providerConfigId: string,
): DecryptedCredential {
  const credential = repo.getCredential(providerConfigId)
  if (!credential) {
    throw new Error(`Provider config not found: ${providerConfigId}`)
  }
  return {
    provider: credential.provider,
    apiKey: decryptSecret(credential.encryptedKey),
    baseUrl: credential.baseUrl,
  }
}
