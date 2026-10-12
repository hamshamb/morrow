import { z } from 'zod'
import type { AgentToolSpec, ProviderChatMessage, ProviderUsage } from '@ai-workspace/providers'
import {
  DEFAULT_AGENT_FOR_MODE,
  clampAgentLimits,
  effectiveTools,
  estimateCostUsd,
  resolveAgents,
  toolSupportOf,
  toolWireName,
  type AgentDefinition,
  type AgentEvent,
  type AgentLimits,
  type AgentOverride,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunStatus,
  type MessageStatus,
  type RunAgentInput,
  type ToolId,
} from '@ai-workspace/shared'
import type { AgentRepository, ConversationRepository, MessageRepository } from '@ai-workspace/storage'
import type { ChatService, ResolveProvider } from '../chat-service'
import { RunToolExecutor } from './tool-executor'
import type { PermissionEngine } from './permission-engine'
import { buildRunReport } from './run-report'
import { buildAgentSystemPrompt } from './system-prompt'
import { getToolById } from './tools/registry'
import type { ToolServices } from './tools/types'

export interface AgentServiceDeps {
  chat: Pick<ChatService, 'persistUserTurn' | 'buildProviderMessages'>
  conversations: ConversationRepository
  messages: MessageRepository
  repo: AgentRepository
  engine: PermissionEngine
  resolveProvider: ResolveProvider
  services: ToolServices
  getSettings: () => { agentLimits: AgentLimits; agentOverrides: Record<string, AgentOverride> }
  /** Decrypted values that must never appear in anything sent to a provider (their own keys). */
  getSecrets: () => string[]
  redact: (text: string, secrets: readonly string[]) => string
  emit: (event: AgentEvent) => void
  platform?: NodeJS.Platform
  /** Test seam: the wall-clock budget in ms (defaults to the configured limit). */
  wallTimeMs?: (limits: AgentLimits) => number
}

interface ActiveRun {
  controller: AbortController
  workspaceId: string
  conversationId: string
  timedOut: boolean
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ')
}

/** JSON Schema for a tool's arguments, in the form every provider accepts. */
export function toolJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  delete json['$schema']
  return json
}

export class AgentService {
  private readonly active = new Map<string, ActiveRun>()

  constructor(private readonly deps: AgentServiceDeps) {}

  isRunActive(runId: string): boolean {
    return this.active.has(runId)
  }

  listAgents(): AgentDefinition[] {
    return resolveAgents(this.deps.getSettings().agentOverrides)
  }

  cancel(runId: string): void {
    const run = this.active.get(runId)
    if (!run) return
    run.controller.abort()
    this.deps.engine.cancelRun(runId)
  }

  /** Stops everything (app quit): no run, command or prompt outlives the app. */
  cancelAll(): void {
    for (const runId of [...this.active.keys()]) this.cancel(runId)
  }

  detail(runId: string): AgentRunDetail | null {
    const run = this.deps.repo.getRun(runId)
    return run ? { ...run, toolRuns: this.deps.repo.listToolRuns(runId) } : null
  }

  listRuns(conversationId: string): AgentRunDetail[] {
    return this.deps.repo.listRunsByConversation(conversationId).map((run) => ({ ...run, toolRuns: this.deps.repo.listToolRuns(run.id) }))
  }

  /** `git status` as a set of "status:path" strings, to notice files a COMMAND changed (best effort). */
  private async treeState(workspaceId: string): Promise<Set<string> | null> {
    try {
      const status = await this.deps.services.git.status(workspaceId)
      if (status.state !== 'ok') return null
      const keys = new Set<string>()
      for (const [area, list] of [['staged', status.staged], ['unstaged', status.unstaged], ['untracked', status.untracked]] as const) {
        for (const change of list) keys.add(`${area}:${change.status}:${change.path}`)
      }
      return keys
    } catch {
      return null
    }
  }

