import { randomUUID } from 'node:crypto'
import {
  RunReportSchema,
  type AgentMode,
  type AgentRun,
  type AgentRunStatus,
  type DecisionSource,
  type PermissionGrant,
  type RunReport,
  type ToolId,
  type ToolRisk,
  type ToolRun,
  type ToolRunStatus,
} from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface AgentRunRow {
  id: string
  workspace_id: string
  conversation_id: string
  user_message_id: string | null
  assistant_message_id: string | null
  mode: string
  agent_id: string
  provider: string | null
  model: string | null
  status: string
  steps: number
  max_steps: number
  error_text: string | null
  report_json: string | null
  started_at: number
  finished_at: number | null
}

interface ToolRunRow {
  id: string
  run_id: string
  workspace_id: string
  conversation_id: string
  seq: number
  step: number
  tool_id: string
  risk: string
  label: string
  summary: string
  input_json: string
  detail: string | null
  status: string
  decision_source: string | null
  exit_code: number | null
  started_at: number
  finished_at: number | null
  duration_ms: number | null
}

interface GrantRow {
  id: string
  workspace_id: string
  tool_id: string
  risk: string
  command: string
  created_at: number
}

interface SnapshotRow {
  id: string
  run_id: string
  workspace_id: string
  path: string
  before_content: Buffer | null
  before_hash: string | null
  after_hash: string
  created_at: number
  updated_at: number
  reverted_at: number | null
}

