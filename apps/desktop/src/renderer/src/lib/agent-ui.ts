import type {
  AgentEvent,
  AgentRun,
  AgentRunDetail,
  AgentRunStatus,
  DecisionSource,
  PermissionRequest,
  RunReport,
  ToolId,
  ToolRisk,
  ToolRun,
} from '@ai-workspace/shared'

/**
 * Pure view-model helpers for the Plan / Build UI: the live-run reducer that turns the main process's
 * event stream into screen state, and the small text/glyph mappings the activity rows, permission prompts
 * and run report share. No React in here, so it is unit-tested directly.
 */

export const OUTPUT_CAP_CHARS = 40_000
const OUTPUT_LOG_MAX = 20

export interface LiveAgent {
  runId: string
  conversationId: string
  mode: AgentRun['mode']
  agentId: string
  provider: string | null
  model: string | null
  step: number
  maxSteps: number
  /** The model's narrative so far. */
  text: string
  /** Audit rows, in order. */
  toolRuns: ToolRun[]
  /** Live command output by tool run id. */
  outputs: Record<string, string>
  startedAt: number
}

/** One command's output for the bottom panel's AGENT tab. */
export interface AgentOutputEntry {
  toolRunId: string
  runId: string
  label: string
  status: ToolRun['status']
  text: string
  at: number
}

export interface AgentUiState {
  /** The run in progress (any conversation - there is one per workspace at a time). */
  live: LiveAgent | null
  /** Prompts waiting for an answer. */
  permissions: PermissionRequest[]
  outputLog: AgentOutputEntry[]
  /** The narrative of the run that just ended, kept until the saved reply is loaded (no flicker between the two). */
  endedText: { runId: string; text: string } | null
}

export const initialAgentState: AgentUiState = { live: null, permissions: [], outputLog: [], endedText: null }

function upsertToolRun(rows: ToolRun[], row: ToolRun): ToolRun[] {
  const index = rows.findIndex((r) => r.id === row.id)
  if (index === -1) return [...rows, row].sort((a, b) => a.seq - b.seq)
  const next = rows.slice()
  next[index] = row
  return next
}

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP_CHARS ? `…${text.slice(text.length - OUTPUT_CAP_CHARS)}` : text
}

export type AgentAction = { type: 'event'; event: AgentEvent } | { type: 'pending'; requests: PermissionRequest[] } | { type: 'reset-output' }

