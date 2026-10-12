import type { z } from 'zod'
import type { AgentLimits, AgentMode, PermissionPreview, ToolId, ToolRisk, WorkspaceFileSearchResult } from '@ai-workspace/shared'
import type { CodeFileService } from '../../code/file-service'
import type { GitService } from '../../code/git-service'
import type { AgentShell } from '../command-runner'

/** An expected failure (bad input, stale file, no match, refused path). Becomes an error result the model can act on. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ToolError'
  }
}

/** What a tool needs from the app - injected so the tools are unit-testable without Electron. */
export interface ToolServices {
  files: CodeFileService
  git: GitService
  /** Absolute workspace root, or null when none is set. */
  resolveRoot: (workspaceId: string) => string | null
  /** FTS search over the indexed workspace files. */
  indexSearch: (workspaceId: string, query: string, limit: number) => WorkspaceFileSearchResult[]
  shell: AgentShell
  /** Environment for commands (already scrubbed of credentials). */
  commandEnv: () => Record<string, string>
  limits: () => AgentLimits
}

/** Records the pre-edit state of a file so the user can revert it (first write per path per run wins). */
export interface SnapshotRecorder {
  record(input: { path: string; beforeContent: Buffer | null; beforeHash: string | null; afterHash: string }): void
}

export interface ToolContext {
  services: ToolServices
  workspaceId: string
  runId: string
  conversationId: string
  mode: AgentMode
  signal: AbortSignal
  /** Hash of each file the agent has read (or last wrote) in this run, by relative path. */
  reads: Map<string, string>
  snapshots: SnapshotRecorder
  /** Live output of a running command. */
  onOutput: (chunk: string) => void
}

/** What a tool says about the call before it runs (used for the permission decision and the prompt). */
export interface Assessment {
  risk: ToolRisk
  noGrant: boolean
  /** The exact command (terminal) - the grant key. */
  command: string | null
  grantScopeNote: string | null
}

export interface Prepared {
  preview: PermissionPreview
  /** Opaque to the framework; handed back to `run`. */
  state: unknown
}

export interface ToolResult {
  /** What the model is told (redacted by the framework). */
  text: string
  /** Right-hand part of the activity row: `4 matches`, `+12 -4`, `exit 0 - 4.3s`. */
  summary: string
  /** Collapsible details: a diff, command output (redacted by the framework). */
  detail?: string | null
  exitCode?: number | null
  /** The call failed or did nothing; the model is told so. */
  isError?: boolean
  /** The audit row is recorded as failed although the model got a normal result (a command that exited non-zero or timed out). */
  failed?: boolean
  /** The user (or the run ending) stopped it. */
  cancelled?: boolean
}

export interface ToolDefinition<I = unknown> {
  id: ToolId
  /** Shown to the model. */
  description: string
  inputSchema: z.ZodType<I>
  /** The risk class when the call is not further assessed (`terminal.execute` overrides it per command). */
  risk: ToolRisk
  /** `read src/x.ts` - the activity row label. */
  label(input: I): string
  assess?(input: I, ctx: ToolContext): Assessment | Promise<Assessment>
  /** Validates the call against the current disk state and builds the preview. Throws ToolError. No side effects. */
  prepare?(input: I, ctx: ToolContext): Promise<Prepared>
  run(input: I, ctx: ToolContext, prepared: Prepared | null): Promise<ToolResult>
}
