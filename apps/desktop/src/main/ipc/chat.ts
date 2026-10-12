import { ipcMain, type WebContents } from 'electron'
import {
  ApplySuggestionsInputSchema,
  AutoInputSchema,
  CompareInputSchema,
  GetContextInspectorInputSchema,
  IPC_CHANNELS,
  RetryReplyInputSchema,
  ReviewInputSchema,
  RoundTableInputSchema,
  SendMessageInputSchema,
  chatStreamChannel,
  orchestrationStreamChannel,
} from '@ai-workspace/shared'
import {
  ConversationRepository,
  MessageRepository,
  ProviderConfigRepository,
  SettingsRepository,
  WorkspaceFileRepository,
} from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { getProviderCatalogService } from '../services'
import { ChatService } from '../chat-service'
import { ContextService } from '../context-service'
import { OrchestrationService } from '../orchestration-service'
import { buildAutoCandidates } from '../auto-candidates'

/** Sends on a channel unless the window is already gone (a stream outliving its window must not throw). */
function pusher(sender: WebContents, channel: string): (payload: unknown) => void {
  return (payload) => {
    if (!sender.isDestroyed()) sender.send(channel, payload)
  }
}

export function registerChatIpc(): void {
  const db = getDatabase()
  const conversations = new ConversationRepository(db)
  const messages = new MessageRepository(db)
  const workspaceFiles = new WorkspaceFileRepository(db)
  const providerConfigs = new ProviderConfigRepository(db)
  const settings = new SettingsRepository(db)

  const contextService = new ContextService({ messages, workspaceFiles })

  const chatService = new ChatService({
    conversations,
    messages,
    contextService,
    resolveProvider: (providerConfigId) => getProviderCatalogService().resolveChatProvider(providerConfigId),
  })

  const orchestration = new OrchestrationService({
    chat: chatService,
    conversations,
    messages,
    listAutoCandidates: () =>
      buildAutoCandidates(providerConfigs.list(), (id) => getProviderCatalogService().listCatalog(id)),
    getAutoPreference: () => settings.get().autoPreference,
  })

  ipcMain.handle(IPC_CHANNELS.chatSendMessage, async (event, rawInput: unknown) => {
    const input = SendMessageInputSchema.parse(rawInput)
    const push = pusher(event.sender, chatStreamChannel(input.requestId))
    return chatService.sendMessage(input, push)
  })

  ipcMain.handle(IPC_CHANNELS.chatCancel, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string') throw new Error('requestId must be a string')
    chatService.cancel(requestId)
  })

  ipcMain.handle(IPC_CHANNELS.chatGetContextInspector, (_event, rawInput: unknown) => {
    const input = GetContextInspectorInputSchema.parse(rawInput)
    return contextService.buildInspectorState(input)
  })

  // --- Phase 6 orchestration. Every input is zod-validated here (counts 2-4,
  // rounds <= ROUND_TABLE_MAX_ROUNDS, ...) and re-checked inside the service.

  ipcMain.handle(IPC_CHANNELS.chatCompare, (event, rawInput: unknown) => {
    const input = CompareInputSchema.parse(rawInput)
    const sender = event.sender
    return orchestration.compare(input, (requestId, streamEvent) =>
      pusher(sender, chatStreamChannel(requestId))(streamEvent),
    )
  })

  ipcMain.handle(IPC_CHANNELS.chatReview, (event, rawInput: unknown) => {
    const input = ReviewInputSchema.parse(rawInput)
    return orchestration.review(input, pusher(event.sender, orchestrationStreamChannel(input.orchestrationId)))
  })

  ipcMain.handle(IPC_CHANNELS.chatApplySuggestions, (event, rawInput: unknown) => {
    const input = ApplySuggestionsInputSchema.parse(rawInput)
    return orchestration.applySuggestions(
      input,
      pusher(event.sender, orchestrationStreamChannel(input.orchestrationId)),
    )
  })

  ipcMain.handle(IPC_CHANNELS.chatRoundTable, (event, rawInput: unknown) => {
    const input = RoundTableInputSchema.parse(rawInput)
    return orchestration.roundTable(input, pusher(event.sender, orchestrationStreamChannel(input.orchestrationId)))
  })

  ipcMain.handle(IPC_CHANNELS.chatAuto, (event, rawInput: unknown) => {
    const input = AutoInputSchema.parse(rawInput)
    return orchestration.auto(input, pusher(event.sender, chatStreamChannel(input.requestId)))
  })

  ipcMain.handle(IPC_CHANNELS.chatRetryReply, (event, rawInput: unknown) => {
    const input = RetryReplyInputSchema.parse(rawInput)
    return orchestration.retryReply(input, pusher(event.sender, chatStreamChannel(input.requestId)))
  })

  ipcMain.handle(IPC_CHANNELS.chatSetInContext, (_event, messageId: unknown) => {
    if (typeof messageId !== 'string' || messageId.length === 0) throw new Error('messageId must be a string')
    return orchestration.setInContext(messageId)
  })

  ipcMain.handle(IPC_CHANNELS.chatCancelOrchestration, (_event, orchestrationId: unknown) => {
    if (typeof orchestrationId !== 'string') throw new Error('orchestrationId must be a string')
    orchestration.cancelOrchestration(orchestrationId)
  })
}
