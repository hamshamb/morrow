import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC_CHANNELS,
  chatStreamChannel,
  orchestrationStreamChannel,
  type ChatStreamEvent,
  type OrchestrationStreamEvent,
  type RendererApi,
} from '@ai-workspace/shared'

const api: RendererApi = {
  workspaces: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.workspacesList),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesGet, id),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesCreate, input),
    update: (input) => ipcRenderer.invoke(IPC_CHANNELS.workspacesUpdate, input),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.workspacesDelete, id),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settingsGet),
    set: (partial) => ipcRenderer.invoke(IPC_CHANNELS.settingsSet, partial),
  },
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.appGetVersion),
  },
  conversations: {
    list: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.conversationsList, workspaceId),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsCreate, input),
    rename: (input) => ipcRenderer.invoke(IPC_CHANNELS.conversationsRename, input),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.conversationsDelete, id),
    listMessages: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.messagesList, conversationId),
  },
  providerConfigs: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.providerConfigsList),
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.providerConfigsAdd, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.providerConfigsRemove, id),
    test: (input) => ipcRenderer.invoke(IPC_CHANNELS.providerConfigsTest, input),
  },
  providers: {
    registry: () => ipcRenderer.invoke(IPC_CHANNELS.providersRegistry),
    detectLocal: () => ipcRenderer.invoke(IPC_CHANNELS.providersDetectLocal),
  },
  modelsMetadata: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS.modelsMetadataStatus),
    refresh: () => ipcRenderer.invoke(IPC_CHANNELS.modelsMetadataRefresh),
    onChange: (listener) => {
      const wrapped = (): void => listener()
      ipcRenderer.on(IPC_CHANNELS.modelsMetadataChanged, wrapped)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.modelsMetadataChanged, wrapped)
    },
  },
  modelCatalog: {
    list: (providerConfigId) => ipcRenderer.invoke(IPC_CHANNELS.modelCatalogList, providerConfigId),
    refresh: (providerConfigId) =>
      ipcRenderer.invoke(IPC_CHANNELS.modelCatalogRefresh, providerConfigId),
  },
  chat: {
    sendMessage: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatSendMessage, input),
    cancel: (requestId) => ipcRenderer.invoke(IPC_CHANNELS.chatCancel, requestId),
    onStreamEvent: (requestId, listener) => {
      const channel = chatStreamChannel(requestId)
      const wrapped = (_event: IpcRendererEvent, data: ChatStreamEvent): void => listener(data)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
    getContextInspector: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatGetContextInspector, input),
    compare: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatCompare, input),
    review: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatReview, input),
    applySuggestions: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatApplySuggestions, input),
    roundTable: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatRoundTable, input),
    auto: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatAuto, input),
    retryReply: (input) => ipcRenderer.invoke(IPC_CHANNELS.chatRetryReply, input),
    setInContext: (messageId) => ipcRenderer.invoke(IPC_CHANNELS.chatSetInContext, messageId),
    cancelOrchestration: (orchestrationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.chatCancelOrchestration, orchestrationId),
    onOrchestrationEvent: (orchestrationId, listener) => {
      const channel = orchestrationStreamChannel(orchestrationId)
      const wrapped = (_event: IpcRendererEvent, data: OrchestrationStreamEvent): void => listener(data)
      ipcRenderer.on(channel, wrapped)
      return () => ipcRenderer.removeListener(channel, wrapped)
    },
  },
  attachments: {
    pickFile: () => ipcRenderer.invoke(IPC_CHANNELS.attachmentsPickFile),
  },
  workspaceFiles: {
    getRoot: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesGetRoot, workspaceId),
    pickRoot: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesPickRoot, workspaceId),
    reindex: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesReindex, workspaceId),
    list: (workspaceId) => ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesList, workspaceId),
    search: (workspaceId, query) =>
      ipcRenderer.invoke(IPC_CHANNELS.workspaceFilesSearch, workspaceId, query),
  },
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // Should never happen — contextIsolation is forced on in main/index.ts.
  // @ts-expect-error fallback path only, not part of the typed contract
  window.api = api
}
