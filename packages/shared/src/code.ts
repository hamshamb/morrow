import { z } from 'zod'

/**
 * Phase 4 — code workspace contracts: repository files, git, terminals.
 * Every input here is validated in the main process (`ipc/code.ts` etc.);
 * the renderer only ever names a workspace + a *relative* path (ADR-033).
 */

// ============================== shared id / path primitives ==============================

export const WorkspaceIdSchema = z.string().min(1)
export const TerminalIdSchema = z.string().min(1)
export const RelativePathSchema = z.string().max(4096)
/** One IPC write to a terminal; keystrokes and pastes are far smaller. */
export const TerminalInputDataSchema = z.string().max(65_536)

// ============================== files ==============================

/** Files up to this size open editable. */
export const MAX_EDITABLE_FILE_BYTES = 1024 * 1024
/** Files above `MAX_EDITABLE_FILE_BYTES` and up to this open read-only; anything
 * larger shows a "too large — reveal in folder" state and is never read. */
export const MAX_OPEN_FILE_BYTES = 5 * 1024 * 1024
/** Directory listings are capped so one huge folder cannot flood the renderer. */
export const MAX_DIR_ENTRIES = 2000
/** Cap on the flat path list used by quick open. */
export const MAX_LISTED_PATHS = 20_000
export const MAX_SEARCH_RESULTS = 300
export const MAX_SEARCH_QUERY_CHARS = 200
/** Open tabs remembered per workspace. */
export const MAX_RESTORED_TABS = 30

export const FsEntrySchema = z.object({
  name: z.string(),
  /** POSIX-separated, relative to the workspace root. */
  relativePath: z.string(),
  kind: z.enum(['file', 'directory']),
  sizeBytes: z.number().nullable(),
})
export type FsEntry = z.infer<typeof FsEntrySchema>

export const FsListDirResultSchema = z.object({
  entries: z.array(FsEntrySchema),
  /** True when the directory had more than `MAX_DIR_ENTRIES` visible entries. */
  truncated: z.boolean(),
})
export type FsListDirResult = z.infer<typeof FsListDirResultSchema>

export const FsListDirInputSchema = z.object({
  workspaceId: z.string().min(1),
  /** '' = the workspace root. */
  relativePath: z.string().max(4096),
})
export type FsListDirInput = z.infer<typeof FsListDirInputSchema>

export const FsReadInputSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(4096),
})
export type FsReadInput = z.infer<typeof FsReadInputSchema>

export const FsReadResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    relativePath: z.string(),
    content: z.string(),
    /** sha256 of the file's bytes as read — echoed back as `expectedHash` on save. */
    hash: z.string(),
    mtimeMs: z.number(),
    sizeBytes: z.number(),
    readOnly: z.boolean(),
    readOnlyReason: z.string().nullable(),
    /** The file starts with a UTF-8 byte order mark (stripped from `content`; echo it back on save). */
    bom: z.boolean(),
  }),
  z.object({
    status: z.enum(['binary', 'too-large', 'denied', 'missing', 'not-a-file']),
    relativePath: z.string(),
    sizeBytes: z.number().nullable(),
    message: z.string(),
  }),
])
export type FsReadResult = z.infer<typeof FsReadResultSchema>

export const FsWriteInputSchema = z.object({
  workspaceId: z.string().min(1),
  relativePath: z.string().min(1).max(4096),
  content: z.string().max(MAX_OPEN_FILE_BYTES),
  /** The `hash` from the read this edit started from; `null` = creating a new file. */
  expectedHash: z.string().nullable(),
  /** Set only after the user chose "overwrite" in the conflict prompt. */
  overwrite: z.boolean().optional(),
  /** Re-add the UTF-8 byte order mark the file had when it was read. */
  bom: z.boolean().optional(),
})
export type FsWriteInput = z.infer<typeof FsWriteInputSchema>

export const FsWriteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), hash: z.string(), mtimeMs: z.number(), sizeBytes: z.number() }),
  z.object({
    status: z.literal('conflict'),
    /** changed: edited on disk since opened · deleted: gone from disk · exists: creating over an existing file. */
    reason: z.enum(['changed', 'deleted', 'exists']),
    currentHash: z.string().nullable(),
  }),
])
export type FsWriteResult = z.infer<typeof FsWriteResultSchema>

export const FsListPathsResultSchema = z.object({
  paths: z.array(z.string()),
  truncated: z.boolean(),
})
export type FsListPathsResult = z.infer<typeof FsListPathsResultSchema>

export const FsSearchTextInputSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1).max(MAX_SEARCH_QUERY_CHARS),
  caseSensitive: z.boolean().optional(),
  limit: z.number().int().positive().max(MAX_SEARCH_RESULTS).optional(),
})
export type FsSearchTextInput = z.infer<typeof FsSearchTextInputSchema>

export const FsSearchMatchSchema = z.object({
  relativePath: z.string(),
  /** 1-based. */
  line: z.number(),
  /** 1-based column of the match start. */
  column: z.number(),
  /** The matching line, trimmed and length-capped. */
  preview: z.string(),
})
export type FsSearchMatch = z.infer<typeof FsSearchMatchSchema>

