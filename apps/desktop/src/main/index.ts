import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { registerWorkspaceIpc } from './ipc/workspace'
import { registerSettingsIpc } from './ipc/settings'
import { registerAppIpc } from './ipc/app'
import { registerConversationIpc } from './ipc/conversation'
import { registerProviderConfigIpc } from './ipc/provider-config'
import { registerModelCatalogIpc } from './ipc/model-catalog'
import { registerProvidersIpc, startModelsMetadataRefresh } from './ipc/providers'
import { registerChatIpc } from './ipc/chat'
import { registerWorkspaceFileIpc } from './ipc/workspace-file'
import { registerAttachmentIpc } from './ipc/attachment'
import { killAllTerminals, registerCodeIpc } from './ipc/code'

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function createMainWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.aiworkspace.desktop')

  app.on('browser-window-created', (_event, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerAppIpc()
  registerWorkspaceIpc()
  registerSettingsIpc()
  registerConversationIpc()
  registerProvidersIpc()
  registerProviderConfigIpc()
  registerModelCatalogIpc()
  registerChatIpc()
  registerWorkspaceFileIpc()
  registerAttachmentIpc()
  registerCodeIpc()

  createMainWindow()
  // After the window exists, so a slow download never delays first paint. No-op
  // when the catalog is fresh (< 24h) or the user turned the fetch off.
  startModelsMetadataRefresh()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
})

// No shell may outlive the app: kill every PTY on the way out (ADR-037).
app.on('before-quit', killAllTerminals)
app.on('will-quit', killAllTerminals)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
