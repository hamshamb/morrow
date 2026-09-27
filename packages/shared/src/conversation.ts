import { z } from 'zod'
import { ProviderIdSchema } from './provider'

export const ConversationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type Conversation = z.infer<typeof ConversationSchema>

export const CreateConversationInputSchema = z.object({
  workspaceId: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
})
export type CreateConversationInput = z.infer<typeof CreateConversationInputSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/**
 * `streaming` is a transient in-memory state used while a response is being
 * generated; a message persisted to SQLite is always written in one of the
 * terminal states (`complete` | `error` | `cancelled`).
 */
export const MessageStatusSchema = z.enum(['complete', 'streaming', 'error', 'cancelled'])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const MessagePartTypeSchema = z.enum(['text'])
export type MessagePartType = z.infer<typeof MessagePartTypeSchema>

export const MessagePartSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  type: MessagePartTypeSchema,
  content: z.string(),
  position: z.number(),
  createdAt: z.number(),
})
export type MessagePart = z.infer<typeof MessagePartSchema>

/**
 * A single message in a conversation. `provider`/`model` record which model
 * produced this specific message (null for user/system messages) so a
 * conversation can move Claude -> Claude -> OpenAI -> Gemini without
 * branching — see ARCHITECTURE.md "Data model".
 */
export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: MessageRoleSchema,
  provider: ProviderIdSchema.nullable(),
  model: z.string().nullable(),
  status: MessageStatusSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  parts: z.array(MessagePartSchema),
})
export type Message = z.infer<typeof MessageSchema>

export const SendMessageInputSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  providerConfigId: z.string().min(1),
  model: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),
})
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>

/** Streamed over IPC from main -> renderer for a single in-flight request. */
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), delta: z.string() }),
  z.object({ type: z.literal('done'), message: MessageSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>
