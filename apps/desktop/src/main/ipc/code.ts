import { BrowserWindow, ipcMain, shell } from 'electron'
import {
  CreateTerminalInputSchema,
  FsListDirInputSchema,
  FsReadInputSchema,
  FsSearchTextInputSchema,
  FsWriteInputSchema,
  GitCommitInputSchema,
  GitDiffInputSchema,
  GitPathsInputSchema,
  IPC_CHANNELS,
  RelativePathSchema,
  TerminalIdSchema,
  TerminalInputDataSchema,
  TerminalResizeInputSchema,
  WorkspaceIdSchema,
  type TerminalEvent,
} from '@ai-workspace/shared'
import { WorkspaceFileRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { CodeFileService } from '../code/file-service'
import { GitService } from '../code/git-service'
import { loadNativeSpawn } from '../code/pty-native'
import { buildTerminalEnv, detectShell } from '../code/shell-detect'
import { TerminalManager } from '../code/terminal-manager'

let terminals: TerminalManager | null = null

/** Kills every terminal; called on app quit so no shell outlives the app (ADR-037). */
export function killAllTerminals(): void {
  terminals?.killAll()
}

/**
 * Code workspace IPC (Phase 4). Every handler validates its input with zod
 * and passes only a workspace id + RELATIVE path to the services, which do the
 * path-safety checks (ADR-035). There is no handler that runs an arbitrary
 * command, and no handler an AI feature could use to type into a terminal.
 */
export function registerCodeIpc(): void {
  const roots = new WorkspaceFileRepository(getDatabase())
  const resolveRoot = (workspaceId: string): string | null => roots.getRoot(workspaceId)?.rootPath ?? null

  const files = new CodeFileService({ resolveRoot })
  const git = new GitService({ resolveRoot, files })
  terminals = new TerminalManager({
    loadSpawn: loadNativeSpawn,
    detectShell: () => detectShell({ platform: process.platform, env: process.env }),
    buildEnv: () => buildTerminalEnv(process.env),
    resolveRoot,
    emit: (event: TerminalEvent) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.terminalEvent, event)
      }
    },
  })
  const manager = terminals

  // --- files
  ipcMain.handle(IPC_CHANNELS.fsListDir, (_e, raw: unknown) => {
    const input = FsListDirInputSchema.parse(raw)
    return files.listDir(input.workspaceId, input.relativePath)
  })
  ipcMain.handle(IPC_CHANNELS.fsReadFile, (_e, raw: unknown) => {
    const input = FsReadInputSchema.parse(raw)
    return files.readFile(input.workspaceId, input.relativePath)
  })
  ipcMain.handle(IPC_CHANNELS.fsWriteFile, (_e, raw: unknown) => {
    const input = FsWriteInputSchema.parse(raw)
    return files.writeFile(input.workspaceId, input.relativePath, input.content, input.expectedHash, input.overwrite ?? false)
  })
  ipcMain.handle(IPC_CHANNELS.fsListPaths, (_e, raw: unknown) => files.listPaths(WorkspaceIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.fsSearchText, (_e, raw: unknown) => {
    const input = FsSearchTextInputSchema.parse(raw)
    return files.searchText(input.workspaceId, input.query, input.caseSensitive ?? false, input.limit)
  })
  ipcMain.handle(IPC_CHANNELS.fsReveal, async (_e, workspaceId: unknown, relativePath: unknown) => {
    const abs = await files.resolveForReveal(WorkspaceIdSchema.parse(workspaceId), RelativePathSchema.parse(relativePath))
    // Reveal only: showItemInFolder selects the item in the file manager and never opens or executes it.
    shell.showItemInFolder(abs)
  })

  // --- git
  ipcMain.handle(IPC_CHANNELS.gitStatus, (_e, raw: unknown) => git.status(WorkspaceIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.gitDiff, (_e, raw: unknown) => {
    const input = GitDiffInputSchema.parse(raw)
    return git.diff(input.workspaceId, input.path, input.area, input.origPath)
  })
  ipcMain.handle(IPC_CHANNELS.gitStage, (_e, raw: unknown) => {
    const input = GitPathsInputSchema.parse(raw)
    return git.stage(input.workspaceId, input.paths)
  })
  ipcMain.handle(IPC_CHANNELS.gitUnstage, (_e, raw: unknown) => {
    const input = GitPathsInputSchema.parse(raw)
    return git.unstage(input.workspaceId, input.paths)
  })
  ipcMain.handle(IPC_CHANNELS.gitStageAll, (_e, raw: unknown) => git.stageAll(WorkspaceIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.gitUnstageAll, (_e, raw: unknown) => git.unstageAll(WorkspaceIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.gitCommit, (_e, raw: unknown) => {
    const input = GitCommitInputSchema.parse(raw)
    return git.commit(input.workspaceId, input.message)
  })

  // --- terminal (a shell starts only when the user asks for one)
  ipcMain.handle(IPC_CHANNELS.terminalCreate, (_e, raw: unknown) => manager.create(CreateTerminalInputSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.terminalList, (_e, raw: unknown) => manager.list(WorkspaceIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.terminalGetBuffer, (_e, raw: unknown) => manager.getBuffer(TerminalIdSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.terminalWrite, (_e, id: unknown, data: unknown) => {
    manager.write(TerminalIdSchema.parse(id), TerminalInputDataSchema.parse(data))
  })
  ipcMain.handle(IPC_CHANNELS.terminalResize, (_e, raw: unknown) => {
    const input = TerminalResizeInputSchema.parse(raw)
    manager.resize(input.id, input.cols, input.rows)
  })
  ipcMain.handle(IPC_CHANNELS.terminalKill, (_e, raw: unknown) => manager.kill(TerminalIdSchema.parse(raw)))
}
