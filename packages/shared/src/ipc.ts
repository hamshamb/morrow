import type { AppSettings, AppSettingsPartial } from './settings'
import type { CreateWorkspaceInput, UpdateWorkspaceInput, Workspace } from './workspace'
import type {
  AddProviderConfigInput,
  LocalProviderStatus,
  ProviderConfigSummary,
  ProviderRegistryEntry,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from './provider'
import type { ProviderModelCatalog, RefreshModelCatalogResult } from './model-catalog'
import type { ModelsMetadataStatus, RefreshModelsMetadataResult } from './model-metadata'
import type {
  ChatStreamEvent,
  Conversation,
  CreateConversationInput,
  Message,
  SendMessageInput,
  UpdateConversationInput,
} from './conversation'
import type { AttachFilesResult } from './attachment'
import type {
  IndexWorkspaceFilesResult,
  WorkspaceFileIndexEntry,
  WorkspaceFileRoot,
  WorkspaceFileSearchResult,
} from './workspace-file'
import type { ContextInspectorState, GetContextInspectorInput } from './context'
import type {
  CreateTerminalInput,
  FsListDirInput,
  FsListDirResult,
  FsListPathsResult,
  FsReadInput,
  FsReadResult,
  FsSearchTextInput,
  FsSearchTextResult,
  FsWriteInput,
  FsWriteResult,
  GitCommitInput,
  GitCommitSummary,
  GitDiffInput,
  GitDiffResult,
  GitPathsInput,
  GitStatus,
  TerminalEvent,
  TerminalInfo,
  TerminalResizeInput,
} from './code'
import type {
  ApplySuggestionsInput,
  AutoChatInput,
  CompareInput,
  OrchestrationResult,
  OrchestrationStreamEvent,
  RetryReplyInput,
  ReviewInput,
  RoundTableInput,
} from './orchestration'

/**
 * Single source of truth for the renderer<->main IPC surface. The preload
 * script implements exactly this shape via contextBridge; the renderer only
 * ever sees `window.api` typed as `RendererApi`. No ad hoc `ipcRenderer.invoke`
 * calls are allowed outside preload.
 */
export interface RendererApi {
  workspaces: {
    list(): Promise<Workspace[]>
    get(id: string): Promise<Workspace | null>
    create(input: CreateWorkspaceInput): Promise<Workspace>
    update(input: UpdateWorkspaceInput): Promise<Workspace>
    delete(id: string): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(partial: AppSettingsPartial): Promise<AppSettings>
  }
  app: {
    getVersion(): Promise<string>
  }
  conversations: {
    list(workspaceId: string): Promise<Conversation[]>
    create(input: CreateConversationInput): Promise<Conversation>
    rename(input: UpdateConversationInput): Promise<Conversation>
    delete(id: string): Promise<void>
    listMessages(conversationId: string): Promise<Message[]>
  }
  providerConfigs: {
    list(): Promise<ProviderConfigSummary[]>
    add(input: AddProviderConfigInput): Promise<ProviderConfigSummary>
    remove(id: string): Promise<void>
    test(input: TestProviderConfigInput): Promise<TestProviderConfigResult>
  }
  providers: {
    /** Every provider the app can run (models.dev providers it has an SDK or
     * OpenAI-compatible route for, plus Ollama and a custom endpoint), most
     * popular first. Data-driven: reflects the current metadata catalog. */
    registry(): Promise<ProviderRegistryEntry[]>
    /** Probes localhost for Ollama (and other local OpenAI-compatible servers)
     * with a short timeout. Never throws; a stopped server is `running: false`. */
    detectLocal(): Promise<LocalProviderStatus[]>
  }
  modelsMetadata: {
    /** Where the models.dev catalog currently comes from; no network call. */
    status(): Promise<ModelsMetadataStatus>
    /** Re-downloads the models.dev catalog now (reports `ok: false` without
     * touching the network when the fetch is turned off in Settings). */
    refresh(): Promise<RefreshModelsMetadataResult>
    /** Fires when a download replaced the catalog (the startup refresh runs
     * in the background), so the registry and model lists can be re-read.
     * Returns an unsubscribe function. */
    onChange(listener: () => void): () => void
  }
  modelCatalog: {
    /** The model list for one provider config: the provider's live list when
     * one has been fetched, else models.dev's list for that provider, each
     * entry enriched with models.dev metadata. Never triggers a network call
     * — see `refresh` for that. */
    list(providerConfigId: string): Promise<ProviderModelCatalog>
    /** Calls the provider's real models-list endpoint, caches the result,
     * and returns it. `ok: false` on failure, with the previously-cached
     * (possibly stale, possibly empty) catalog still returned so the UI has
     * something to show. */
    refresh(providerConfigId: string): Promise<RefreshModelCatalogResult>
  }
  chat: {
    /** Resolves once the assistant message is persisted (or errored/cancelled). */
    sendMessage(input: SendMessageInput): Promise<Message>
    cancel(requestId: string): Promise<void>
    /**
     * Subscribes to streaming deltas for one in-flight request. The caller
     * must subscribe *before* invoking `sendMessage` with the same
     * `requestId` to avoid missing the first chunk. Returns an unsubscribe
     * function.
     */
    onStreamEvent(requestId: string, listener: (event: ChatStreamEvent) => void): () => void
    /** Computes what the Context Inspector should show for a not-yet-sent
     * turn — see ContextInspectorStateSchema. */
    getContextInspector(input: GetContextInspectorInput): Promise<ContextInspectorState>

    // --- Phase 6 orchestration (ADR-027): one prompt, several models. All
    // additive; `sendMessage` is untouched for the default single-model chat.

    /** COMPARE: one prompt to 2-4 models in parallel. Each target streams on its
     * own `chat:stream:${requestId}` channel (the same events as `sendMessage`)
     * and is cancellable alone (`cancel(requestId)`) or together
     * (`cancelOrchestration(orchestrationId)`). One column failing never stops
     * the others. Resolves when every column is persisted. */
    compare(input: CompareInput): Promise<OrchestrationResult>
    /** REVIEW: the primary model answers, then the reviewer produces a report as
     * a separate message. The primary answer is never modified. Progress is
     * pushed on `orchestrationStreamChannel(orchestrationId)`. */
    review(input: ReviewInput): Promise<OrchestrationResult>
    /** `[apply suggestions]`: asks the primary model for a revised answer,
     * stored as a NEW sibling reply (role REVISED) — never an in-place edit. */
    applySuggestions(input: ApplySuggestionsInput): Promise<OrchestrationResult>
    /** ROUND TABLE: user-ordered turns (proposal / critique / alternative, then
     * an optional synthesis), at most `ROUND_TABLE_MAX_ROUNDS` rounds — the cap
     * is enforced in the main process, not just the UI. */
    roundTable(input: RoundTableInput): Promise<OrchestrationResult>
    /** AUTO: the main process picks a model with deterministic rules
     * (`pickAutoModel`); the reply carries `autoReason`. Streams like `sendMessage`. */
    auto(input: AutoChatInput): Promise<Message>
    /** Runs a failed/cancelled reply again (optionally on another model); the
     * failed message is replaced by the new one in the same reply group. */
    retryReply(input: RetryReplyInput): Promise<Message>
    /** `[continue with this]`: makes this reply the one later turns see; the
     * other replies in its group stay visible and persisted but leave the
     * context. Returns the whole updated group. */
    setInContext(messageId: string): Promise<Message[]>
    /** One action stops everything an orchestration is running or about to run. */
    cancelOrchestration(orchestrationId: string): Promise<void>
    /** Subscribes to review / round-table progress; subscribe before invoking. */
    onOrchestrationEvent(
      orchestrationId: string,
      listener: (event: OrchestrationStreamEvent) => void,
    ): () => void
  }
  attachments: {
    /** Opens a native multi-select file picker and reads each chosen file
     * (supported-extension allowlist, MAX_ATTACHMENT_BYTES, no binaries).
     * Files that can't be attached come back in `rejected` with a reason
     * instead of failing the whole pick. Nothing is persisted until the
     * message is sent. Resolves to null if the user cancels the picker. */
    pickFiles(): Promise<AttachFilesResult | null>
  }
  workspaceFiles: {
    getRoot(workspaceId: string): Promise<WorkspaceFileRoot | null>
    /** Opens a native folder picker, sets it as the workspace's file root,
     * and indexes it. Resolves to null if the user cancels the picker. */
    pickRoot(workspaceId: string): Promise<IndexWorkspaceFilesResult | null>
    /** Re-walks the already-configured root and replaces the index. */
    reindex(workspaceId: string): Promise<IndexWorkspaceFilesResult>
    list(workspaceId: string): Promise<WorkspaceFileIndexEntry[]>
    search(workspaceId: string, query: string): Promise<WorkspaceFileSearchResult[]>
  }

  // --- Phase 4 code workspace (ADR-033…037). Every call names a workspace
  // and a RELATIVE path; the main process resolves it against the workspace
  // root and rejects absolute paths, `..`, symlink escapes and secrets.

  fs: {
    /** One directory level (lazy tree). `relativePath` '' is the root. Applies
     * the indexer's deny-list + .gitignore. */
    listDir(input: FsListDirInput): Promise<FsListDirResult>
    /** Opens a file for editing — or reports why it can't be shown
     * (binary / too large / denied / missing). */
    readFile(input: FsReadInput): Promise<FsReadResult>
    /** Atomic save (temp file + rename) guarded by the hash from the read.
     * Resolves `conflict` instead of overwriting a file edited elsewhere. */
    writeFile(input: FsWriteInput): Promise<FsWriteResult>
    /** Every visible file path in the workspace (bounded) — feeds quick open. */
    listPaths(workspaceId: string): Promise<FsListPathsResult>
    /** Case-insensitive substring search over file contents, with line numbers
     * (bounded scan; see ADR-034). */
    searchText(input: FsSearchTextInput): Promise<FsSearchTextResult>
    /** Shows the file in the OS file manager (never opens/executes it). */
    reveal(workspaceId: string, relativePath: string): Promise<void>
  }
  git: {
    status(workspaceId: string): Promise<GitStatus>
    /** Both sides of a file's change as text, for the diff editor. */
    diff(input: GitDiffInput): Promise<GitDiffResult>
    stage(input: GitPathsInput): Promise<void>
    unstage(input: GitPathsInput): Promise<void>
    stageAll(workspaceId: string): Promise<void>
    unstageAll(workspaceId: string): Promise<void>
    /** `git commit -m` of whatever is staged. Rejects an empty message or an empty index. */
    commit(input: GitCommitInput): Promise<GitCommitSummary>
  }
  terminal: {
    /** Starts a shell in the workspace root — only ever called from a user action. */
    create(input: CreateTerminalInput): Promise<TerminalInfo>
    list(workspaceId: string): Promise<TerminalInfo[]>
    /** Output the terminal produced so far (bounded) — to repaint after a renderer reload. */
    getBuffer(id: string): Promise<string>
    write(id: string, data: string): Promise<void>
    resize(input: TerminalResizeInput): Promise<void>
    kill(id: string): Promise<void>
    /** Output + exit notifications for every terminal. Returns an unsubscribe function. */
    onEvent(listener: (event: TerminalEvent) => void): () => void
  }
}

export const IPC_CHANNELS = {
  workspacesList: 'workspace:list',
  workspacesGet: 'workspace:get',
  workspacesCreate: 'workspace:create',
  workspacesUpdate: 'workspace:update',
  workspacesDelete: 'workspace:delete',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  appGetVersion: 'app:get-version',
  conversationsList: 'conversation:list',
  conversationsCreate: 'conversation:create',
  conversationsRename: 'conversation:rename',
  conversationsDelete: 'conversation:delete',
  messagesList: 'message:list',
  providerConfigsList: 'provider-config:list',
  providerConfigsAdd: 'provider-config:add',
  providerConfigsRemove: 'provider-config:remove',
  providerConfigsTest: 'provider-config:test',
  providersRegistry: 'providers:registry',
  providersDetectLocal: 'providers:detect-local',
  modelsMetadataStatus: 'models-metadata:status',
  modelsMetadataRefresh: 'models-metadata:refresh',
  /** main -> renderer push (not an invoke channel). */
  modelsMetadataChanged: 'models-metadata:changed',
  modelCatalogList: 'model-catalog:list',
  modelCatalogRefresh: 'model-catalog:refresh',
  chatSendMessage: 'chat:send-message',
  chatCancel: 'chat:cancel',
  chatGetContextInspector: 'chat:get-context-inspector',
  chatCompare: 'chat:compare',
  chatReview: 'chat:review',
  chatApplySuggestions: 'chat:apply-suggestions',
  chatRoundTable: 'chat:round-table',
  chatAuto: 'chat:auto',
  chatRetryReply: 'chat:retry-reply',
  chatSetInContext: 'chat:set-in-context',
  chatCancelOrchestration: 'chat:cancel-orchestration',
  attachmentsPickFiles: 'attachment:pick-files',
  workspaceFilesGetRoot: 'workspace-file:get-root',
  workspaceFilesPickRoot: 'workspace-file:pick-root',
  workspaceFilesReindex: 'workspace-file:reindex',
  workspaceFilesList: 'workspace-file:list',
  workspaceFilesSearch: 'workspace-file:search',
  fsListDir: 'fs:list-dir',
  fsReadFile: 'fs:read-file',
  fsWriteFile: 'fs:write-file',
  fsListPaths: 'fs:list-paths',
  fsSearchText: 'fs:search-text',
  fsReveal: 'fs:reveal',
  gitStatus: 'git:status',
  gitDiff: 'git:diff',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitStageAll: 'git:stage-all',
  gitUnstageAll: 'git:unstage-all',
  gitCommit: 'git:commit',
  terminalCreate: 'terminal:create',
  terminalList: 'terminal:list',
  terminalGetBuffer: 'terminal:get-buffer',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',
  /** main -> renderer push (not an invoke channel). */
  terminalEvent: 'terminal:event',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

/**
 * Streaming responses go from main -> renderer over a dedicated event
 * channel per in-flight request (`webContents.send`), rather than a single
 * shared channel multiplexing all requests. See ADR-008.
 */
export function chatStreamChannel(requestId: string): string {
  return `chat:stream:${requestId}`
}

/** Review / round-table progress goes main -> renderer on one channel per
 * orchestration (steps are decided server-side, so the renderer cannot
 * pre-allocate a request id per step). Compare columns keep ADR-008's
 * per-request channels. See ADR-027. */
export function orchestrationStreamChannel(orchestrationId: string): string {
  return `chat:orchestrate:${orchestrationId}`
}
