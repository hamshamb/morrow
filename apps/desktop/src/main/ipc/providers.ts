import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@ai-workspace/shared'
import { getModelsDevService, getProviderCatalogService } from '../services'

/** Provider registry + models.dev metadata IPC. */
export function registerProvidersIpc(): void {
  const providers = getProviderCatalogService()
  const models = getModelsDevService()

  ipcMain.handle(IPC_CHANNELS.providersRegistry, () => providers.registry())
  ipcMain.handle(IPC_CHANNELS.providersDetectLocal, () => providers.detectLocal())
  ipcMain.handle(IPC_CHANNELS.modelsMetadataStatus, () => models.status())
  ipcMain.handle(IPC_CHANNELS.modelsMetadataRefresh, () => models.refresh())
}

/** Kicks the once-a-day background refresh; resolves quietly on any failure. */
export function startModelsMetadataRefresh(): void {
  void getModelsDevService()
    .refreshIfStale()
    .catch(() => {})
}
