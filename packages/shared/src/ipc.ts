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
import type { PendingAttachment } from './attachment'
import type {
  IndexWorkspaceFilesResult,
  WorkspaceFileIndexEntry,
  WorkspaceFileRoot,
  WorkspaceFileSearchResult,
} from './workspace-file'
import type { ContextInspectorState, GetContextInspectorInput } from './context'

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
  }
  attachments: {
    /** Opens a native file picker, reads the chosen file (enforcing the
     * supported-extension allowlist and MAX_ATTACHMENT_BYTES), and returns
     * its content. Nothing is persisted until the message is actually sent.
     * Resolves to null if the user cancels the picker. */
    pickFile(): Promise<PendingAttachment | null>
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
  modelCatalogList: 'model-catalog:list',
  modelCatalogRefresh: 'model-catalog:refresh',
  chatSendMessage: 'chat:send-message',
  chatCancel: 'chat:cancel',
  chatGetContextInspector: 'chat:get-context-inspector',
  attachmentsPickFile: 'attachment:pick-file',
  workspaceFilesGetRoot: 'workspace-file:get-root',
  workspaceFilesPickRoot: 'workspace-file:pick-root',
  workspaceFilesReindex: 'workspace-file:reindex',
  workspaceFilesList: 'workspace-file:list',
  workspaceFilesSearch: 'workspace-file:search',
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
