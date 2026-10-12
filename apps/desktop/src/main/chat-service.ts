import type { ChatProvider, ProviderChatMessage, ProviderUsage } from '@ai-workspace/providers'
import type { ConversationRepository, MessageRepository } from '@ai-workspace/storage'
import {
  estimateCostUsd,
  type ChatStreamEvent,
  type ContextSelection,
  type Message,
  type MessageStatus,
  type ModelMetadata,
  type OrchestrationMode,
  type ProviderId,
  type ReasoningEffort,
  type RoleLabel,
  type SendMessageInput,
} from '@ai-workspace/shared'
import type { ContextService } from './context-service'

export interface ResolvedProvider {
  chatProvider: ChatProvider
  provider: ProviderId
  /** models.dev metadata for a model id (used to validate/map the reasoning
   * effort, and to estimate cost). Optional so tests and mock providers can omit it. */
  getModelMeta?: (modelId: string) => ModelMetadata | null
}

export type ResolveProvider = (
  providerConfigId: string,
) => ResolvedProvider | Promise<ResolvedProvider>

export interface ChatServiceDeps {
  conversations: ConversationRepository
  messages: MessageRepository
  resolveProvider: ResolveProvider
  /** Optional so existing callers/tests that never pass a `contextSelection`
   * keep working unchanged — Phase 3 context wiring is additive. */
  contextService?: ContextService
}

/** Everything one assistant reply needs; the caller has already built the
 * provider messages (history + context + any orchestration prompt). */
export interface TurnOptions {
  conversationId: string
  /** Stream channel + cancel key. */
  requestId: string
  providerConfigId: string
  model: string
  effort?: ReasoningEffort | null
  providerMessages: ProviderChatMessage[]
  replyGroupId: string | null
  orchestrationMode: OrchestrationMode
  roleLabel?: RoleLabel | null
  replyIndex?: number | null
  roundIndex?: number | null
  /** Forced in/out of the context; default: in when the reply has any text. */
  inContext?: boolean
  autoReason?: string | null
  /** When true a provider that cannot even be resolved (missing config,
   * unavailable provider) becomes an error reply instead of a throw — one
   * failing compare column must never take the others down. */
  isolateFailures?: boolean
}

/** Internal extras for `sendMessage` used by the orchestration layer (Auto). */
export interface SendExtras {
  orchestrationMode?: OrchestrationMode
  autoReason?: string | null
}

/**
 * Provider-independent orchestration for chat turns: persist the user
 * message, replay conversation history through the resolved provider, stream
 * deltas out via `onEvent`, and persist the assistant reply with its
 * provider/model attribution, usage, latency and estimated cost. Contains no
 * Electron imports so it can be exercised in tests with an in-memory database
 * and a mock provider (see `__tests__/chat-service.test.ts`).
 *
 * Phase 6 splits the single-turn flow into reusable pieces — `persistUserTurn`,
 * `buildProviderMessages`, `runTurn` — which `OrchestrationService` composes
 * into compare / review / round table / auto. `sendMessage` is the same
 * default path as before, built from those pieces.
 */
