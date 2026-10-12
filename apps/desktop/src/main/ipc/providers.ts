import { BrowserWindow, ipcMain } from 'electron'
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

  // Push to every window when a download replaced the catalog.
  models.onChange(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.modelsMetadataChanged)
    }
  })
}

/** Kicks the once-a-day background refresh; resolves quietly on any failure. */
export function startModelsMetadataRefresh(): void {
  void getModelsDevService()
    .refreshIfStale()
    .catch(() => {})
}