export function reduceAgent(state: AgentUiState, action: AgentAction): AgentUiState {
  if (action.type === 'pending') {
    // Merge: anything already known stays, anything new is added.
    const known = new Set(state.permissions.map((p) => p.requestId))
    return { ...state, permissions: [...state.permissions, ...action.requests.filter((r) => !known.has(r.requestId))] }
  }
  if (action.type === 'reset-output') return { ...state, outputLog: [] }

  const event = action.event
  switch (event.type) {
    case 'run-start':
      return {
        ...state,
        live: {
          runId: event.run.id,
          conversationId: event.run.conversationId,
          mode: event.run.mode,
          agentId: event.run.agentId,
          provider: event.run.provider,
          model: event.run.model,
          step: 0,
          maxSteps: event.run.maxSteps,
          text: '',
          toolRuns: [],
          outputs: {},
          startedAt: event.run.startedAt,
        },
      }
    case 'step':
      return state.live && state.live.runId === event.runId ? { ...state, live: { ...state.live, step: event.step } } : state
    case 'text-delta':
      return state.live && state.live.runId === event.runId ? { ...state, live: { ...state.live, text: state.live.text + event.delta } } : state
    case 'tool': {
      let outputLog = state.outputLog
      if (event.toolRun.toolId === 'terminal.execute') {
        const index = outputLog.findIndex((e) => e.toolRunId === event.toolRun.id)
        // Only a command that actually started belongs in the output log: not one still waiting for approval,
        // and not one that was denied, cancelled before it ran, or rejected as invalid.
        const started = event.toolRun.status === 'running' || ((event.toolRun.status === 'ok' || event.toolRun.status === 'error') && event.toolRun.exitCode !== null)
        if (index === -1) {
          if (!started) return state.live && state.live.runId === event.runId ? { ...state, live: { ...state.live, toolRuns: upsertToolRun(state.live.toolRuns, event.toolRun) } } : state
          outputLog = [...outputLog, { toolRunId: event.toolRun.id, runId: event.runId, label: event.toolRun.label, status: event.toolRun.status, text: '', at: event.toolRun.startedAt }].slice(-OUTPUT_LOG_MAX)
        } else {
          const next = outputLog.slice()
          const entry = next[index] as AgentOutputEntry
          // A finished command carries its stored output; use it if nothing streamed (e.g. after a reload).
          next[index] = { ...entry, label: event.toolRun.label, status: event.toolRun.status, text: entry.text === '' && event.toolRun.detail ? capOutput(event.toolRun.detail) : entry.text }
          outputLog = next
        }
      }
      if (!state.live || state.live.runId !== event.runId) return { ...state, outputLog }
      return { ...state, outputLog, live: { ...state.live, toolRuns: upsertToolRun(state.live.toolRuns, event.toolRun) } }
    }
    case 'tool-output': {
      const index = state.outputLog.findIndex((e) => e.toolRunId === event.toolRunId)
      const outputLog = state.outputLog.slice()
      if (index !== -1) {
        const entry = outputLog[index] as AgentOutputEntry
        outputLog[index] = { ...entry, text: capOutput(entry.text + event.chunk) }
      }
      if (!state.live || state.live.runId !== event.runId) return { ...state, outputLog }
      return {
        ...state,
        outputLog,
        live: { ...state.live, outputs: { ...state.live.outputs, [event.toolRunId]: capOutput((state.live.outputs[event.toolRunId] ?? '') + event.chunk) } },
      }
    }
    case 'permission-request':
      if (state.permissions.some((p) => p.requestId === event.request.requestId)) return state
      return { ...state, permissions: [...state.permissions, event.request] }
    case 'permission-resolved':
      return { ...state, permissions: state.permissions.filter((p) => p.requestId !== event.requestId) }
    case 'run-end':
      return {
        ...state,
        live: state.live && state.live.runId === event.run.id ? null : state.live,
        permissions: state.permissions.filter((p) => p.runId !== event.run.id),
        endedText: state.live && state.live.runId === event.run.id ? { runId: event.run.id, text: state.live.text } : state.endedText,
      }
  }
}

/** Inserts or replaces a run (by id), keeping start order. */
export function upsertRun(runs: AgentRunDetail[], detail: AgentRunDetail): AgentRunDetail[] {
  const index = runs.findIndex((r) => r.id === detail.id)
  if (index === -1) return [...runs, detail].sort((a, b) => a.startedAt - b.startedAt)
  const next = runs.slice()
  next[index] = detail
  return next
}

// ---------------------------------------------------------------- rows

const VERBS: Partial<Record<ToolId, string>> = {
  'filesystem.read': 'read',
  'filesystem.list': 'list',
  'filesystem.search': 'search',
  'workspace.search': 'index search',
  'filesystem.write': 'write',
  'filesystem.patch': 'patch',
  'terminal.execute': 'run',
}

/** `read` + `src/a.ts`: the main-process label split into the row's title and subtitle. */
export function splitLabel(row: Pick<ToolRun, 'toolId' | 'label'>): { title: string; subtitle: string } {
  const verb = VERBS[row.toolId]
  if (verb && row.label.startsWith(`${verb} `)) return { title: verb, subtitle: row.label.slice(verb.length + 1) }
  const space = row.label.indexOf(' ')
  if (space === -1) return { title: row.label, subtitle: '' }
  return { title: row.label.slice(0, space), subtitle: row.label.slice(space + 1) }
}