export const FsSearchTextResultSchema = z.object({
  matches: z.array(FsSearchMatchSchema),
  filesScanned: z.number(),
  /** True when a result/file/byte/time budget stopped the scan early. */
  truncated: z.boolean(),
})
export type FsSearchTextResult = z.infer<typeof FsSearchTextResultSchema>

// ============================== code session (restored tabs) ==============================

export const CodeSessionSchema = z.object({
  openTabs: z.array(z.string().min(1).max(4096)).max(MAX_RESTORED_TABS),
  activeTab: z.string().max(4096).nullable(),
})
export type CodeSession = z.infer<typeof CodeSessionSchema>

// ============================== git ==============================

export const GIT_MAX_PATHS_PER_CALL = 500
export const GIT_MAX_COMMIT_MESSAGE_CHARS = 10_000

export const GitChangeStatusSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])
export type GitChangeStatus = z.infer<typeof GitChangeStatusSchema>

export const GitChangeSchema = z.object({
  /** Relative to the workspace root, POSIX-separated. */
  path: z.string(),
  /** The previous path for renames/copies. */
  origPath: z.string().nullable(),
  status: GitChangeStatusSchema,
  /** Lines added / removed; `null` for binary files and when unknown. */
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
  binary: z.boolean(),
  /** Matches the secrets deny-list — listed, but its content is never shown or staged in bulk. */
  protected: z.boolean(),
})
export type GitChange = z.infer<typeof GitChangeSchema>

export const GitBranchSchema = z.object({
  /** null when detached or on an unborn branch without a name. */
  head: z.string().nullable(),
  detached: z.boolean(),
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
})
export type GitBranch = z.infer<typeof GitBranchSchema>

export const GitCommitSummarySchema = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
})
export type GitCommitSummary = z.infer<typeof GitCommitSummarySchema>

export const GitStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('ok'),
    branch: GitBranchSchema,
    /** null on a repository with no commits yet. */
    commit: GitCommitSummarySchema.nullable(),
    staged: z.array(GitChangeSchema),
    unstaged: z.array(GitChangeSchema),
    untracked: z.array(GitChangeSchema),
    conflicted: z.array(GitChangeSchema),
    /** True when a very large status list was cut off. */
    truncated: z.boolean(),
  }),
  z.object({ state: z.literal('git-missing') }),
  z.object({ state: z.literal('not-a-repo') }),
  z.object({ state: z.literal('error'), message: z.string() }),
])
export type GitStatus = z.infer<typeof GitStatusSchema>

export const GitAreaSchema = z.enum(['staged', 'unstaged', 'untracked'])
export type GitArea = z.infer<typeof GitAreaSchema>

export const GitDiffInputSchema = z.object({
  workspaceId: z.string().min(1),
  path: z.string().min(1).max(4096),
  origPath: z.string().max(4096).nullable().optional(),
  area: GitAreaSchema,
})
export type GitDiffInput = z.infer<typeof GitDiffInputSchema>

export const GitDiffResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    original: z.string(),
    modified: z.string(),
    originalLabel: z.string(),
    modifiedLabel: z.string(),
  }),
  z.object({ status: z.enum(['binary', 'too-large', 'protected']), message: z.string() }),
])
export type GitDiffResult = z.infer<typeof GitDiffResultSchema>

export const GitPathsInputSchema = z.object({
  workspaceId: z.string().min(1),
  paths: z.array(z.string().min(1).max(4096)).min(1).max(GIT_MAX_PATHS_PER_CALL),
})
export type GitPathsInput = z.infer<typeof GitPathsInputSchema>

export const GitCommitInputSchema = z.object({
  workspaceId: z.string().min(1),
  message: z.string().max(GIT_MAX_COMMIT_MESSAGE_CHARS),
})
export type GitCommitInput = z.infer<typeof GitCommitInputSchema>

// ============================== terminal ==============================

export const MAX_TERMINALS = 8
export const TERMINAL_MAX_DIMENSION = 500

export const TerminalInfoSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** e.g. "PowerShell", "bash". */
  title: z.string(),
  shell: z.string(),
  cwd: z.string(),
  pid: z.number().nullable(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().nullable(),
  createdAt: z.number(),
})
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>

export const CreateTerminalInputSchema = z.object({
  workspaceId: z.string().min(1),
  cols: z.number().int().min(2).max(TERMINAL_MAX_DIMENSION),
  rows: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
})
export type CreateTerminalInput = z.infer<typeof CreateTerminalInputSchema>

export const TerminalResizeInputSchema = z.object({
  id: z.string().min(1),
  cols: z.number().int().min(2).max(TERMINAL_MAX_DIMENSION),
  rows: z.number().int().min(1).max(TERMINAL_MAX_DIMENSION),
})
export type TerminalResizeInput = z.infer<typeof TerminalResizeInputSchema>

export type TerminalEvent =
  | { type: 'data'; id: string; data: string }
  | { type: 'exit'; id: string; exitCode: number | null; signal: number | null }
