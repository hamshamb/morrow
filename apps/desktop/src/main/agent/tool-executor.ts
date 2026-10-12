import { randomUUID } from 'node:crypto'
import {
  toolWireName,
  type AgentEvent,
  type AgentMode,
  type DecisionSource,
  type ToolId,
  type ToolRisk,
  type ToolRun,
  type ToolRunStatus,
} from '@ai-workspace/shared'
import type { AgentRepository } from '@ai-workspace/storage'
import { ZodError } from 'zod'
import type { PermissionEngine, PermissionSubject } from './permission-engine'
import { getToolByWireName } from './tools/registry'
import { ToolError, type Assessment, type Prepared, type ToolContext, type ToolDefinition, type ToolResult, type ToolServices } from './tools/types'

/** What `execute` hands back to the provider layer (becomes the model's tool result). */
export interface ExecutorOutcome {
  text: string
  isError: boolean
}

export interface RunToolExecutorOptions {
  repo: AgentRepository
  engine: PermissionEngine
  services: ToolServices
  emit: (event: AgentEvent) => void
  /** Removes secrets from anything that leaves the machine, is stored, or is shown. */
  redact: (text: string) => string
  run: { runId: string; workspaceId: string; conversationId: string; mode: AgentMode; allowedTools: readonly ToolId[]; signal: AbortSignal }
  /** Per-run state shared with the report: how many model calls so far. */
  currentStep: () => number
}

const DETAIL_STORE_CAP = 64 * 1024
const OUTPUT_FLUSH_MS = 50

function zodMessage(err: ZodError): string {
  return err.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ')
}

/**
 * Runs one run's tool calls. This is the single path from "the model asked" to "something happened":
 * look up -> validate -> classify -> prepare (no side effects) -> permission -> run -> audit -> redact.
 * It records every call, including refused and failed ones, in the audit log.
 */
export class RunToolExecutor {
  /** The files this run has read (or last wrote), by hash - the basis of the stale-edit rule. */
  readonly reads = new Map<string, string>()
  private exclusive: Promise<unknown> = Promise.resolve()

  constructor(private readonly o: RunToolExecutorOptions) {}

  /** Entry point used as the provider's tool `execute`. Never throws. */
  async execute(wireName: string, rawInput: unknown): Promise<ExecutorOutcome> {
    const tool = getToolByWireName(wireName)
    if (!tool || !this.o.run.allowedTools.includes(tool.id)) {
      return this.recordRefused(wireName, rawInput, tool ? 'This tool is not available in the current mode for this agent.' : `There is no tool named "${wireName}".`)
    }
    // Reads run freely in parallel. Anything that can change the workspace or run a program goes one at a
    // time, so prompts appear one after another and edits cannot race each other.
    if (tool.risk === 'safe') return this.runTool(tool, rawInput)
    const turn = this.exclusive.then(() => this.runTool(tool, rawInput))
    this.exclusive = turn.catch(() => undefined)
    return turn
  }

  /** The SDK rejected a call before `execute` (unparsable, unknown tool, schema mismatch): still audited. */
  recordInvalid(wireName: string, rawInput: unknown, reason: string): void {
    const tool = getToolByWireName(wireName)
    // A tool that exists and was offered but got bad arguments is an error; a tool that was not offered
    // (wrong mode / agent ceiling) or does not exist is a refusal.
    const offered = tool !== undefined && this.o.run.allowedTools.includes(tool.id)
    this.recordRefused(wireName, rawInput, reason, offered ? 'error' : 'denied')
  }

  private context(onOutput: (chunk: string) => void): ToolContext {
    const { run, services, repo } = this.o
    return {
      services,
      workspaceId: run.workspaceId,
      runId: run.runId,
      conversationId: run.conversationId,
      mode: run.mode,
      signal: run.signal,
      reads: this.reads,
      onOutput,
      snapshots: {
        record: (snap) =>
          void repo.recordWrite({ runId: run.runId, workspaceId: run.workspaceId, path: snap.path, beforeContent: snap.beforeContent, beforeHash: snap.beforeHash, afterHash: snap.afterHash }),
      },
    }
  }

  private audit(id: string, patch: Parameters<AgentRepository['updateToolRun']>[1]): ToolRun {
    const row = this.o.repo.updateToolRun(id, patch)
    this.o.emit({ type: 'tool', runId: this.o.run.runId, toolRun: row })
    return row
  }

  private recordRefused(wireName: string, rawInput: unknown, reason: string, status: ToolRunStatus = 'denied'): ExecutorOutcome {
    const { repo, run, redact } = this.o
    const tool = getToolByWireName(wireName)
    let inputJson = '{}'
    try {
      inputJson = redact(JSON.stringify(rawInput ?? {}))
    } catch {
      /* unserializable input */
    }
    const row = repo.createToolRun({
      runId: run.runId,
      workspaceId: run.workspaceId,
      conversationId: run.conversationId,
      step: this.o.currentStep(),
      // An unknown tool name is stored as written (the column is plain text) so the attempt is visible.
      toolId: (tool?.id ?? wireName.slice(0, 80)) as ToolId,
      risk: tool?.risk ?? 'safe',
      label: tool ? `${wireName} (refused)` : `unavailable tool ${wireName.slice(0, 60)}`,
      inputJson: inputJson.slice(0, 8000),
      status,
      decisionSource: status === 'denied' ? 'mode-blocked' : 'not-asked',
    })
    this.audit(row.id, { summary: reason.slice(0, 200), status, finishedAt: Date.now(), durationMs: 0, detail: reason })
    return { text: `ERROR: ${reason}`, isError: true }
  }

