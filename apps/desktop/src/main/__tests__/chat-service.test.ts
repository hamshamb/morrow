import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConversationRepository,
  MessageRepository,
  WorkspaceFileRepository,
  WorkspaceRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import { createMockProvider, type ProviderChatMessage } from '@ai-workspace/providers'
import type { ChatStreamEvent } from '@ai-workspace/shared'
import { ChatService } from '../chat-service'
import { ContextService } from '../context-service'

describe('ChatService (integration, mock provider — no network)', () => {
  let db: AppDatabase
  let conversations: ConversationRepository
  let messages: MessageRepository
  let workspaceFiles: WorkspaceFileRepository
  let workspaceId: string
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversations = new ConversationRepository(db)
    messages = new MessageRepository(db)
    workspaceFiles = new WorkspaceFileRepository(db)
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

  describe('Phase 3 context selection wiring', () => {
    it('persists attachments scoped to the new user message and never leaks them into its own displayed part', async () => {
      const service = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({ id: 'anthropic', respond: ['ok'] }),
        }),
      })

      await service.sendMessage(
        {
          requestId: 'r-attach',
          conversationId,
          providerConfigId: 'pc-1',
          model: 'claude-sonnet-4-5',
          content: 'See attached',
          contextSelection: {
            includeHistory: true,
            attachments: [
              { filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 7, content: '# Notes' },
            ],
            workspaceFilePaths: [],
            retrievalSnippetPaths: [],
          },
        },
        () => {},
      )

      const userMessage = messages.listByConversation(conversationId)[0]
      expect(userMessage?.parts.map((p) => p.content).join('')).toBe('See attached')
      expect(userMessage?.attachments).toHaveLength(1)
      expect(userMessage?.attachments[0]?.filename).toBe('notes.md')
      expect(userMessage?.attachments[0]?.content).toBe('# Notes')
    })

    it('injects the resolved context block as an extra provider message without persisting it', async () => {
      let capturedMessages: ProviderChatMessage[] = []
      const service = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({
            id: 'anthropic',
            respond: (request) => {
              capturedMessages = request.messages
              return ['ok']
            },
          }),
        }),
      })

      await service.sendMessage(
        {
          requestId: 'r-context',
          conversationId,
          providerConfigId: 'pc-1',
          model: 'claude-sonnet-4-5',
          content: 'Summarize this',
          contextSelection: {
            includeHistory: true,
            attachments: [
              { filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, content: 'alpha' },
            ],
            workspaceFilePaths: [],
            retrievalSnippetPaths: [],
          },
        },
        () => {},
      )

      const systemMessages = capturedMessages.filter((m) => m.role === 'system')
      expect(systemMessages).toHaveLength(1)
      expect(systemMessages[0]?.content).toContain('a.txt')
      expect(systemMessages[0]?.content).toContain('alpha')

      // The context block is never written to the persisted thread — only
      // the user's own typed text is.
      const thread = messages.listByConversation(conversationId)
      expect(thread.some((m) => m.parts.some((p) => p.content.includes('alpha')))).toBe(false)
    })

    it('resolves selected workspace files by reading their indexed content', async () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'src/index.ts', sizeBytes: 20, mtimeMs: 1, content: 'export const x = 42' },
      ])

      let capturedMessages: ProviderChatMessage[] = []
      const service = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({
            id: 'anthropic',
            respond: (request) => {
              capturedMessages = request.messages
              return ['ok']
            },
          }),
        }),
      })

      await service.sendMessage(
        {
          requestId: 'r-file',
          conversationId,
          providerConfigId: 'pc-1',
          model: 'claude-sonnet-4-5',
          content: 'What does this file do?',
          contextSelection: {
            includeHistory: true,
            attachments: [],
            workspaceFilePaths: ['src/index.ts'],
            retrievalSnippetPaths: [],
          },
        },
        () => {},
      )

      const systemMessage = capturedMessages.find((m) => m.role === 'system')
      expect(systemMessage?.content).toContain('src/index.ts')
      expect(systemMessage?.content).toContain('export const x = 42')
    })

    it('sends nothing extra when no context is selected (Phase 2 behaviour unchanged)', async () => {
      let capturedMessages: ProviderChatMessage[] = []
      const service = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({
            id: 'anthropic',
            respond: (request) => {
              capturedMessages = request.messages
              return ['ok']
            },
          }),
        }),
      })

      await service.sendMessage(
        { requestId: 'r-none', conversationId, providerConfigId: 'pc-1', model: 'claude-sonnet-4-5', content: 'Hi' },
        () => {},
      )

      expect(capturedMessages.some((m) => m.role === 'system')).toBe(false)
    })

    it('drops prior history from the provider request when includeHistory is false', async () => {
      // Seed one prior turn.
      const service = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({ id: 'anthropic', respond: ['first reply'] }),
        }),
      })
      await service.sendMessage(
        { requestId: 'r-a', conversationId, providerConfigId: 'pc-1', model: 'claude-sonnet-4-5', content: 'first message' },
        () => {},
      )

      let capturedMessages: ProviderChatMessage[] = []
      const service2 = new ChatService({
        conversations,
        messages,
        contextService: new ContextService({ messages, workspaceFiles }),
        resolveProvider: () => ({
          provider: 'anthropic',
          chatProvider: createMockProvider({
            id: 'anthropic',
            respond: (request) => {
              capturedMessages = request.messages
              return ['second reply']
            },
          }),
        }),
      })
      await service2.sendMessage(
        {
          requestId: 'r-b',
          conversationId,
          providerConfigId: 'pc-1',
          model: 'claude-sonnet-4-5',
          content: 'second message, ignore history',
          contextSelection: {
            includeHistory: false,
            attachments: [],
            workspaceFilePaths: [],
            retrievalSnippetPaths: [],
          },
        },
        () => {},
      )

      expect(capturedMessages).toHaveLength(1)
      expect(capturedMessages[0]?.content).toBe('second message, ignore history')
      // The full thread is still persisted regardless of what was sent.
      expect(messages.listByConversation(conversationId)).toHaveLength(4)
    })
  })
})
