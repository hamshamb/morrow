import { BrowserWindow, app, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC_CHANNELS, McpReadResourcesInputSchema, McpSetEnabledInputSchema, McpSetToolEnabledInputSchema, type McpEvent } from '@ai-workspace/shared'
import { McpNameTakenError, McpServerRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { decryptSecret, encryptSecret } from '../credential-store'
import { redactSecrets } from '../agent/redactor'
import { McpConfigError, McpConfigService } from '../mcp/config-service'
import { McpManager } from '../mcp/manager'
import { readResourceAttachments } from '../mcp/resource-attachments'

let manager: McpManager | null = null
let configService: McpConfigService | null = null

/** Secrets the user configured for a server are removed by exact value as well as by shape. */
function redactMcp(text: string, secrets: readonly string[]): string {
  let out = redactSecrets(text, secrets)
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join('[REDACTED]')
  return out
}

function broadcast(event: McpEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.mcpEvent, event)
  }
}

/** The process-wide MCP connection manager (created on first use). Agent runs and Settings share it. */
export function getMcpManager(): McpManager {
  if (manager) return manager
  configService = new McpConfigService(new McpServerRepository(getDatabase()), { encrypt: encryptSecret, decrypt: decryptSecret })
  manager = new McpManager({ config: configService, clientVersion: app.getVersion(), redact: redactMcp, emit: broadcast })
  return manager
}

/** App quit: kill every MCP stdio server's process tree before the app exits. */
export function killAllMcpServers(): void {
  manager?.killAllSync()
}

/** An error whose message is meant for the person using the form; Electron prefixes IPC errors, the renderer strips that. */
function friendly(err: unknown): Error {
  if (err instanceof McpConfigError || err instanceof McpNameTakenError) return new Error(err.message)
  return err instanceof Error ? err : new Error(String(err))
}

const idSchema = z.string().min(1).max(100)

/**
 * MCP IPC (Phase 7, ADR-047 ... ADR-051). Every input is validated with zod in the main process. The renderer can
 * configure servers and ask them to be tested; it can never read a secret value or make the app contact anything that
 * was not saved here first.
 */
export function registerMcpIpc(): void {
  const mcp = getMcpManager()
  const config = configService as McpConfigService

  ipcMain.handle(IPC_CHANNELS.mcpList, () => mcp.states())

  ipcMain.handle(IPC_CHANNELS.mcpSave, async (_e, raw: unknown) => {
    try {
      const saved = config.save(raw)
      // The definition changed: the next use connects with the new one.
      await mcp.invalidate(saved.id)
      const state = mcp.state(saved.id)
      broadcast({ type: 'status', diagnostics: state.diagnostics })
      return state
    } catch (err) {
      throw friendly(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.mcpDelete, async (_e, raw: unknown) => {
    const id = idSchema.parse(raw)
    await mcp.invalidate(id)
    config.delete(id)
    broadcast({ type: 'removed', serverId: id })
  })

  ipcMain.handle(IPC_CHANNELS.mcpSetEnabled, async (_e, raw: unknown) => {
    const input = McpSetEnabledInputSchema.parse(raw)
    config.setEnabled(input.id, input.enabled)
    if (!input.enabled) await mcp.invalidate(input.id)
    const state = mcp.state(input.id)
    broadcast({ type: 'status', diagnostics: state.diagnostics })
    return state
  })

  ipcMain.handle(IPC_CHANNELS.mcpTest, (_e, raw: unknown) => mcp.test(idSchema.parse(raw)))

  ipcMain.handle(IPC_CHANNELS.mcpTools, async (_e, raw: unknown) => {
    try {
      return await mcp.tools(idSchema.parse(raw))
    } catch (err) {
      throw friendly(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.mcpSetToolEnabled, async (_e, raw: unknown) => {
    const input = McpSetToolEnabledInputSchema.parse(raw)
    try {
      return await mcp.setToolEnabled(input.id, input.tool, input.enabled)
    } catch (err) {
      throw friendly(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.mcpResources, async (_e, raw: unknown) => {
    try {
      return await mcp.resources(idSchema.parse(raw))
    } catch (err) {
      throw friendly(err)
    }
  })

  ipcMain.handle(IPC_CHANNELS.mcpReadResources, async (_e, raw: unknown) => {
    const input = McpReadResourcesInputSchema.parse(raw)
    try {
      return await readResourceAttachments(mcp, input.id, input.uris, (text) => redactMcp(text, []))
    } catch (err) {
      throw friendly(err)
    }
  })
}