  async run(input: RunAgentInput): Promise<AgentRunDetail> {
    const { deps } = this
    const conversation = deps.conversations.get(input.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${input.conversationId}`)
    const workspaceId = conversation.workspaceId
    const root = deps.services.resolveRoot(workspaceId)
    if (!root) throw new Error('This workspace has no folder yet. Choose a folder in /code first - the agent works inside it.')
    if (this.active.has(input.runId)) throw new Error('A run with this id is already in progress.')
    for (const run of this.active.values()) {
      if (run.workspaceId === workspaceId) throw new Error('Another agent run is still in progress in this workspace. Stop it or wait for it to finish.')
    }

    const settings = deps.getSettings()
    const limits = clampAgentLimits(settings.agentLimits)
    const agents = resolveAgents(settings.agentOverrides)
    const agent = agents.find((a) => a.id === (input.agentId ?? DEFAULT_AGENT_FOR_MODE[input.mode]))
    if (!agent) throw new Error(`Unknown agent: ${input.agentId}`)
    const toolIds: ToolId[] = effectiveTools(agent, input.mode)

    const resolved = await deps.resolveProvider(input.providerConfigId)
    const modelMeta = resolved.getModelMeta?.(input.model) ?? null
    if (toolSupportOf(modelMeta) === 'no') {
      throw new Error(`${modelMeta?.name ?? input.model} does not support tool calls, so it cannot run Plan or Build. Choose a model with tool support, or use chat mode.`)
    }

    // --- persist the user's turn and build what the model sees
    const userMessage = deps.chat.persistUserTurn({ conversationId: input.conversationId, content: input.content, contextSelection: input.contextSelection })
    let history: ProviderChatMessage[] = deps.chat.buildProviderMessages({ conversationId: input.conversationId, selection: input.contextSelection })
    if (agent.contextPolicy === 'task-only') history = history.slice(-1)
    const prompt = buildAgentSystemPrompt({
      agent,
      mode: input.mode,
      tools: toolIds,
      maxSteps: limits.maxSteps,
      platform: deps.platform ?? process.platform,
      shellTitle: deps.services.shell.title,
    })
    const providerMessages: ProviderChatMessage[] = [{ role: 'system', content: prompt }, ...history]

    const controller = new AbortController()
    const state: ActiveRun = { controller, workspaceId, conversationId: input.conversationId, timedOut: false }
    this.active.set(input.runId, state)

    const run = deps.repo.createRun({
      id: input.runId,
      workspaceId,
      conversationId: input.conversationId,
      userMessageId: userMessage.id,
      mode: input.mode,
      agentId: agent.id,
      provider: resolved.provider,
      model: input.model,
      maxSteps: limits.maxSteps,
    })
    deps.emit({ type: 'run-start', run })

    const secrets = deps.getSecrets()
    const redact = (text: string): string => deps.redact(text, secrets)
    let step = 0
    const executor = new RunToolExecutor({
      repo: deps.repo,
      engine: deps.engine,
      services: deps.services,
      emit: deps.emit,
      redact,
      run: { runId: input.runId, workspaceId, conversationId: input.conversationId, mode: input.mode, allowedTools: toolIds, signal: controller.signal },
      currentStep: () => step,
    })

    const specs: AgentToolSpec[] = toolIds.map((id) => {
      const def = getToolById(id)
      if (!def) throw new Error(`Missing tool definition: ${id}`)
      const wire = toolWireName(id)
      return {
        name: wire,
        description: def.description,
        inputJsonSchema: toolJsonSchema(def.inputSchema),
        validate: (value) => {
          const parsed = def.inputSchema.safeParse(value)
          return parsed.success ? { success: true as const, value: parsed.data } : { success: false as const, error: new Error(zodMessage(parsed.error)) }
        },
        execute: async (toolInput) => executor.execute(wire, toolInput),
      }
    })

    const timer = setTimeout(() => {
      state.timedOut = true
      controller.abort()
      deps.engine.cancelRun(input.runId)
    }, deps.wallTimeMs?.(limits) ?? limits.maxWallSeconds * 1000)

    const treeBefore = await this.treeState(workspaceId)

    let narrative = ''
    let errorMessage: string | null = null
    let usage: ProviderUsage | undefined
    let doneSteps = 0
    let finishReason: string | undefined
    let breakBeforeText = false
    const handledInvalid = new Set<string>()
    const startedAt = Date.now()

    try {
      for await (const event of resolved.chatProvider.streamChat({
        model: input.model,
        messages: providerMessages,
        signal: controller.signal,
        effort: input.effort ?? null,
        modelMeta,
        toolOptions: { tools: specs, maxSteps: limits.maxSteps },
      })) {
        if (event.type === 'step-start') {
          step = event.step
          if (narrative.length > 0) breakBeforeText = true
          deps.repo.updateRun(input.runId, { steps: step })
          deps.emit({ type: 'step', runId: input.runId, step })
        } else if (event.type === 'text-delta') {
          let delta = event.delta
          if (breakBeforeText) {
            if (!/\s$/.test(narrative)) delta = `\n\n${delta}`
            breakBeforeText = false
          }
          narrative += delta
          deps.emit({ type: 'text-delta', runId: input.runId, delta })
        } else if (event.type === 'tool-call') {
          if (event.invalid) {
            handledInvalid.add(event.toolCallId)
            executor.recordInvalid(event.toolName, event.input, event.invalid)
          }
        } else if (event.type === 'tool-error') {
          if (!handledInvalid.has(event.toolCallId)) {
            handledInvalid.add(event.toolCallId)
            executor.recordInvalid(event.toolName, undefined, event.error)
          }
        } else if (event.type === 'error') {
          errorMessage = event.error
          break
        } else if (event.type === 'done') {
          usage = event.usage
          doneSteps = event.steps ?? step
          finishReason = event.finishReason
        }
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    clearTimeout(timer)
    deps.engine.cancelRun(input.runId) // withdraw any prompt still open
    this.active.delete(input.runId)

    // --- how did it end?
    let status: AgentRunStatus
    let messageStatus: MessageStatus = 'complete'
    let errorText: string | null = null
    if (state.timedOut) {
      status = 'timeout'
      messageStatus = 'error'
      errorText = `The run hit its time limit (${Math.round(limits.maxWallSeconds / 60)} min) and was stopped.`
    } else if (controller.signal.aborted) {
      status = 'cancelled'
      messageStatus = 'cancelled'
    } else if (errorMessage) {
      status = 'failed'
      messageStatus = 'error'
      errorText = errorMessage
    } else if (finishReason === 'tool-calls' && doneSteps >= limits.maxSteps) {
      status = 'step_limit'
    } else {
      status = 'completed'
    }

    // --- the report: from the audit log and the disk, never from the model
    const treeAfter = await this.treeState(workspaceId)
    const snapshots = deps.repo.listSnapshots(input.runId)
    const editedPaths = new Set(snapshots.map((s) => s.path))
    const changedByCommands: string[] = []
    if (treeBefore && treeAfter) {
      for (const key of treeAfter) {
        if (treeBefore.has(key)) continue
        const path = key.split(':').slice(2).join(':')
        if (!editedPaths.has(path) && !changedByCommands.includes(path)) changedByCommands.push(path)
      }
    }
    const toolRuns = deps.repo.listToolRuns(input.runId)
    const report = await buildRunReport({ runStatus: status, toolRuns, snapshots, root, modelText: narrative, changedByCommands })

    const modelMeta2 = modelMeta
    const assistant = deps.messages.create({
      conversationId: input.conversationId,
      role: 'assistant',
      provider: resolved.provider,
      model: input.model,
      status: messageStatus,
      parts: narrative.length > 0 ? [{ type: 'text', content: narrative }] : [],
      replyGroupId: userMessage.id,
      orchestrationMode: 'normal',
      inContext: narrative.length > 0,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      latencyMs: Date.now() - startedAt,
      estCostUsd: estimateCostUsd(modelMeta2?.cost, usage),
      errorText,
    })
    deps.conversations.touch(input.conversationId)

    const finished: AgentRun = deps.repo.updateRun(input.runId, {
      status,
      steps: Math.max(step, doneSteps),
      errorText,
      report,
      assistantMessageId: assistant.id,
      finishedAt: Date.now(),
    })
    const detail: AgentRunDetail = { ...finished, toolRuns: deps.repo.listToolRuns(input.runId) }
    deps.emit({ type: 'run-end', run: finished, detail })
    return detail
  }
}
