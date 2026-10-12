import { ipcMain } from 'electron'
import {
  GetContextInspectorInputSchema,
  IPC_CHANNELS,
  SendMessageInputSchema,
  chatStreamChannel,
} from '@ai-workspace/shared'
import {
  ConversationRepository,
  MessageRepository,
  WorkspaceFileRepository,
} from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { getProviderCatalogService } from '../services'
import { ChatService } from '../chat-service'
import { ContextService } from '../context-service'

export function registerChatIpc(): void {
  const db = getDatabase()
  const conversations = new ConversationRepository(db)
  const messages = new MessageRepository(db)
  const workspaceFiles = new WorkspaceFileRepository(db)

  const contextService = new ContextService({ messages, workspaceFiles })

  const chatService = new ChatService({
    conversations,
    messages,
    contextService,
    resolveProvider: (providerConfigId) => getProviderCatalogService().resolveChatProvider(providerConfigId),
  })

  ipcMain.handle(IPC_CHANNELS.chatSendMessage, async (event, rawInput: unknown) => {
    const input = SendMessageInputSchema.parse(rawInput)
    const channel = chatStreamChannel(input.requestId)
    const sender = event.sender
    return chatService.sendMessage(input, (streamEvent) => {
      if (!sender.isDestroyed()) {
        sender.send(channel, streamEvent)
      }
    })
  })

  ipcMain.handle(IPC_CHANNELS.chatCancel, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') throw new Error('requestId must be a string')
    chatService.cancel(requestId)
  })

  ipcMain.handle(IPC_CHANNELS.chatGetContextInspector, (_event, rawInput: unknown) => {
    const input = GetContextInspectorInputSchema.parse(rawInput)
    return contextService.buildInspectorState(input)
  })
}
