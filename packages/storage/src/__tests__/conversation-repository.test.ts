import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { ConversationRepository } from '../repositories/conversation-repository'
import { MessageRepository } from '../repositories/message-repository'

describe('ConversationRepository', () => {
  let db: AppDatabase
  let workspaces: WorkspaceRepository
  let repo: ConversationRepository
  let workspaceId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    workspaces = new WorkspaceRepository(db)
    repo = new ConversationRepository(db)
    workspaceId = workspaces.create({ name: 'Test workspace' }).id
  })

  afterEach(() => {
    db.close()
  })

  it('creates a conversation scoped to a workspace with a default title', () => {
    const conversation = repo.create({ workspaceId })
    expect(conversation.workspaceId).toBe(workspaceId)
    expect(conversation.title).toBe('New conversation')
  })

  it('honors an explicit title', () => {
    const conversation = repo.create({ workspaceId, title: 'Refactor plan' })
    expect(conversation.title).toBe('Refactor plan')
  })

  it('lists only conversations for the given workspace', () => {
    const otherWorkspaceId = workspaces.create({ name: 'Other' }).id
    repo.create({ workspaceId, title: 'A' })
    repo.create({ workspaceId, title: 'B' })
    repo.create({ workspaceId: otherWorkspaceId, title: 'C' })

    const list = repo.list(workspaceId)
    expect(list).toHaveLength(2)
    expect(list.map((c) => c.title).sort()).toEqual(['A', 'B'])
  })

  it('orders by most recently touched first', () => {
    const first = repo.create({ workspaceId, title: 'First' })
    const second = repo.create({ workspaceId, title: 'Second' })
    repo.touch(first.id)

    const [top] = repo.list(workspaceId)
    expect(top?.id).toBe(first.id)
    expect(second.id).not.toBe(top?.id)
  })

  it('deletes a conversation and cascades its messages', () => {
    const conversation = repo.create({ workspaceId })
    const messages = new MessageRepository(db)
    messages.create({
      conversationId: conversation.id,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'hi' }],
    })

    repo.delete(conversation.id)

    expect(repo.get(conversation.id)).toBeNull()
    expect(messages.listByConversation(conversation.id)).toHaveLength(0)
  })
})
