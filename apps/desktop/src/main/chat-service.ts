import type { ChatProvider, ProviderChatMessage } from '@ai-workspace/providers'
import type { ConversationRepository, MessageRepository } from '@ai-workspace/storage'
import type { ChatStreamEvent, Message, MessageStatus, ProviderId, SendMessageInput } from '@ai-workspace/shared'
import type { ContextService } from './context-service'

export interface ResolvedProvider {
  chatProvider: ChatProvider
  provider: ProviderId
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

/**
 * Provider-independent orchestration for a single chat turn: persist the
 * user message, replay conversation history through the resolved provider,
 * stream deltas out via `onEvent`, and persist the assistant reply with its
 * provider/model attribution. Contains no Electron imports so it can be
 * exercised in tests with an in-memory database and a mock provider (see
 * `__tests__/chat-service.test.ts`).
 */
export class ChatService {
  private readonly controllers = new Map<string, AbortController>()

  constructor(private readonly deps: ChatServiceDeps) {}

  cancel(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  async sendMessage(
    input: SendMessageInput,
    onEvent: (event: ChatStreamEvent) => void,
  ): Promise<Message> {
    const { conversations, messages, resolveProvider, contextService } = this.deps

    const conversation = conversations.get(input.conversationId)
    if (!conversation) {
      throw new Error(`Conversation not found: ${input.conversationId}`)
    }

    const selection = input.contextSelection
    const pendingAttachments = selection?.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      content: a.content,
    }))
    messages.create({
      conversationId: input.conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: input.content }],
      ...(pendingAttachments ? { attachments: pendingAttachments } : {}),
    })

    const history = messages.listByConversation(input.conversationId)
    const providerMessages: ProviderChatMessage[] = history.map((m) => ({
      role: m.role,
      content: m.parts.map((p) => p.content).join(''),
    }))

    // What the Context Inspector left toggled on for this turn gets
    // injected as one extra, non-persisted message right before the
    // current user turn — see ContextService and ADR "Context selection
    // wiring". `includeHistory: false` drops everything except that turn.
    if (selection?.includeHistory === false) {
      const last = providerMessages[providerMessages.length - 1]
      providerMessages.length = 0
      if (last) providerMessages.push(last)
    }
    const contextBlock = selection && contextService
      ? contextService.resolveContextBlock(conversation.workspaceId, selection)
      : null
    if (contextBlock) {
      const insertAt = Math.max(providerMessages.length - 1, 0)
      providerMessages.splice(insertAt, 0, { role: 'system', content: contextBlock })
    }

    const { chatProvider, provider } = await resolveProvider(input.providerConfigId)

    const controller = new AbortController()
    this.controllers.set(input.requestId, controller)

    let accumulated = ''
    let status: MessageStatus = 'complete'
    let errorMessage: string | undefined

    try {
      for await (const event of chatProvider.streamChat({
        model: input.model,
        messages: providerMessages,
        signal: controller.signal,
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
        }
      }
    } finally {
      this.controllers.delete(input.requestId)
    }

    const assistantMessage = messages.create({
      conversationId: input.conversationId,
      role: 'assistant',
      provider,
      model: input.model,
      status,
      parts: accumulated.length > 0 ? [{ type: 'text', content: accumulated }] : [],
    })

    conversations.touch(input.conversationId)

    if (errorMessage) {
      onEvent({ type: 'error', message: errorMessage })
    }
    onEvent({ type: 'done', message: assistantMessage })

    return assistantMessage
  }
}
