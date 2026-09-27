import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConversationRepository,
  MessageRepository,
  WorkspaceRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import { createMockProvider } from '@ai-workspace/providers'
import type { ChatStreamEvent } from '@ai-workspace/shared'
import { ChatService } from '../chat-service'

describe('ChatService (integration, mock provider — no network)', () => {
  let db: AppDatabase
  let conversations: ConversationRepository
  let messages: MessageRepository
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversations = new ConversationRepository(db)
    messages = new MessageRepository(db)
    conversationId = conversations.create({ workspaceId }).id
  })

  afterEach(() => {
    db.close()
  })

  it('persists the user message, streams deltas, and persists the assistant reply with attribution', async () => {
    const service = new ChatService({
      conversations,
      messages,
      resolveProvider: () => ({
        provider: 'anthropic',
        chatProvider: createMockProvider({ id: 'anthropic', respond: ['Hello', ', world!'] }),
      }),
    })

    const events: ChatStreamEvent[] = []
    const result = await service.sendMessage(
      {
        requestId: 'req-1',
        conversationId,
        providerConfigId: 'pc-1',
        model: 'claude-sonnet-4-5',
        content: 'Hi there',
      },
      (event) => events.push(event),
    )

    expect(result.role).toBe('assistant')
    expect(result.provider).toBe('anthropic')
    expect(result.model).toBe('claude-sonnet-4-5')
    expect(result.status).toBe('complete')
    expect(result.parts.map((p) => p.content).join('')).toBe('Hello, world!')

    expect(events.filter((e) => e.type === 'delta')).toHaveLength(2)
    const done = events.at(-1)
    expect(done?.type).toBe('done')

    const thread = messages.listByConversation(conversationId)
    expect(thread).toHaveLength(2)
    expect(thread[0]?.role).toBe('user')
    expect(thread[0]?.provider).toBeNull()
    expect(thread[1]?.role).toBe('assistant')
    expect(thread[1]?.provider).toBe('anthropic')
  })

  it('allows a single conversation to move between providers per message without branching', async () => {
    const service = new ChatService({
      conversations,
      messages,
      resolveProvider: (providerConfigId) => {
        if (providerConfigId === 'anthropic-key') {
          return { provider: 'anthropic', chatProvider: createMockProvider({ id: 'anthropic', respond: ['A1'] }) }
        }
        if (providerConfigId === 'openai-key') {
          return { provider: 'openai', chatProvider: createMockProvider({ id: 'openai', respond: ['A2'] }) }
        }
        return { provider: 'google', chatProvider: createMockProvider({ id: 'google', respond: ['A3'] }) }
      },
    })

    await service.sendMessage(
      { requestId: 'r1', conversationId, providerConfigId: 'anthropic-key', model: 'claude-sonnet-4-5', content: 'Q1' },
      () => {},
    )
    await service.sendMessage(
      { requestId: 'r2', conversationId, providerConfigId: 'openai-key', model: 'gpt-4o', content: 'Q2' },
      () => {},
    )
    await service.sendMessage(
      { requestId: 'r3', conversationId, providerConfigId: 'google-key', model: 'gemini-2.0-flash', content: 'Q3' },
      () => {},
    )

    const thread = messages.listByConversation(conversationId)
    const assistantMessages = thread.filter((m) => m.role === 'assistant')
    expect(assistantMessages.map((m) => m.provider)).toEqual(['anthropic', 'openai', 'google'])
    expect(assistantMessages.map((m) => m.model)).toEqual([
      'claude-sonnet-4-5',
      'gpt-4o',
      'gemini-2.0-flash',
    ])
  })

  it('persists a partial assistant message with status "error" when the provider stream fails', async () => {
    const service = new ChatService({
      conversations,
      messages,
      resolveProvider: () => ({
        provider: 'openai',
        chatProvider: createMockProvider({ id: 'openai', respond: ['partial'], failWith: 'rate limited' }),
      }),
    })

    const events: ChatStreamEvent[] = []
    const result = await service.sendMessage(
      { requestId: 'req-err', conversationId, providerConfigId: 'pc-1', model: 'gpt-4o', content: 'Hi' },
      (event) => events.push(event),
    )

    expect(result.status).toBe('error')
    expect(result.parts.map((p) => p.content).join('')).toBe('partial')
    expect(events.some((e) => e.type === 'error' && e.message === 'rate limited')).toBe(true)
  })

  it('throws when the conversation does not exist', async () => {
    const service = new ChatService({
      conversations,
      messages,
      resolveProvider: () => ({ provider: 'anthropic', chatProvider: createMockProvider({ id: 'anthropic' }) }),
    })

    await expect(
      service.sendMessage(
        { requestId: 'r', conversationId: 'missing', providerConfigId: 'pc-1', model: 'x', content: 'hi' },
        () => {},
      ),
    ).rejects.toThrow('Conversation not found')
  })

  it('cancel() aborts the in-flight request and the result is marked cancelled', async () => {
    const requestId = 'req-cancel'
    let service!: ChatService

    // The mock provider's `respond` callback runs *inside* streamChat, after
    // ChatService has already registered the AbortController for this
    // request — calling cancel() from here deterministically exercises the
    // abort path without relying on timing between two async calls.
    service = new ChatService({
      conversations,
      messages,
      resolveProvider: () => ({
        provider: 'anthropic',
        chatProvider: createMockProvider({
          id: 'anthropic',
          respond: () => {
            service.cancel(requestId)
            return ['chunk-1', 'chunk-2']
          },
        }),
      }),
    })

    const events: ChatStreamEvent[] = []
    const result = await service.sendMessage(
      { requestId, conversationId, providerConfigId: 'pc-1', model: 'claude-sonnet-4-5', content: 'hi' },
      (event) => events.push(event),
    )

    expect(result.status).toBe('cancelled')
    expect(events.some((e) => e.type === 'error' && e.message === 'Aborted')).toBe(true)
  })
})
