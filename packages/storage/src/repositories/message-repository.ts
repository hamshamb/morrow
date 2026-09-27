import { randomUUID } from 'node:crypto'
import type {
  Attachment,
  Message,
  MessagePart,
  MessageRole,
  MessageStatus,
  ProviderId,
} from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface MessageRow {
  id: string
  conversation_id: string
  role: string
  provider: string | null
  model: string | null
  status: string
  created_at: number
  updated_at: number
}

interface MessagePartRow {
  id: string
  message_id: string
  type: string
  content: string
  position: number
  created_at: number
}

interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  mime_type: string
  size_bytes: number
  content: string
  created_at: number
}

function rowToPart(row: MessagePartRow): MessagePart {
  return {
    id: row.id,
    messageId: row.message_id,
    type: row.type as MessagePart['type'],
    content: row.content,
    position: row.position,
    createdAt: row.created_at,
  }
}

function rowToAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    content: row.content,
    createdAt: row.created_at,
  }
}

function rowToMessage(row: MessageRow, parts: MessagePart[], attachments: Attachment[]): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as MessageRole,
    provider: (row.provider as ProviderId | null) ?? null,
    model: row.model,
    status: row.status as MessageStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parts,
    attachments,
  }
}

export interface CreateMessageInput {
  conversationId: string
  role: MessageRole
  provider: ProviderId | null
  model: string | null
  status: MessageStatus
  parts: { type: 'text'; content: string }[]
  /** Files attached to this message, persisted in the same transaction as
   * the message itself — attachments are always created alongside their
   * message, never added to one after the fact (see ARCHITECTURE.md). */
  attachments?: { filename: string; mimeType: string; sizeBytes: number; content: string }[]
}

export class MessageRepository {
  constructor(private readonly db: AppDatabase) {}

  private partsFor(messageId: string): MessagePart[] {
    const rows = this.db
      .prepare('SELECT * FROM message_parts WHERE message_id = ? ORDER BY position ASC')
      .all(messageId) as MessagePartRow[]
    return rows.map(rowToPart)
  }

  private attachmentsFor(messageId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC')
      .all(messageId) as AttachmentRow[]
    return rows.map(rowToAttachment)
  }

  listByConversation(conversationId: string): Message[] {
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
      .all(conversationId) as MessageRow[]
    return rows.map((row) => rowToMessage(row, this.partsFor(row.id), this.attachmentsFor(row.id)))
  }

  get(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as
      | MessageRow
      | undefined
    return row ? rowToMessage(row, this.partsFor(row.id), this.attachmentsFor(row.id)) : null
  }

  create(input: CreateMessageInput): Message {
    const now = Date.now()
    const id = randomUUID()
    const parts: MessagePart[] = input.parts.map((part, index) => ({
      id: randomUUID(),
      messageId: id,
      type: part.type,
      content: part.content,
      position: index,
      createdAt: now,
    }))
    const attachments: Attachment[] = (input.attachments ?? []).map((attachment) => ({
      id: randomUUID(),
      messageId: id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      content: attachment.content,
      createdAt: now,
    }))

    const insertMessage = this.db.prepare(
      `INSERT INTO messages (id, conversation_id, role, provider, model, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const insertPart = this.db.prepare(
      `INSERT INTO message_parts (id, message_id, type, content, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    const insertAttachment = this.db.prepare(
      `INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )

    const write = this.db.transaction(() => {
      insertMessage.run(
        id,
        input.conversationId,
        input.role,
        input.provider,
        input.model,
        input.status,
        now,
        now,
      )
      for (const part of parts) {
        insertPart.run(part.id, part.messageId, part.type, part.content, part.position, part.createdAt)
      }
      for (const attachment of attachments) {
        insertAttachment.run(
          attachment.id,
          attachment.messageId,
          attachment.filename,
          attachment.mimeType,
          attachment.sizeBytes,
          attachment.content,
          attachment.createdAt,
        )
      }
    })
    write()

    return {
      id,
      conversationId: input.conversationId,
      role: input.role,
      provider: input.provider,
      model: input.model,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      parts,
      attachments,
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }
}
