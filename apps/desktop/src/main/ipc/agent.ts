import { BrowserWindow, ipcMain } from 'electron'
import { z } from 'zod'
import {
  BUILTIN_AGENTS,
  IPC_CHANNELS,
  RespondPermissionInputSchema,
  RevertInputSchema,
  RunAgentInputSchema,
  UpdateAgentInputSchema,
  WorkspaceIdSchema,
  type AgentEvent,
} from '@ai-workspace/shared'
import {
  AgentRepository,
  ConversationRepository,
  MessageRepository,
  ProviderConfigRepository,
  SettingsRepository,
  WorkspaceFileRepository,
} from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { decryptSecret } from '../credential-store'
import { getProviderCatalogService } from '../services'
import { ChatService } from '../chat-service'
import { ContextService } from '../context-service'
import { getCodeServices } from '../code/code-services'
import { AgentChangeService } from '../agent/agent-changes'
import { AgentService } from '../agent/agent-service'
import { buildAgentEnv, detectAgentShell } from '../agent/command-runner'
import { PermissionEngine } from '../agent/permission-engine'
import { redactSecrets } from '../agent/redactor'
import type { ToolServices } from '../agent/tools/types'

let agentService: AgentService | null = null
let permissionEngine: PermissionEngine | null = null

/** A deleted conversation takes its in-memory (session) grants with it. */
export function forgetAgentConversation(conversationId: string): void {
  permissionEngine?.forgetConversation(conversationId)
}

/** Stops every run, command and permission prompt - called on app quit so nothing outlives the app. */
export function cancelAllAgentRuns(): void {
  agentService?.cancelAll()
}

function broadcast(event: AgentEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC_CHANNELS.agentEvent, event)
  }
}

/**
 * Agent IPC (Phase 5, ADR-040...045). Every input is validated with zod. The renderer can ask for a run, cancel
 * it, answer a prompt THE MAIN PROCESS asked, and look at / revert results; it cannot run a tool, change a
 * run's tools or limits, or approve anything the permission engine did not itself ask about.
 */
export function registerAgentIpc(): void {
  const db = getDatabase()
  const repo = new AgentRepository(db)
  const conversations = new ConversationRepository(db)
  const messages = new MessageRepository(db)
  const settings = new SettingsRepository(db)
  const providerConfigs = new ProviderConfigRepository(db)
  const workspaceFiles = new WorkspaceFileRepository(db)
  const { files, git, resolveRoot } = getCodeServices()

  // A run that was in progress when the app last closed can never finish.
  repo.failInterruptedRuns()

  const engine = new PermissionEngine({ grants: repo, emit: broadcast })
  permissionEngine = engine

  // Every decrypted provider key, so a redaction pass can remove them from anything leaving the machine.
  const providerSecrets = (): string[] => {
    const secrets: string[] = []
    for (const config of providerConfigs.list()) {
      try {
        const credential = providerConfigs.getCredential(config.id)
        if (credential && credential.encryptedKey.length > 0) secrets.push(decryptSecret(credential.encryptedKey))
      } catch {
        /* an undecryptable key cannot leak */
      }
    }
    return secrets
  }

  const shell = detectAgentShell({ platform: process.platform, env: process.env })
  const services: ToolServices = {
    files,
    git,
    resolveRoot,
    indexSearch: (workspaceId, query, limit) => workspaceFiles.search(workspaceId, query, limit),
    shell,
    // Rebuilt per command so a newly added key is scrubbed too.
    commandEnv: () => buildAgentEnv(process.env, providerSecrets()).env,
    limits: () => settings.get().agentLimits,
  }

  const chat = new ChatService({
    conversations,
    messages,
    contextService: new ContextService({ messages, workspaceFiles }),
    resolveProvider: (providerConfigId) => getProviderCatalogService().resolveChatProvider(providerConfigId),
  })

  const service = new AgentService({
    chat,
    conversations,
    messages,
    repo,
    engine,
    resolveProvider: (providerConfigId) => getProviderCatalogService().resolveChatProvider(providerConfigId),
    services,
    getSettings: () => {
      const current = settings.get()
      return { agentLimits: current.agentLimits, agentOverrides: current.agentOverrides }
    },
    getSecrets: providerSecrets,
    redact: redactSecrets,
    emit: broadcast,
  })
  agentService = service

  const changes = new AgentChangeService({ repo, resolveRoot, isRunActive: (runId) => service.isRunActive(runId) })

  ipcMain.handle(IPC_CHANNELS.agentRun, (_e, raw: unknown) => service.run(RunAgentInputSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.agentCancel, (_e, runId: unknown) => {
    service.cancel(z.string().min(1).max(100).parse(runId))
  })
  ipcMain.handle(IPC_CHANNELS.agentRespondPermission, (_e, raw: unknown) => engine.respond(RespondPermissionInputSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.agentPendingPermissions, () => engine.pendingRequests())
  ipcMain.handle(IPC_CHANNELS.agentListRuns, (_e, conversationId: unknown) => service.listRuns(z.string().min(1).parse(conversationId)))
  ipcMain.handle(IPC_CHANNELS.agentChanges, (_e, runId: unknown) => changes.list(z.string().min(1).parse(runId)))
  ipcMain.handle(IPC_CHANNELS.agentFileDiff, (_e, runId: unknown, path: unknown) =>
    changes.fileDiff(z.string().min(1).parse(runId), z.string().min(1).max(4096).parse(path)),
  )
  ipcMain.handle(IPC_CHANNELS.agentRevert, (_e, raw: unknown) => changes.revert(RevertInputSchema.parse(raw)))
  ipcMain.handle(IPC_CHANNELS.agentListGrants, (_e, workspaceId: unknown) => engine.listGrants(WorkspaceIdSchema.parse(workspaceId)))
  ipcMain.handle(IPC_CHANNELS.agentRevokeGrant, (_e, grantId: unknown) => {
    engine.revokeGrant(z.string().min(1).max(200).parse(grantId))
  })
  ipcMain.handle(IPC_CHANNELS.agentListAgents, () => service.listAgents())
  ipcMain.handle(IPC_CHANNELS.agentUpdateAgent, (_e, raw: unknown) => {
    const input = UpdateAgentInputSchema.parse(raw)
    if (!BUILTIN_AGENTS.some((a) => a.id === input.agentId)) throw new Error(`Unknown agent: ${input.agentId}`)
    const overrides = { ...settings.get().agentOverrides }
    if (input.override === null) delete overrides[input.agentId]
    else overrides[input.agentId] = input.override
    settings.set({ agentOverrides: overrides })
    return service.listAgents()
  })

}
