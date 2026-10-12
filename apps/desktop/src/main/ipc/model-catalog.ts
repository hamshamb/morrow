import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@ai-workspace/shared'
import { getProviderCatalogService } from '../services'

export function registerModelCatalogIpc(): void {
  const service = getProviderCatalogService()

  ipcMain.handle(IPC_CHANNELS.modelCatalogList, (_event, providerConfigId: unknown) => {
    if (typeof providerConfigId !== 'string') throw new Error('providerConfigId must be a string')
    return service.listCatalog(providerConfigId)
  })

  ipcMain.handle(IPC_CHANNELS.modelCatalogRefresh, (_event, providerConfigId: unknown) => {
    if (typeof providerConfigId !== 'string') throw new Error('providerConfigId must be a string')
    return service.refreshCatalog(providerConfigId)
  })
}