  private async runTool(tool: ToolDefinition<unknown>, rawInput: unknown): Promise<ExecutorOutcome> {
    const { repo, engine, run, redact } = this.o
    const started = Date.now()
    if (run.signal.aborted) return { text: 'ERROR: the run was cancelled.', isError: true }

    // --- validate
    const parsed = tool.inputSchema.safeParse(rawInput)
    let inputJson = '{}'
    try {
      inputJson = redact(JSON.stringify(rawInput ?? {})).slice(0, 8000)
    } catch {
      /* ignore */
    }
    const row = repo.createToolRun({
      runId: run.runId,
      workspaceId: run.workspaceId,
      conversationId: run.conversationId,
      step: this.o.currentStep(),
      toolId: tool.id,
      risk: tool.risk,
      label: redact(parsed.success ? tool.label(parsed.data) : toolWireName(tool.id)),
      inputJson,
      status: 'pending',
    })
    this.o.emit({ type: 'tool', runId: run.runId, toolRun: row })

    const fail = (status: ToolRunStatus, source: DecisionSource | null, message: string, extra: { risk?: ToolRisk; detail?: string | null } = {}): ExecutorOutcome => {
      this.audit(row.id, {
        status,
        decisionSource: source,
        summary: message.slice(0, 200),
        detail: extra.detail ?? message,
        finishedAt: Date.now(),
        durationMs: Date.now() - started,
        ...(extra.risk ? { risk: extra.risk } : {}),
      })
      return { text: `ERROR: ${message}`, isError: true }
    }

    if (!parsed.success) return fail('error', 'not-asked', `Invalid arguments for ${toolWireName(tool.id)}: ${zodMessage(parsed.error)}`)
    const input = parsed.data

    // --- output streaming (commands): coalesced so a chatty process does not flood the IPC channel
    let pendingOutput = ''
    let flushTimer: NodeJS.Timeout | undefined
    const flush = (): void => {
      flushTimer = undefined
      if (pendingOutput === '') return
      const chunk = redact(pendingOutput)
      pendingOutput = ''
      this.o.emit({ type: 'tool-output', runId: run.runId, toolRunId: row.id, chunk })
    }
    const onOutput = (chunk: string): void => {
      pendingOutput += chunk
      flushTimer ??= setTimeout(flush, OUTPUT_FLUSH_MS)
    }
    const ctx = this.context(onOutput)

    try {
      // --- classify
      const assessment: Assessment = tool.assess ? await tool.assess(input, ctx) : { risk: tool.risk, noGrant: false, command: null, grantScopeNote: null }
      if (assessment.risk !== tool.risk) this.audit(row.id, { risk: assessment.risk })

      // --- prepare (validates against the disk; builds the preview; no side effects)
      let prepared: Prepared | null = null
      if (tool.prepare) {
        try {
          prepared = await tool.prepare(input, ctx)
        } catch (err) {
          if (err instanceof ToolError) return fail('error', 'not-asked', err.message, { risk: assessment.risk })
          throw err
        }
      }

      // --- permission
      const subject: PermissionSubject = {
        runId: run.runId,
        toolRunId: row.id,
        workspaceId: run.workspaceId,
        conversationId: run.conversationId,
        toolId: tool.id,
        risk: assessment.risk,
        command: assessment.command,
        noGrant: assessment.noGrant,
        grantScopeNote: assessment.grantScopeNote,
        preview: prepared?.preview ?? { kind: 'other', description: row.label },
      }
      const gate = engine.gate(subject)
      let source: DecisionSource
      if (gate.kind === 'allow') {
        source = gate.source
      } else {
        const outcome = await engine.ask(subject, run.signal)
        if (outcome.decision === 'cancelled') return fail('cancelled', 'cancelled', 'The run was cancelled while waiting for permission.', { risk: assessment.risk })
        if (outcome.decision === 'deny') {
          return fail('denied', 'prompt-deny', 'The user DENIED this action. Do not retry it or work around it; explain what you needed and ask the user how to proceed, or take a different approach.', { risk: assessment.risk })
        }
        source = outcome.source
      }
      if (run.signal.aborted) return fail('cancelled', 'cancelled', 'The run was cancelled.', { risk: assessment.risk })

      // --- run
      this.audit(row.id, { status: 'running', decisionSource: source, risk: assessment.risk })
      let result: ToolResult
      try {
        result = await tool.run(input, ctx, prepared)
      } catch (err) {
        if (flushTimer) clearTimeout(flushTimer)
        flush()
        if (err instanceof ToolError) return fail('error', source, err.message, { risk: assessment.risk })
        throw err
      }
      if (flushTimer) clearTimeout(flushTimer)
      flush()

      const status: ToolRunStatus = result.cancelled ? 'cancelled' : result.isError || result.failed ? 'error' : 'ok'
      const text = redact(result.text)
      const detail = result.detail ? redact(result.detail).slice(-DETAIL_STORE_CAP) : null
      this.audit(row.id, {
        status,
        decisionSource: source,
        summary: redact(result.summary).slice(0, 200),
        detail,
        exitCode: result.exitCode ?? null,
        finishedAt: Date.now(),
        durationMs: Date.now() - started,
      })
      return { text, isError: result.isError === true || result.cancelled === true }
    } catch (err) {
      if (flushTimer) clearTimeout(flushTimer)
      const message = err instanceof Error ? err.message : String(err)
      return fail('error', null, `Internal error while running the tool: ${redact(message)}`)
    }
  }
}

export const newRunId = (): string => randomUUID()
