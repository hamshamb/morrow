import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { ConversationRepository } from '../repositories/conversation-repository'
import { MessageRepository } from '../repositories/message-repository'

describe('MessageRepository', () => {
  let db: AppDatabase
  let repo: MessageRepository
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversationId = new ConversationRepository(db).create({ workspaceId }).id
    repo = new MessageRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates a user message with no provider/model attribution', () => {
    const message = repo.create({
      conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'Hello there' }],
    })
    expect(message.role).toBe('user')
    expect(message.provider).toBeNull()
    expect(message.model).toBeNull()
    expect(message.parts).toHaveLength(1)
    expect(message.parts[0]?.content).toBe('Hello there')
  })

  it('creates an assistant message with provider/model attribution', () => {
    const message = repo.create({
      conversationId,
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      status: 'complete',
      parts: [{ type: 'text', content: 'Hi! How can I help?' }],
    })
    expect(message.provider).toBe('anthropic')
    expect(message.model).toBe('claude-sonnet-4-5')
  })

  it('preserves message order and per-message provider attribution across a mixed thread', () => {
    repo.create({
      conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'Q1' }],
    })
    repo.create({
      conversationId,
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      status: 'complete',
      parts: [{ type: 'text', content: 'A1 from Claude' }],
    })
    repo.create({
      conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'Q2' }],
    })
    repo.create({
      conversationId,
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-4o',
      status: 'complete',
      parts: [{ type: 'text', content: 'A2 from GPT-4o' }],
    })

    const thread = repo.listByConversation(conversationId)
    expect(thread).toHaveLength(4)
    expect(thread.map((m) => m.provider)).toEqual([null, 'anthropic', null, 'openai'])
    expect(thread.map((m) => m.model)).toEqual([null, 'claude-sonnet-4-5', null, 'gpt-4o'])
  })

  it('orders parts by position within a message', () => {
    const message = repo.create({
      conversationId,
      role: 'assistant',
      provider: 'google',
      model: 'gemini-2.0-flash',
      status: 'complete',
      parts: [
        { type: 'text', content: 'first' },
        { type: 'text', content: 'second' },
      ],
    })
    expect(message.parts.map((p) => p.content)).toEqual(['first', 'second'])
    expect(message.parts.map((p) => p.position)).toEqual([0, 1])
  })

  it('deletes a message', () => {
    const message = repo.create({
      conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'bye' }],
    })
    repo.delete(message.id)
    expect(repo.get(message.id)).toBeNull()
  })
})