function parseReport(json: string | null): RunReport | null {
  if (!json) return null
  try {
    const parsed = RunReportSchema.safeParse(JSON.parse(json))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function rowToRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    mode: row.mode as AgentMode,
    agentId: row.agent_id,
    provider: row.provider,
    model: row.model,
    status: row.status as AgentRunStatus,
    steps: row.steps,
    maxSteps: row.max_steps,
    errorText: row.error_text,
    report: parseReport(row.report_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function rowToToolRun(row: ToolRunRow): ToolRun {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    seq: row.seq,
    step: row.step,
    toolId: row.tool_id as ToolId,
    risk: row.risk as ToolRisk,
    label: row.label,
    summary: row.summary,
    input: row.input_json,
    detail: row.detail,
    status: row.status as ToolRunStatus,
    decisionSource: row.decision_source as DecisionSource | null,
    exitCode: row.exit_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
  }
}

function rowToGrant(row: GrantRow): PermissionGrant {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    toolId: row.tool_id as ToolId,
    risk: row.risk as ToolRisk,
    command: row.command === '' ? null : row.command,
    createdAt: row.created_at,
  }
}

export interface CreateRunInput {
  id: string
  workspaceId: string
  conversationId: string
  userMessageId: string | null
  mode: AgentMode
  agentId: string
  provider: string | null
  model: string | null
  maxSteps: number
}

export interface UpdateRunInput {
  assistantMessageId?: string | null
  status?: AgentRunStatus
  steps?: number
  errorText?: string | null
  report?: RunReport | null
  finishedAt?: number | null
}

export interface CreateToolRunInput {
  runId: string
  workspaceId: string
  conversationId: string
  step: number
  toolId: ToolId
  risk: ToolRisk
  label: string
  inputJson: string
  status: ToolRunStatus
  decisionSource?: DecisionSource | null
}

export interface UpdateToolRunInput {
  risk?: ToolRisk
  label?: string
  summary?: string
  detail?: string | null
  status?: ToolRunStatus
  decisionSource?: DecisionSource | null
  exitCode?: number | null
  finishedAt?: number | null
  durationMs?: number | null
}

export interface FileSnapshot {
  id: string
  runId: string
  workspaceId: string
  path: string
  /** null = the file did not exist before the run. */
  beforeContent: Buffer | null
  beforeHash: string | null
  /** Hash of the agent's last write to this file. */
  afterHash: string
  createdAt: number
  updatedAt: number
  revertedAt: number | null
}

function rowToSnapshot(row: SnapshotRow): FileSnapshot {
  return {
    id: row.id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    path: row.path,
    beforeContent: row.before_content,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revertedAt: row.reverted_at,
  }
}

/**
 * Agent runs, the tool audit trail, permission grants and pre-edit snapshots
 * (migration 0006). Plain data access: every rule about what may run lives in
 * the main process's permission engine, not here.
 */
export class AgentRepository {
  constructor(private readonly db: AppDatabase) {}

  // ------------------------------------------------------------ runs

  createRun(input: CreateRunInput, now = Date.now()): AgentRun {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, workspace_id, conversation_id, user_message_id, mode, agent_id, provider, model,
                                 status, steps, max_steps, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 0, ?, ?)`,
      )
      .run(
        input.id,
        input.workspaceId,
        input.conversationId,
        input.userMessageId,
        input.mode,
        input.agentId,
        input.provider,
        input.model,
        input.maxSteps,
        now,
      )
    return this.getRun(input.id) as AgentRun
  }

  updateRun(id: string, patch: UpdateRunInput): AgentRun {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.assistantMessageId !== undefined) add('assistant_message_id', patch.assistantMessageId)
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.steps !== undefined) add('steps', patch.steps)
    if (patch.errorText !== undefined) add('error_text', patch.errorText)
    if (patch.report !== undefined) add('report_json', patch.report === null ? null : JSON.stringify(patch.report))
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt)
    if (sets.length > 0) {
      this.db.prepare(`UPDATE agent_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    const run = this.getRun(id)
    if (!run) throw new Error(`Agent run not found: ${id}`)
    return run
  }

  getRun(id: string): AgentRun | null {
    const row = this.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as AgentRunRow | undefined
    return row ? rowToRun(row) : null
  }

  listRunsByConversation(conversationId: string): AgentRun[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY started_at ASC, rowid ASC')
      .all(conversationId) as AgentRunRow[]
    return rows.map(rowToRun)
  }

  /** A run left `running` by a crash or a hard quit can never finish; close it so the UI is not stuck on it. */
  failInterruptedRuns(now = Date.now()): number {
    const info = this.db
      .prepare(
        `UPDATE agent_runs SET status = 'failed', error_text = 'The app closed while this run was in progress.', finished_at = ?
         WHERE status = 'running'`,
      )
      .run(now)
    this.db
      .prepare(
        `UPDATE tool_runs SET status = 'cancelled', decision_source = COALESCE(decision_source, 'cancelled'), finished_at = ?
         WHERE status IN ('pending', 'running')`,
      )
      .run(now)
    return info.changes
  }

  // ------------------------------------------------------------ tool runs (audit)

  createToolRun(input: CreateToolRunInput, now = Date.now()): ToolRun {
    const id = randomUUID()
    const create = this.db.transaction(() => {
      const next = this.db
        .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM tool_runs WHERE run_id = ?')
        .get(input.runId) as { seq: number }
      this.db
        .prepare(
          `INSERT INTO tool_runs (id, run_id, workspace_id, conversation_id, seq, step, tool_id, risk, label, summary,
                                  input_json, status, decision_source, started_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.runId,
          input.workspaceId,
          input.conversationId,
          next.seq,
          input.step,
          input.toolId,
          input.risk,
          input.label,
          input.inputJson,
          input.status,
          input.decisionSource ?? null,
          now,
        )
    })
    create()
    return this.getToolRun(id) as ToolRun
  }

  updateToolRun(id: string, patch: UpdateToolRunInput): ToolRun {
    const sets: string[] = []
    const values: unknown[] = []
    const add = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`)
      values.push(value)
    }
    if (patch.risk !== undefined) add('risk', patch.risk)
    if (patch.label !== undefined) add('label', patch.label)
    if (patch.summary !== undefined) add('summary', patch.summary)
    if (patch.detail !== undefined) add('detail', patch.detail)
    if (patch.status !== undefined) add('status', patch.status)
    if (patch.decisionSource !== undefined) add('decision_source', patch.decisionSource)
    if (patch.exitCode !== undefined) add('exit_code', patch.exitCode)
    if (patch.finishedAt !== undefined) add('finished_at', patch.finishedAt)
    if (patch.durationMs !== undefined) add('duration_ms', patch.durationMs)
    if (sets.length > 0) {
      this.db.prepare(`UPDATE tool_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id)
    }
    const run = this.getToolRun(id)
    if (!run) throw new Error(`Tool run not found: ${id}`)
    return run
  }

  getToolRun(id: string): ToolRun | null {
    const row = this.db.prepare('SELECT * FROM tool_runs WHERE id = ?').get(id) as ToolRunRow | undefined
    return row ? rowToToolRun(row) : null
  }

  listToolRuns(runId: string): ToolRun[] {
    const rows = this.db.prepare('SELECT * FROM tool_runs WHERE run_id = ? ORDER BY seq ASC').all(runId) as ToolRunRow[]
    return rows.map(rowToToolRun)
  }

  // ------------------------------------------------------------ grants

  listGrants(workspaceId: string): PermissionGrant[] {
    const rows = this.db
      .prepare('SELECT * FROM permission_grants WHERE workspace_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(workspaceId) as GrantRow[]
    return rows.map(rowToGrant)
  }

  findGrant(workspaceId: string, toolId: ToolId, risk: ToolRisk, command: string | null): PermissionGrant | null {
    const row = this.db
      .prepare('SELECT * FROM permission_grants WHERE workspace_id = ? AND tool_id = ? AND risk = ? AND command = ?')
      .get(workspaceId, toolId, risk, command ?? '') as GrantRow | undefined
    return row ? rowToGrant(row) : null
  }

  /** Idempotent: granting the same thing twice keeps one row. */
  addGrant(
    input: { workspaceId: string; toolId: ToolId; risk: ToolRisk; command: string | null },
    now = Date.now(),
  ): PermissionGrant {
    const existing = this.findGrant(input.workspaceId, input.toolId, input.risk, input.command)
    if (existing) return existing
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO permission_grants (id, workspace_id, tool_id, risk, command, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.workspaceId, input.toolId, input.risk, input.command ?? '', now)
    return this.findGrant(input.workspaceId, input.toolId, input.risk, input.command) as PermissionGrant
  }

  deleteGrant(id: string): void {
    this.db.prepare('DELETE FROM permission_grants WHERE id = ?').run(id)
  }

  // ------------------------------------------------------------ snapshots

  getSnapshot(runId: string, path: string): FileSnapshot | null {
    const row = this.db
      .prepare('SELECT * FROM agent_file_snapshots WHERE run_id = ? AND path = ?')
      .get(runId, path) as SnapshotRow | undefined
    return row ? rowToSnapshot(row) : null
  }

  listSnapshots(runId: string): FileSnapshot[] {
    const rows = this.db
      .prepare('SELECT * FROM agent_file_snapshots WHERE run_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(runId) as SnapshotRow[]
    return rows.map(rowToSnapshot)
  }

  /**
   * First write to a path in a run records the pre-run bytes; later writes only move `after_hash`.
   * That keeps `[revert file]` = "back to how the file was before this run".
   */
  recordWrite(
    input: {
      runId: string
      workspaceId: string
      path: string
      beforeContent: Buffer | null
      beforeHash: string | null
      afterHash: string
    },
    now = Date.now(),
  ): FileSnapshot {
    const existing = this.getSnapshot(input.runId, input.path)
    if (existing) {
      this.db
        .prepare('UPDATE agent_file_snapshots SET after_hash = ?, updated_at = ?, reverted_at = NULL WHERE id = ?')
        .run(input.afterHash, now, existing.id)
    } else {
      this.db
        .prepare(
          `INSERT INTO agent_file_snapshots (id, run_id, workspace_id, path, before_content, before_hash, after_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(randomUUID(), input.runId, input.workspaceId, input.path, input.beforeContent, input.beforeHash, input.afterHash, now, now)
    }
    return this.getSnapshot(input.runId, input.path) as FileSnapshot
  }

  markReverted(snapshotId: string, now = Date.now()): void {
    this.db.prepare('UPDATE agent_file_snapshots SET reverted_at = ? WHERE id = ?').run(now, snapshotId)
  }
}
