import { z } from 'zod'
import { ContextSelectionSchema } from './context'
import { ReasoningEffortSchema } from './model-metadata'

/**
 * Phase 5 - AI coding tools, the permission engine and the agent loop
 * (ADR-040 ... ADR-045). Everything the renderer and the main process agree on
 * lives here: ids, risk classes, the audit/permission/report shapes, the
 * events that stream out of a run, and the limits. The main process is the
 * only enforcer of every rule below - the renderer only displays.
 */

// ---------------------------------------------------------------- tools

export const TOOL_IDS = [
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'filesystem.write',
  'filesystem.patch',
  'git.status',
  'git.diff',
  'git.log',
  'terminal.execute',
  'workspace.search',
] as const
export const ToolIdSchema = z.enum(TOOL_IDS)
export type ToolId = z.infer<typeof ToolIdSchema>

/** safe: reads only. write: changes workspace files. execution: runs a program. network: reaches the network. destructive: can lose data or code. */
export const TOOL_RISKS = ['safe', 'write', 'execution', 'network', 'destructive'] as const
export const ToolRiskSchema = z.enum(TOOL_RISKS)
export type ToolRisk = z.infer<typeof ToolRiskSchema>

/** The wire name providers see: both Anthropic and OpenAI reject dots in tool names. */
export function toolWireName(id: ToolId): string {
  return id.replace('.', '_')
}

// ---------------------------------------------------------------- modes and limits

/** plan: read-only tools (terminal asks every time). build: every tool, under the permission engine. */
export const AgentModeSchema = z.enum(['plan', 'build'])
export type AgentMode = z.infer<typeof AgentModeSchema>

export const AGENT_LIMITS = {
  maxSteps: { default: 25, min: 1, hardCap: 100 },
  maxWallSeconds: { default: 1200, min: 30, hardCap: 7200 },
  commandTimeoutSeconds: { default: 120, min: 5, hardCap: 900 },
} as const

/** Tool outputs larger than this are cut (tail kept for commands, head for files) before they reach the model. */
export const TOOL_OUTPUT_CHAR_CAP = 30_000
/** `filesystem.write` refuses to overwrite an existing file larger than this - use `filesystem.patch` (ADR-043). */
export const WRITE_OVERWRITE_MAX_BYTES = 20_000
/** Largest file the agent can create/overwrite in one call. */
export const AGENT_WRITE_MAX_BYTES = 1024 * 1024
/** Command output kept per run of `terminal.execute` (tail). */
export const COMMAND_OUTPUT_CAP_BYTES = 256 * 1024

export const AgentLimitsSchema = z.object({
  maxSteps: z.number().int().min(AGENT_LIMITS.maxSteps.min).max(AGENT_LIMITS.maxSteps.hardCap),
  maxWallSeconds: z.number().int().min(AGENT_LIMITS.maxWallSeconds.min).max(AGENT_LIMITS.maxWallSeconds.hardCap),
  commandTimeoutSeconds: z
    .number()
    .int()
    .min(AGENT_LIMITS.commandTimeoutSeconds.min)
    .max(AGENT_LIMITS.commandTimeoutSeconds.hardCap),
})
export type AgentLimits = z.infer<typeof AgentLimitsSchema>

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxSteps: AGENT_LIMITS.maxSteps.default,
  maxWallSeconds: AGENT_LIMITS.maxWallSeconds.default,
  commandTimeoutSeconds: AGENT_LIMITS.commandTimeoutSeconds.default,
}

/** Clamps anything (including a hand-edited settings value) into the allowed ranges. */
export function clampAgentLimits(input: Partial<Record<keyof AgentLimits, number>> | null | undefined): AgentLimits {
  const clamp = (value: number | undefined, spec: { default: number; min: number; hardCap: number }): number => {
    if (value === undefined || !Number.isFinite(value)) return spec.default
    return Math.min(spec.hardCap, Math.max(spec.min, Math.round(value)))
  }
  return {
    maxSteps: clamp(input?.maxSteps, AGENT_LIMITS.maxSteps),
    maxWallSeconds: clamp(input?.maxWallSeconds, AGENT_LIMITS.maxWallSeconds),
    commandTimeoutSeconds: clamp(input?.commandTimeoutSeconds, AGENT_LIMITS.commandTimeoutSeconds),
  }
}