export type RowTone = 'running' | 'ok' | 'good' | 'error' | 'denied' | 'cancelled'

/** The one-glyph status mark at the start of an activity row. */
export function rowGlyph(row: Pick<ToolRun, 'toolId' | 'status' | 'exitCode'>): { glyph: string; tone: RowTone } {
  switch (row.status) {
    case 'pending':
    case 'running':
      return { glyph: '●', tone: 'running' }
    case 'denied':
      return { glyph: '⊘', tone: 'denied' }
    case 'cancelled':
      return { glyph: '–', tone: 'cancelled' }
    case 'error':
      return { glyph: '✗', tone: 'error' }
    case 'ok':
      return row.toolId === 'terminal.execute' ? { glyph: '✓', tone: 'good' } : { glyph: '●', tone: 'ok' }
  }
}

/** Does the row have anything worth expanding (a diff, command output, a reason)? */
export function rowHasDetails(row: Pick<ToolRun, 'detail' | 'status' | 'toolId'>, liveOutput: string | undefined): boolean {
  if (liveOutput) return true
  if (row.detail && row.detail.trim() !== '') return true
  return row.status === 'denied' || row.status === 'error'
}

const DECISIONS: Record<DecisionSource, string> = {
  'default-safe': 'read-only: no approval needed',
  'prompt-once': 'approved once',
  'prompt-session': 'approved for this session',
  'prompt-workspace': 'approved for this workspace',
  'session-grant': 'covered by a session grant',
  'workspace-grant': 'covered by a workspace grant',
  'prompt-deny': 'denied by you',
  'mode-blocked': 'not available in this mode',
  cancelled: 'cancelled',
  'not-asked': 'rejected before it could run',
}

export function decisionText(source: DecisionSource | null): string {
  return source ? DECISIONS[source] : ''
}

export const RISK_TEXT: Record<ToolRisk, string> = {
  safe: 'read',
  write: 'write',
  execution: 'execution',
  network: 'network',
  destructive: 'destructive',
}

/** `AGENT REQUESTS · run (execution)` */
export function promptHeading(request: Pick<PermissionRequest, 'toolId' | 'risk'>): string {
  const verb = VERBS[request.toolId] ?? request.toolId
  return `AGENT REQUESTS · ${verb} (${RISK_TEXT[request.risk]})`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return ''
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}s`
}

/** Classifies each line of a unified diff for colouring. */
export function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'context' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}

export const RUN_STATUS_TEXT: Record<AgentRunStatus, string> = {
  running: 'running',
  completed: 'finished',
  failed: 'failed',
  cancelled: 'stopped',
  step_limit: 'step limit reached',
  timeout: 'time limit reached',
}

export function runNeedsAttention(status: AgentRunStatus): boolean {
  return status === 'failed' || status === 'timeout' || status === 'step_limit'
}

/** Anything in the report worth a block? (an empty Plan run shouldn't draw an empty report). */
export function reportHasContent(report: RunReport | null): boolean {
  if (!report) return false
  return (
    report.filesInspected.length > 0 ||
    report.filesChanged.length > 0 ||
    report.changedByCommands.length > 0 ||
    report.commands.length > 0 ||
    report.refused.length > 0 ||
    report.modelConcerns !== null ||
    report.stoppedBy !== 'finished'
  )
}

export const STOPPED_BY_TEXT: Record<RunReport['stoppedBy'], string> = {
  finished: 'finished normally',
  step_limit: 'stopped at the step limit',
  timeout: 'stopped at the time limit',
  cancelled: 'stopped by you',
  error: 'ended with an error',
}

/** Total +N -M over the files a run changed (reverted files count as zero). */
export function totalChanges(files: { added: number; removed: number; reverted?: boolean }[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const f of files) {
    if (f.reverted) continue
    added += f.added
    removed += f.removed
  }
  return { added, removed }
}
