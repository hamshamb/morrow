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
  ProviderConfigRepository,
  WorkspaceFileRepository,
} from '@ai-workspace/storage'
import { createProvider } from '@ai-workspace/providers'
import { getDatabase } from '../db'
import { ChatService } from '../chat-service'
import { ContextService } from '../context-service'
import { loadDecryptedCredential } from './provider-config'

export function registerChatIpc(): void {
  const db = getDatabase()
  const conversations = new ConversationRepository(db)
  const messages = new MessageRepository(db)
  const providerConfigs = new ProviderConfigRepository(db)
  const workspaceFiles = new WorkspaceFileRepository(db)

  const contextService = new ContextService({ messages, workspaceFiles })

  const chatService = new ChatService({
    conversations,
    messages,
    contextService,
    resolveProvider: (providerConfigId) => {
      const credential = loadDecryptedCredential(providerConfigs, providerConfigId)
      return {
        provider: credential.provider,
        chatProvider: createProvider(credential.provider, {
          apiKey: credential.apiKey,
          baseUrl: credential.baseUrl,
        }),
      }
    },
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