export class ChatService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: ChatServiceDeps) {}

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  /** Persists the user's turn (with its attachments) and returns it. */
  persistUserTurn(input: {
    conversationId: string
    content: string
    contextSelection?: ContextSelection | undefined
  }): Message {
    const { conversations, messages } = this.deps
    if (!conversations.get(input.conversationId)) {
      throw new Error(`Conversation not found: ${input.conversationId}`)
    }
    const pendingAttachments = input.contextSelection?.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      content: a.content,
    }))
    return messages.create({
      conversationId: input.conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: input.content }],
      ...(pendingAttachments ? { attachments: pendingAttachments } : {}),
    })
  }

  /**
   * The messages a provider receives for a turn: the conversation history
   * (only messages that are `inContext` — replies the user did not choose, and
   * failed empty replies, are never sent; ADR-028) ending with the user turn,
   * with the Context Inspector's selection prepended (non-persisted) to that
   * user turn as a delimited untrusted-data block (ADR-013, revised). `untilMessageId` cuts the history off at
   * (and including) that message — used to answer an earlier turn again.
   */
  buildProviderMessages(opts: {
    conversationId: string
    untilMessageId?: string
    selection?: ContextSelection | undefined
  }): ProviderChatMessage[] {
    const { conversations, messages, contextService } = this.deps
    const conversation = conversations.get(opts.conversationId)
    if (!conversation) throw new Error(`Conversation not found: ${opts.conversationId}`)

    let history = messages.listByConversation(opts.conversationId)
    if (opts.untilMessageId) {
      const index = history.findIndex((m) => m.id === opts.untilMessageId)
      if (index === -1) throw new Error(`Message not found: ${opts.untilMessageId}`)
      history = history.slice(0, index + 1)
    }
    const providerMessages: ProviderChatMessage[] = history
      .filter((m) => m.inContext)
      .map((m) => ({
        role: m.role,
        content: m.parts.map((p) => p.content).join(''),
      }))

    // What the Context Inspector left toggled on for this turn gets
    // injected as one extra, non-persisted message right before the
    // current user turn — see ContextService and ADR "Context selection
    // wiring". `includeHistory: false` drops everything except that turn.
    const selection = opts.selection
    if (selection?.includeHistory === false) {
      const last = providerMessages[providerMessages.length - 1]
      providerMessages.length = 0
      if (last) providerMessages.push(last)
    }
    const contextBlock =
      selection && contextService
        ? contextService.resolveContextBlock(conversation.workspaceId, selection)
        : null
    if (contextBlock) {
      // Into the current user turn, not a system message: ai@7 rejects system
      // messages inside `messages`, and attached file content is untrusted
      // data that must not be promoted to instruction authority.
      const last = providerMessages[providerMessages.length - 1]
      if (last && last.role === 'user') {
        providerMessages[providerMessages.length - 1] = {
          role: 'user',
          content: `${contextBlock}\n\n${last.content}`,
        }
      } else {
        providerMessages.push({ role: 'user', content: contextBlock })
      }
    }
    return providerMessages
  }

  /**
   * Streams one assistant reply and persists it. Always resolves with the
   * persisted message — a provider error or a cancel is a `status: 'error' |
   * 'cancelled'` reply (with whatever text arrived), not a rejection. Emits
   * `start`, `delta`*, optional `error`, then `done` on `onEvent`.
   */
  async runTurn(opts: TurnOptions, onEvent: (event: ChatStreamEvent) => void): Promise<Message> {
    const { conversations, messages, resolveProvider } = this.deps

    let resolved: ResolvedProvider | null = null
    let errorMessage: string | undefined
    try {
      resolved = await resolveProvider(opts.providerConfigId)
    } catch (err) {
      if (!opts.isolateFailures) throw err
      errorMessage = err instanceof Error ? err.message : String(err)
    }
    const modelMeta = resolved?.getModelMeta?.(opts.model) ?? null

    const controller = new AbortController()
    this.controllers.set(opts.requestId, controller)

    let accumulated = ''
    let status: MessageStatus = errorMessage ? 'error' : 'complete'
    let usage: ProviderUsage | undefined
    const startedAt = Date.now()

    onEvent({
      type: 'start',
      provider: resolved?.provider ?? '',
      model: opts.model,
      autoReason: opts.autoReason ?? null,
    })

    try {
      if (resolved) {
        for await (const event of resolved.chatProvider.streamChat({
          model: opts.model,
          messages: opts.providerMessages,
          signal: controller.signal,
          effort: opts.effort ?? null,
          modelMeta,
        })) {
          if (event.type === 'text-delta') {
            accumulated += event.delta
            onEvent({ type: 'delta', delta: event.delta })
          } else if (event.type === 'error') {
            status = controller.signal.aborted ? 'cancelled' : 'error'
            errorMessage = event.error
            break
          } else if (event.type === 'done') {
            accumulated = event.text
            usage = event.usage
          }
        }
      }
    } finally {
      this.controllers.delete(opts.requestId)
    }
    const latencyMs = Date.now() - startedAt

    const assistantMessage = messages.create({
      conversationId: opts.conversationId,
      role: 'assistant',
      provider: resolved?.provider ?? null,
      model: opts.model,
      status,
      parts: accumulated.length > 0 ? [{ type: 'text', content: accumulated }] : [],
      replyGroupId: opts.replyGroupId,
      orchestrationMode: opts.orchestrationMode,
      roleLabel: opts.roleLabel ?? null,
      replyIndex: opts.replyIndex ?? null,
      roundIndex: opts.roundIndex ?? null,
      autoReason: opts.autoReason ?? null,
      // A reply with no text (a failed request) would be an empty assistant
      // turn in the next request, which several providers reject — keep it out.
      inContext: opts.inContext ?? accumulated.length > 0,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      latencyMs,
      estCostUsd: estimateCostUsd(modelMeta?.cost, usage),
      errorText: errorMessage ?? null,
    })

    conversations.touch(opts.conversationId)

    if (errorMessage) {
      onEvent({ type: 'error', message: errorMessage })
    }
    onEvent({ type: 'done', message: assistantMessage })

    return assistantMessage
  }

  async sendMessage(
    input: SendMessageInput,
    onEvent: (event: ChatStreamEvent) => void,
    extras: SendExtras = {},
  ): Promise<Message> {
    const { conversations, messages } = this.deps

    const conversation = conversations.get(input.conversationId)
    if (!conversation) {
      throw new Error(`Conversation not found: ${input.conversationId}`)
    }

    let userMessage: Message
    let providerMessages: ProviderChatMessage[]
    const regenerateOf = input.regenerateOfMessageId
    if (regenerateOf) {
      // Answer an earlier turn again: the user message is reused, not re-sent.
      const target = messages.get(regenerateOf)
      if (!target || target.role !== 'user' || target.conversationId !== input.conversationId) {
        throw new Error(`Message not found: ${regenerateOf}`)
      }
      userMessage = target
      providerMessages = this.buildProviderMessages({
        conversationId: input.conversationId,
        untilMessageId: target.id,
      })
    } else {
      userMessage = this.persistUserTurn({
        conversationId: input.conversationId,
        content: input.content,
        contextSelection: input.contextSelection,
      })
      providerMessages = this.buildProviderMessages({
        conversationId: input.conversationId,
        selection: input.contextSelection,
      })
    }

    const reply = await this.runTurn(
      {
        conversationId: input.conversationId,
        requestId: input.requestId,
        providerConfigId: input.providerConfigId,
        model: input.model,
        effort: input.effort ?? null,
        providerMessages,
        replyGroupId: userMessage.id,
        orchestrationMode: extras.orchestrationMode ?? 'normal',
        autoReason: extras.autoReason ?? null,
      },
      onEvent,
    )

    // A regenerated reply replaces its siblings in the context (they stay
    // persisted and visible) — but only if it actually produced something.
    if (regenerateOf && reply.inContext) {
      messages.chooseReply(reply.id)
    }
    return reply
  }
}