// ---------------------------------------------------------------- permissions

export const PermissionDecisionSchema = z.enum(['allow_once', 'allow_session', 'allow_workspace', 'deny'])
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>

/** Who or what let a tool call run (or stopped it). Stored in the audit log. */
export const DecisionSourceSchema = z.enum([
  'default-safe', // a `safe` tool: no prompt by design
  'prompt-once',
  'prompt-session',
  'prompt-workspace',
  'session-grant',
  'workspace-grant',
  'prompt-deny',
  'mode-blocked', // the tool is not available in this mode / for this agent
  'cancelled', // the run ended while the prompt was open
  'not-asked', // failed validation / preparation before any prompt
])
export type DecisionSource = z.infer<typeof DecisionSourceSchema>

/** What the prompt shows - exactly what will happen. */
export const PermissionPreviewSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    command: z.string(),
    cwd: z.string(),
    shell: z.string(),
    timeoutSeconds: z.number(),
    reasons: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('patch'),
    path: z.string(),
    diff: z.string(),
    added: z.number(),
    removed: z.number(),
  }),
  z.object({
    kind: z.literal('write'),
    path: z.string(),
    /** true when the file does not exist yet. */
    isNew: z.boolean(),
    diff: z.string(),
    added: z.number(),
    removed: z.number(),
    sizeBytes: z.number(),
  }),
  z.object({ kind: z.literal('other'), description: z.string() }),
])
export type PermissionPreview = z.infer<typeof PermissionPreviewSchema>

export const PermissionRequestSchema = z.object({
  /** Unguessable, single use, valid only while the run is alive. */
  requestId: z.string(),
  runId: z.string(),
  toolRunId: z.string(),
  conversationId: z.string(),
  workspaceId: z.string(),
  toolId: ToolIdSchema,
  risk: ToolRiskSchema,
  /** The decisions the main process will accept for this request. `destructive` and no-grant requests only allow once / deny. */
  allowedDecisions: z.array(PermissionDecisionSchema),
  /** What a session / workspace grant would cover, in words (e.g. "this exact command"). */
  grantScopeNote: z.string().nullable(),
  preview: PermissionPreviewSchema,
  createdAt: z.number(),
})
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>

export const RespondPermissionInputSchema = z.object({
  requestId: z.string().min(1).max(200),
  decision: PermissionDecisionSchema,
})
export type RespondPermissionInput = z.infer<typeof RespondPermissionInputSchema>

export const RespondPermissionResultSchema = z.object({
  ok: z.boolean(),
  /** Why a response was not accepted (unknown/expired request, decision not allowed, ...). */
  reason: z.string().nullable(),
})
export type RespondPermissionResult = z.infer<typeof RespondPermissionResultSchema>

export const PermissionGrantSchema = z.object({
  id: z.string(),
  /** session = until the app closes, for one conversation; workspace = stored, until revoked. */
  scope: z.enum(['session', 'workspace']),
  workspaceId: z.string(),
  /** The conversation a session grant belongs to. */
  conversationId: z.string().nullable(),
  toolId: ToolIdSchema,
  risk: ToolRiskSchema,
  /** The exact command (terminal grants only). */
  command: z.string().nullable(),
  createdAt: z.number(),
})
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>

// ---------------------------------------------------------------- audit

export const ToolRunStatusSchema = z.enum(['pending', 'running', 'ok', 'error', 'denied', 'cancelled'])
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>

/** One row of the audit trail (`tool_runs`) as the UI sees it. */
export const ToolRunSchema = z.object({
  id: z.string(),
  runId: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  seq: z.number(),
  step: z.number(),
  toolId: ToolIdSchema,
  risk: ToolRiskSchema,
  /** `read src/x.ts` - what the activity row says. */
  label: z.string(),
  /** `4 matches`, `+12 -4`, `exit 0 - 4.3s` - the right-hand part of the row. */
  summary: z.string(),
  /** Redacted input JSON. */
  input: z.string(),
  /** Redacted diff / command output tail, for the collapsible details. */
  detail: z.string().nullable(),
  status: ToolRunStatusSchema,
  decisionSource: DecisionSourceSchema.nullable(),
  exitCode: z.number().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
})
export type ToolRun = z.infer<typeof ToolRunSchema>

