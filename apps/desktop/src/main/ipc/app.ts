import { app, ipcMain } from 'electron'
import { IPC_CHANNELS } from '@ai-workspace/shared'

export function registerAppIpc(): void {
  ipcMain.handle(IPC_CHANNELS.appGetVersion, () => app.getVersion())
}
