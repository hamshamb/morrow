import { ipcMain } from 'electron'
import {
  CreateWorkspaceInputSchema,
  IPC_CHANNELS,
  UpdateWorkspaceInputSchema,
} from '@ai-workspace/shared'
import { WorkspaceRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'

export function registerWorkspaceIpc(): void {
  const repo = new WorkspaceRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.workspacesList, () => repo.list())

  ipcMain.handle(IPC_CHANNELS.workspacesGet, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('workspace id must be a string')
    return repo.get(id)
  })

  ipcMain.handle(IPC_CHANNELS.workspacesCreate, (_event, input: unknown) => {
    return repo.create(CreateWorkspaceInputSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.workspacesUpdate, (_event, input: unknown) => {
    return repo.update(UpdateWorkspaceInputSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.workspacesDelete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('workspace id must be a string')
    repo.delete(id)
  })
}
