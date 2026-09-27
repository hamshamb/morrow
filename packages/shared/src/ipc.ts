import type { AppSettings, AppSettingsPartial } from './settings'
import type { CreateWorkspaceInput, UpdateWorkspaceInput, Workspace } from './workspace'

/**
 * Single source of truth for the renderer<->main IPC surface. The preload
 * script implements exactly this shape via contextBridge; the renderer only
 * ever sees `window.api` typed as `RendererApi`. No ad hoc `ipcRenderer.invoke`
 * calls are allowed outside preload.
 */
export interface RendererApi {
  workspaces: {
    list(): Promise<Workspace[]>
    get(id: string): Promise<Workspace | null>
    create(input: CreateWorkspaceInput): Promise<Workspace>
    update(input: UpdateWorkspaceInput): Promise<Workspace>
    delete(id: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(partial: AppSettingsPartial): Promise<AppSettings>
  }
  app: {
    getVersion(): Promise<string>
  }
}

export const IPC_CHANNELS = {
  workspacesList: 'workspace:list',
  workspacesGet: 'workspace:get',
  workspacesCreate: 'workspace:create',
  workspacesUpdate: 'workspace:update',
  workspacesDelete: 'workspace:delete',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appGetVersion: 'app:get-version',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]
