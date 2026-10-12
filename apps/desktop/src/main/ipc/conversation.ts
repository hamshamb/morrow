import { ipcMain } from 'electron'
import { CreateConversationInputSchema, UpdateConversationInputSchema, IPC_CHANNELS } from '@ai-workspace/shared'
import { ConversationRepository, MessageRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { forgetAgentConversation } from './agent'

export function registerConversationIpc(): void {
  const conversations = new ConversationRepository(getDatabase())
  const messages = new MessageRepository(getDatabase())

  ipcMain.handle(IPC_CHANNELS.conversationsList, (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== 'string') throw new Error('workspaceId must be a string')
    return conversations.list(workspaceId)
  })

  ipcMain.handle(IPC_CHANNELS.conversationsCreate, (_event, input: unknown) => {
    return conversations.create(CreateConversationInputSchema.parse(input))
  })

  ipcMain.handle(IPC_CHANNELS.conversationsRename, (_event, input: unknown) => {
    const parsed = UpdateConversationInputSchema.parse(input)
    return conversations.rename(parsed.id, parsed.title)
  })

  ipcMain.handle(IPC_CHANNELS.conversationsDelete, (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('conversation id must be a string')
    conversations.delete(id)
    forgetAgentConversation(id)
  })

  ipcMain.handle(IPC_CHANNELS.messagesList, (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') throw new Error('conversationId must be a string')
    return messages.listByConversation(conversationId)
  })
}