// ---------------------------------------------------------------- report (built from the audit log, never by the model)

export const ReportFileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['created', 'modified']),
  added: z.number(),
  removed: z.number(),
  /** The file on disk was re-read after the run and matches the agent's last write. */
  verified: z.boolean(),
  /** Why it is not verified / anything the reader should know. */
  note: z.string().nullable(),
  reverted: z.boolean(),
})
export type ReportFileChange = z.infer<typeof ReportFileChangeSchema>

export const ReportCommandSchema = z.object({
  command: z.string(),
  exitCode: z.number().nullable(),
  status: ToolRunStatusSchema,
  durationMs: z.number().nullable(),
  isTest: z.boolean(),
  note: z.string().nullable(),
})
export type ReportCommand = z.infer<typeof ReportCommandSchema>

export const ReportTestsSchema = z.object({
  status: z.enum(['passed', 'failed', 'not_run', 'unverified']),
  command: z.string().nullable(),
  exitCode: z.number().nullable(),
  /** Files changed after the last test run - the result does not cover them. */
  editsAfterTests: z.boolean(),
  detail: z.string(),
})
export type ReportTests = z.infer<typeof ReportTestsSchema>

export const RunReportSchema = z.object({
  filesInspected: z.array(z.string()),
  filesChanged: z.array(ReportFileChangeSchema),
  /** Paths that appeared as changed in the working tree during the run but were NOT written by the edit
   * tools (a command did it). Best effort: needs a repository; not tracked for revert. */
  changedByCommands: z.array(z.string()).default([]),
  commands: z.array(ReportCommandSchema),
  tests: ReportTestsSchema,
  /** Actions the user denied or the engine blocked. */
  refused: z.array(z.object({ label: z.string(), reason: z.string() })),
  toolCalls: z.number(),
  toolErrors: z.number(),
  stoppedBy: z.enum(['finished', 'step_limit', 'timeout', 'cancelled', 'error']),
  /** The model's own words after a "Remaining concerns" heading; null when it wrote none. Not verified. */
  modelConcerns: z.string().nullable(),
})
export type RunReport = z.infer<typeof RunReportSchema>

// ---------------------------------------------------------------- runs

export const AgentRunStatusSchema = z.enum(['running', 'completed', 'failed', 'cancelled', 'step_limit', 'timeout'])
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>

export const AgentRunSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  userMessageId: z.string().nullable(),
  assistantMessageId: z.string().nullable(),
  mode: AgentModeSchema,
  agentId: z.string(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  status: AgentRunStatusSchema,
  steps: z.number(),
  maxSteps: z.number(),
  errorText: z.string().nullable(),
  report: RunReportSchema.nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
})
export type AgentRun = z.infer<typeof AgentRunSchema>

/** A run with its activity, for rebuilding the thread. */
export const AgentRunDetailSchema = AgentRunSchema.extend({
  toolRuns: z.array(ToolRunSchema),
})
export type AgentRunDetail = z.infer<typeof AgentRunDetailSchema>

export const RunAgentInputSchema = z.object({
  /** Also the cancel key and the suffix of the event channel. */
  runId: z.string().min(1).max(100),
  conversationId: z.string().min(1),
  content: z.string().min(1).max(100_000),
  mode: AgentModeSchema,
  agentId: z.string().min(1).max(100).optional(),
  providerConfigId: z.string().min(1),
  model: z.string().min(1),
  effort: ReasoningEffortSchema.nullable().optional(),
  contextSelection: ContextSelectionSchema.optional(),
})
export type RunAgentInput = z.infer<typeof RunAgentInputSchema>

// ---------------------------------------------------------------- changes (right panel)

export const ChangedFileSchema = z.object({
  path: z.string(),
  kind: z.enum(['created', 'modified']),
  added: z.number(),
  removed: z.number(),
  reverted: z.boolean(),
  /** The file on disk no longer matches the agent's last write (someone edited it since). */
  changedSince: z.boolean(),
})
export type ChangedFile = z.infer<typeof ChangedFileSchema>

export const AgentFileDiffSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), path: z.string(), original: z.string(), modified: z.string() }),
  z.object({ status: z.literal('unavailable'), path: z.string(), message: z.string() }),
])
export type AgentFileDiff = z.infer<typeof AgentFileDiffSchema>

