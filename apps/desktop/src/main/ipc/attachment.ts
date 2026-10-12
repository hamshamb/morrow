import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, MAX_ATTACHMENTS_PER_MESSAGE, SUPPORTED_TEXT_EXTENSIONS } from '@ai-workspace/shared'
import { readAttachmentFiles } from '../attachment-reader'

/** Electron's `dialog.showOpenDialog` filter extensions must be given
 * without the leading dot. */
const DIALOG_EXTENSIONS = SUPPORTED_TEXT_EXTENSIONS.map((ext) => ext.replace(/^\./, ''))

export function registerAttachmentIpc(): void {
  ipcMain.handle(IPC_CHANNELS.attachmentsPickFiles, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported text files', extensions: DIALOG_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    // Read at most one message's worth; the renderer reports the rest as over the limit.
    const picked = readAttachmentFiles(result.filePaths.slice(0, MAX_ATTACHMENTS_PER_MESSAGE))
    for (const filePath of result.filePaths.slice(MAX_ATTACHMENTS_PER_MESSAGE)) {
      picked.rejected.push({
        filename: filePath.split(/[\\/]/).pop() ?? filePath,
        reason: `limit of ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
      })
    }
    return picked
  })
}
