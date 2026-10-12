import { ipcMain } from 'electron'
import {
  AddProviderConfigInputSchema,
  IPC_CHANNELS,
  TestProviderConfigInputSchema,
} from '@ai-workspace/shared'
import { ProviderConfigRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { encryptSecret, maskApiKey } from '../credential-store'
import { getProviderCatalogService } from '../services'

export function registerProviderConfigIpc(): void {
  const repo = new ProviderConfigRepository(getDatabase())
  const service = getProviderCatalogService()

  ipcMain.handle(IPC_CHANNELS.providerConfigsList, () => repo.list())

  ipcMain.handle(IPC_CHANNELS.providerConfigsAdd, (_event, input: unknown) => {
    const parsed = AddProviderConfigInputSchema.parse(input)
    const runtime = service.runtime(parsed.provider)
    const apiKey = parsed.apiKey.trim()
    if (runtime.keyRequired && apiKey.length === 0) {
      throw new Error('An API key is required for this provider.')
    }
    if (parsed.provider === 'custom' && !parsed.baseUrl) {
      throw new Error('A base URL is required for a custom endpoint.')
    }
    const created = repo.create({
      provider: parsed.provider,
      label: parsed.label,
      // Keyless providers (Ollama, LM Studio, some custom endpoints) store an
      // empty blob rather than an "encrypted empty string".
      maskedKey: apiKey ? maskApiKey(apiKey) : 'no key',
      encryptedKey: apiKey ? encryptSecret(apiKey) : Buffer.alloc(0),
      baseUrl: parsed.baseUrl ?? null,
    })
    // Best-effort: warm the model catalog cache right away so the picker
    // shows what this key can access as soon as possible, without making the
    // caller wait on a second round trip. A failure never surfaces from
    // providerConfigsAdd — the picker already has models.dev's list, and the
    // user can hit "Refresh models".
    void service.refreshCatalog(created.id).catch(() => {})
    return created
  })

  ipcMain.handle(IPC_CHANNELS.providerConfigsRemove, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('provider config id must be a string')
    repo.delete(id)
  })

  ipcMain.handle(IPC_CHANNELS.providerConfigsTest, (_event, input: unknown) => {
    const parsed = TestProviderConfigInputSchema.parse(input)
    return service.testConnection({
      provider: parsed.provider,
      apiKey: parsed.apiKey.trim(),
      baseUrl: parsed.baseUrl ?? null,
    })
  })
}