export const RevertInputSchema = z.object({
  runId: z.string().min(1),
  /** Omitted = revert every file the run changed. */
  path: z.string().min(1).max(4096).optional(),
  /** Revert even though the file changed after the agent's last write (the user confirmed). */
  force: z.boolean().optional(),
})
export type RevertInput = z.infer<typeof RevertInputSchema>

export const RevertResultSchema = z.object({
  reverted: z.array(z.string()),
  /** Files left alone, with the reason (e.g. changed since the agent's write). */
  skipped: z.array(z.object({ path: z.string(), reason: z.string(), changedSince: z.boolean() })),
})
export type RevertResult = z.infer<typeof RevertResultSchema>

// ---------------------------------------------------------------- events (main -> renderer)

export type AgentEvent =
  | { type: 'run-start'; run: AgentRun }
  | { type: 'step'; runId: string; step: number }
  | { type: 'text-delta'; runId: string; delta: string }
  | { type: 'tool'; runId: string; toolRun: ToolRun }
  /** Live output of a running command (already redacted), appended to its details and the Agent output tab. */
  | { type: 'tool-output'; runId: string; toolRunId: string; chunk: string }
  | { type: 'permission-request'; request: PermissionRequest }
  | { type: 'permission-resolved'; requestId: string; runId: string }
  | { type: 'run-end'; run: AgentRun; detail: AgentRunDetail }

// ---------------------------------------------------------------- agents (definitions are data)

export const AGENT_PERMISSION_CEILINGS = ['read-only', 'build'] as const
export const AgentPermissionCeilingSchema = z.enum(AGENT_PERMISSION_CEILINGS)
export type AgentPermissionCeiling = z.infer<typeof AgentPermissionCeilingSchema>

export const AgentContextPolicySchema = z.enum(['conversation', 'task-only'])
export type AgentContextPolicy = z.infer<typeof AgentContextPolicySchema>

export const AgentDefinitionSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  /** Added to the base agent prompt (which carries the safety rules and cannot be edited away). */
  instructions: z.string().max(8000),
  /** Optional model preference; null = use whatever the composer has selected. */
  modelPreference: z.object({ providerConfigId: z.string().nullable(), model: z.string().nullable() }).nullable(),
  allowedTools: z.array(ToolIdSchema),
  /** The highest the agent can go: `read-only` agents never get a write or execution tool, even in Build mode. */
  permissionCeiling: AgentPermissionCeilingSchema,
  /** conversation = earlier turns are sent too; task-only = just this request. */
  contextPolicy: AgentContextPolicySchema,
  builtin: z.boolean(),
})
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>

/** What a user may change about an agent (stored in settings, merged over the built-in definition). */
export const AgentOverrideSchema = z.object({
  instructions: z.string().max(8000).optional(),
  modelPreference: z.object({ providerConfigId: z.string().nullable(), model: z.string().nullable() }).nullable().optional(),
})
export type AgentOverride = z.infer<typeof AgentOverrideSchema>

export const UpdateAgentInputSchema = z.object({ agentId: z.string().min(1), override: AgentOverrideSchema.nullable() })
export type UpdateAgentInput = z.infer<typeof UpdateAgentInputSchema>

export const READ_ONLY_TOOLS: readonly ToolId[] = [
  'filesystem.read',
  'filesystem.list',
  'filesystem.search',
  'workspace.search',
  'git.status',
  'git.diff',
  'git.log',
]

export const ALL_TOOLS: readonly ToolId[] = TOOL_IDS

/**
 * The agents shipped with the app. They are data, not UI: Settings -> Agents
 * lists whatever this returns merged with the user's overrides, and the agent
 * service builds each run's tool set from `allowedTools` + `permissionCeiling`
 * + the mode - in the main process.
 */
