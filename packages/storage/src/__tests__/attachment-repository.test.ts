import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { ConversationRepository } from '../repositories/conversation-repository'
import { MessageRepository } from '../repositories/message-repository'
import { AttachmentRepository } from '../repositories/attachment-repository'

describe('AttachmentRepository', () => {
  let db: AppDatabase
  let repo: AttachmentRepository
  let messageId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    const workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    const conversationId = new ConversationRepository(db).create({ workspaceId }).id
    messageId = new MessageRepository(db).create({
      conversationId,
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      parts: [{ type: 'text', content: 'See attached' }],
    }).id
    repo = new AttachmentRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates an attachment scoped to a message', () => {
    const attachment = repo.create({
      messageId,
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 11,
      content: '# Notes\n\n',
    })
    expect(attachment.messageId).toBe(messageId)
    expect(attachment.filename).toBe('notes.md')
    expect(repo.get(attachment.id)).toEqual(attachment)
  })

  it('lists attachments for a message in creation order', () => {
    repo.create({ messageId, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, content: 'a' })
    repo.create({ messageId, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, content: 'b' })
    const list = repo.listForMessage(messageId)
    expect(list.map((a) => a.filename)).toEqual(['a.txt', 'b.txt'])
  })

  it('returns an empty list for a message with no attachments', () => {
    expect(repo.listForMessage(messageId)).toEqual([])
  })

  it('deletes an attachment', () => {
    const attachment = repo.create({
      messageId,
      filename: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      content: 'a',
    })
    repo.delete(attachment.id)
    expect(repo.get(attachment.id)).toBeNull()
  })

  it('cascades deletes when the owning message is deleted', () => {
    const attachment = repo.create({
      messageId,
      filename: 'a.txt',
      mimeType: 'text/plain',
      sizeBytes: 1,
      content: 'a',
    })
    new MessageRepository(db).delete(messageId)
    expect(repo.get(attachment.id)).toBeNull()
  })
})
