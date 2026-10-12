import { z } from 'zod'
import { ProviderIdSchema } from './provider'
import { AttachmentSchema } from './attachment'
import { ContextSelectionSchema } from './context'
import { ReasoningEffortSchema } from './model-metadata'

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

export const UpdateConversationInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
})
export type UpdateConversationInput = z.infer<typeof UpdateConversationInputSchema>

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

/**
 * `streaming` is a transient in-memory state used while a response is being
 * generated; a message persisted to SQLite is always written in one of the
 * terminal states (`complete` | `error` | `cancelled`).
 */
export const MessageStatusSchema = z.enum(['complete', 'streaming', 'error', 'cancelled'])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

/**
 * How a reply was produced (ADR-027). `normal` is the default single-model
 * turn; every other mode is reached through the composer's mode control.
 */
export const OrchestrationModeSchema = z.enum(['normal', 'compare', 'review', 'roundtable', 'auto'])
export type OrchestrationMode = z.infer<typeof OrchestrationModeSchema>

/** The part a reply plays inside a review / round table (null for a plain reply). */
export const RoleLabelSchema = z.enum([
  'proposal',
  'critique',
  'alternative',
  'synthesis',
  'review',
  /** The primary model's revised answer after `[apply suggestions]`. */
  'revision',
])
export type RoleLabel = z.infer<typeof RoleLabelSchema>

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
  /** Files attached to this message (user messages only in practice). */
  attachments: z.array(AttachmentSchema).default([]),

  // --- Phase 6 orchestration fields (migration 0005). All defaulted, so rows
  // and payloads from before it parse unchanged — ADR-027. ---
  /** Groups the sibling replies to one user turn (the user message's id).
   * null on rows from before orchestration existed and on user messages. */
  replyGroupId: z.string().nullable().default(null),
  orchestrationMode: OrchestrationModeSchema.default('normal'),
  roleLabel: RoleLabelSchema.nullable().default(null),
  /** Whether this message is replayed to providers on later turns. Siblings
   * that were not chosen are persisted and visible but excluded (ADR-028). */
  inContext: z.boolean().default(true),
  /** Why Auto picked this model, e.g. "needs vision, cheapest capable". */
  autoReason: z.string().nullable().default(null),
  /** Position inside the reply group (compare column / pipeline step). */
  replyIndex: z.number().int().nullable().default(null),
  /** 1-based round number inside a round table. */
  roundIndex: z.number().int().nullable().default(null),
  /** Provider-reported usage; null when the provider reported none. */
  inputTokens: z.number().int().nullable().default(null),
  outputTokens: z.number().int().nullable().default(null),
  /** Wall-clock time from request to the last token. */
  latencyMs: z.number().int().nullable().default(null),
  /** Estimated cost in USD from models.dev pricing x reported usage (ADR-031).
   * null when the model's price or the usage is unknown — never a guess. */
  estCostUsd: z.number().nullable().default(null),
  /** The provider error behind a `status: 'error'` reply. */
  errorText: z.string().nullable().default(null),
})
export type Message = z.infer<typeof MessageSchema>

export const SendMessageInputSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string().min(1),
  providerConfigId: z.string().min(1),
  model: z.string().min(1).max(200),
  content: z.string().min(1).max(100_000),
  /** What the Context Inspector left toggled on for this turn — see
   * ContextSelectionSchema. Optional/omittable so existing callers (and
   * tests) that don't care about Phase 3 context keep working unchanged. */
  contextSelection: ContextSelectionSchema.optional(),
  /** Reasoning/thinking effort for this turn's model, if the composer had
   * one selected. Optional/nullable so existing callers keep working
   * unchanged; ignored by `ChatService` for a model/provider that doesn't
   * plausibly support it (see `isReasoningCapableModel`). */
  effort: ReasoningEffortSchema.nullable().optional(),
  /** `[regenerate]` / `[regenerate with…]`: answer this existing user message
   * again as a NEW sibling reply instead of re-sending the question as a new
   * turn. The previous in-context reply is kept but leaves the context. */
  regenerateOfMessageId: z.string().min(1).optional(),
})
export type SendMessageInput = z.infer<typeof SendMessageInputSchema>

/** Streamed over IPC from main -> renderer for a single in-flight request. */
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  /** First event of a reply: which model is answering (matters for Auto, whose
   * model is chosen in the main process). Additive — older listeners ignore it. */
  z.object({
    type: z.literal('start'),
    provider: ProviderIdSchema,
    model: z.string(),
    autoReason: z.string().nullable(),
  }),
  z.object({ type: z.literal('delta'), delta: z.string() }),
  z.object({ type: z.literal('done'), message: MessageSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
])
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>