export const BUILTIN_AGENTS: readonly AgentDefinition[] = [
  {
    id: 'general',
    name: 'General Assistant',
    description: 'Everyday coding help: inspects, edits and runs commands when asked.',
    instructions:
      'You are a pragmatic software engineer. Prefer small, targeted changes. Explain what you are about to do in one short sentence before using a tool.',
    modelPreference: null,
    allowedTools: [...ALL_TOOLS],
    permissionCeiling: 'build',
    contextPolicy: 'conversation',
    builtin: true,
  },
  {
    id: 'repo-analyst',
    name: 'Repository Analyst',
    description: 'Explores the repository and explains how it works. Read-only.',
    instructions:
      'You analyse the repository without changing it. Map the structure, trace how the pieces connect, and cite file paths and line numbers for every claim. Say plainly what you could not verify.',
    modelPreference: null,
    allowedTools: [...READ_ONLY_TOOLS],
    permissionCeiling: 'read-only',
    contextPolicy: 'conversation',
    builtin: true,
  },
  {
    id: 'planner',
    name: 'Planner',
    description: 'Investigates and produces a step-by-step plan. Never edits. Read-only.',
    instructions:
      'You produce an implementation plan and nothing else. Read the relevant code first, then give an ordered list of concrete steps with the files to change, the risks, and how to test each step. Do not attempt to make changes.',
    modelPreference: null,
    allowedTools: [...READ_ONLY_TOOLS],
    permissionCeiling: 'read-only',
    contextPolicy: 'conversation',
    builtin: true,
  },
  {
    id: 'implementer',
    name: 'Implementer',
    description: 'Makes the change: edits files and runs the tests, under your approval.',
    instructions:
      'You implement the requested change. Read before you edit, edit with filesystem.patch whenever possible, then run the relevant tests and inspect the diff. Stop and report if something blocks you rather than working around it.',
    modelPreference: null,
    allowedTools: [...ALL_TOOLS],
    permissionCeiling: 'build',
    contextPolicy: 'conversation',
    builtin: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews changes for bugs, risks and missing tests. Read-only.',
    instructions:
      'You review code. Look at the current diff and the surrounding code, then list concrete findings ordered by severity, each with a file and line and why it matters. Do not rewrite the code.',
    modelPreference: null,
    allowedTools: [...READ_ONLY_TOOLS],
    permissionCeiling: 'read-only',
    contextPolicy: 'conversation',
    builtin: true,
  },
  {
    id: 'test-engineer',
    name: 'Test Engineer',
    description: 'Writes and runs tests, and diagnoses failures.',
    instructions:
      'You are responsible for tests. Reproduce failures first by running the tests, find the cause, then add or fix tests and code with minimal edits, and run the tests again. Report the exact command and its result.',
    modelPreference: null,
    allowedTools: [...ALL_TOOLS],
    permissionCeiling: 'build',
    contextPolicy: 'conversation',
    builtin: true,
  },
]

/** Default agent for each composer mode. */
export const DEFAULT_AGENT_FOR_MODE: Record<AgentMode, string> = { plan: 'planner', build: 'implementer' }

/**
 * The tools a run may use: the agent's allow-list, cut down by its ceiling and
 * by the mode. Pure, so the main process (the enforcer) and the UI (which only
 * explains) can share it. A `read-only` ceiling never gets a write/execution
 * tool; Plan mode only adds `terminal.execute` (which then asks every time).
 */
export function effectiveTools(
  agent: Pick<AgentDefinition, 'allowedTools' | 'permissionCeiling'>,
  mode: AgentMode,
): ToolId[] {
  const allowed = new Set<ToolId>(agent.allowedTools)
  return TOOL_IDS.filter((id) => {
    if (!allowed.has(id)) return false
    if (READ_ONLY_TOOLS.includes(id)) return true
    if (agent.permissionCeiling === 'read-only') return false
    if (mode === 'plan') return id === 'terminal.execute'
    return true
  })
}

/** Merges the user's overrides over the built-in definitions. */
export function resolveAgents(overrides: Record<string, AgentOverride> | undefined): AgentDefinition[] {
  return BUILTIN_AGENTS.map((agent) => {
    const override = overrides?.[agent.id]
    if (!override) return agent
    return {
      ...agent,
      ...(override.instructions !== undefined ? { instructions: override.instructions } : {}),
      ...(override.modelPreference !== undefined ? { modelPreference: override.modelPreference } : {}),
    }
  })
}

/** Plan/Build need a model that supports tool calls. Unknown metadata is allowed (custom endpoints); an explicit `tool_call: false` is not. */
export function toolSupportOf(meta: { toolCall: boolean } | null | undefined): 'yes' | 'no' | 'unknown' {
  if (!meta) return 'unknown'
  return meta.toolCall ? 'yes' : 'no'
}
