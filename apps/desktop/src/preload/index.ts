import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS, type RendererApi } from '@ai-workspace/shared'

const api: RendererApi = {
  workspaces: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.workspacesList),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesGet, id),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesCreate, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesUpdate, input),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesDelete, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (partial) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, partial),
  },
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion),
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Should never happen — contextIsolation is forced on in main/index.ts.
  // @ts-expect-error fallback path only, not part of the typed contract
  window.api = api
}
