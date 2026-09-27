import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, SUPPORTED_TEXT_EXTENSIONS } from '@ai-workspace/shared'
import { readAttachmentFile } from '../attachment-reader'

/** Electron's `dialog.showOpenDialog` filter extensions must be given
 * without the leading dot. */
const DIALOG_EXTENSIONS = SUPPORTED_TEXT_EXTENSIONS.map((ext) => ext.replace(/^\./, ''))

export function registerAttachmentIpc(): void {
  ipcMain.handle(IPC_CHANNELS.attachmentsPickFile, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        { name: 'Supported text files', extensions: DIALOG_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    if (!filePath) return null
    return readAttachmentFile(filePath)
  })
}
