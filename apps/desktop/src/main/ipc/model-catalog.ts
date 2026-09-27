import { ipcMain } from 'electron'
import { IPC_CHANNELS, type RefreshModelCatalogResult } from '@ai-workspace/shared'
import { ModelCatalogRepository, ProviderConfigRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { decryptSecret } from '../credential-store'
import { fetchProviderModels } from '../model-catalog-fetcher'

/**
 * Fetches and caches the live model catalog for one provider config.
 * Exported (not just registered as an IPC handler) so `provider-config.ts`
 * can trigger the same best-effort refresh right after a config is added,
 * without duplicating the fetch/cache logic.
 */
export async function refreshModelCatalog(
  configs: ProviderConfigRepository,
  catalog: ModelCatalogRepository,
  providerConfigId: string,
): Promise<RefreshModelCatalogResult> {
  const credential = configs.getCredential(providerConfigId)
  if (!credential) {
    throw new Error(`Provider config not found: ${providerConfigId}`)
  }

  if (credential.provider === 'google') {
    // Not implemented in V1 — see model-catalog-fetcher.ts and
    // DECISIONS.md "Known limitations". Never throws here so the IPC call
    // resolves cleanly with the existing (static-fallback-backed-in-the-UI)
    // cache rather than rejecting.
    return {
      ok: false,
      message: 'Live model refresh is not available for Google yet.',
      catalog: catalog.listForProviderConfig(providerConfigId),
    }
  }

  const apiKey = decryptSecret(credential.encryptedKey)
  const result = await fetchProviderModels(credential.provider, apiKey, credential.baseUrl)

  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      catalog: catalog.listForProviderConfig(providerConfigId),
    }
  }

  const saved = catalog.replaceForProviderConfig(providerConfigId, result.models, Date.now())
  return { ok: true, catalog: saved }
}

export function registerModelCatalogIpc(): void {
  const configs = new ProviderConfigRepository(getDatabase())
  const catalog = new ModelCatalogRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.modelCatalogList, (_event, providerConfigId: unknown) => {
    if (typeof providerConfigId !== 'string') throw new Error('providerConfigId must be a string')
    return catalog.listForProviderConfig(providerConfigId)
  })

  ipcMain.handle(IPC_CHANNELS.modelCatalogRefresh, (_event, providerConfigId: unknown) => {
    if (typeof providerConfigId !== 'string') throw new Error('providerConfigId must be a string')
    return refreshModelCatalog(configs, catalog, providerConfigId)
  })
}
