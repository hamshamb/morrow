import { ipcMain } from 'electron'
import { AppSettingsPartialSchema, IPC_CHANNELS } from '@ai-workspace/shared'
import { SettingsRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'

export function registerSettingsIpc(): void {
  const repo = new SettingsRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.settingsGet, () => repo.get())

  ipcMain.handle(IPC_CHANNELS.settingsSet, (_event, partial: unknown) => {
    return repo.set(AppSettingsPartialSchema.parse(partial))
  })
}
