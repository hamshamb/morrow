import { dialog, ipcMain } from 'electron'
import { IPC_CHANNELS, type IndexWorkspaceFilesResult } from '@ai-workspace/shared'
import { WorkspaceFileRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { walkWorkspaceFiles } from '../workspace-file-indexer'

function reindex(repo: WorkspaceFileRepository, workspaceId: string, rootPath: string): IndexWorkspaceFilesResult {
  const files = walkWorkspaceFiles(rootPath)
  const { fileCount, indexedCount } = repo.replaceIndex(workspaceId, files)
  const root = repo.getRoot(workspaceId)
  if (!root) throw new Error(`Workspace file root not found after indexing: ${workspaceId}`)
  return { root, fileCount, indexedCount }
}

export function registerWorkspaceFileIpc(): void {
  const repo = new WorkspaceFileRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.workspaceFilesGetRoot, (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    return repo.getRoot(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.workspaceFilesPickRoot, async (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const rootPath = result.filePaths[0]
    if (!rootPath) return null
    repo.setRoot(workspaceId, rootPath)
    return reindex(repo, workspaceId, rootPath)
  })

  ipcMain.handle(IPC_CHANNELS.workspaceFilesReindex, (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    const root = repo.getRoot(workspaceId)
    if (!root) throw new Error(`No file root set for workspace: ${workspaceId}`)
    return reindex(repo, workspaceId, root.rootPath)
  })

  ipcMain.handle(IPC_CHANNELS.workspaceFilesList, (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    return repo.listFiles(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.workspaceFilesSearch, (_event, workspaceId: unknown, query: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    if (typeof query !== 'string') throw new Error('query must be a string')
    return repo.search(workspaceId, query)
  })
}
