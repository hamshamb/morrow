import type { AppSettings, AppSettingsPartial } from './settings'
import type { CreateWorkspaceInput, UpdateWorkspaceInput, Workspace } from './workspace'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from './provider'
import type {
  ChatStreamEvent,
  Conversation,
  CreateConversationInput,
  Message,
  SendMessageInput,
} from './conversation'

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
    delete(id: string): Promise<void>
    listMessages(conversationId: string): Promise<Message[]>
  }
  providerConfigs: {
    list(): Promise<ProviderConfigSummary[]>
    add(input: AddProviderConfigInput): Promise<ProviderConfigSummary>
    remove(id: string): Promise<void>
    test(input: TestProviderConfigInput): Promise<TestProviderConfigResult>
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
  conversationsDelete: 'conversation:delete',
  messagesList: 'message:list',
  providerConfigsList: 'provider-config:list',
  providerConfigsAdd: 'provider-config:add',
  providerConfigsRemove: 'provider-config:remove',
  providerConfigsTest: 'provider-config:test',
  chatSendMessage: 'chat:send-message',
  chatCancel: 'chat:cancel',
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
