import { randomUUID } from 'node:crypto'
import type { Attachment } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface AttachmentRow {
  id: string
  message_id: string
  filename: string
  mime_type: string
  size_bytes: number
  content: string
  created_at: number
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

export interface CreateAttachmentInput {
  messageId: string
  filename: string
  mimeType: string
  sizeBytes: number
  content: string
}

export class AttachmentRepository {
  constructor(private readonly db: AppDatabase) {}

  listForMessage(messageId: string): Attachment[] {
    const rows = this.db
      .prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at ASC')
      .all(messageId) as AttachmentRow[]
    return rows.map(rowToAttachment)
  }

  get(id: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as
      | AttachmentRow
      | undefined
    return row ? rowToAttachment(row) : null
  }

  create(input: CreateAttachmentInput): Attachment {
    const now = Date.now()
    const attachment: Attachment = {
      id: randomUUID(),
      messageId: input.messageId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      content: input.content,
      createdAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO attachments (id, message_id, filename, mime_type, size_bytes, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attachment.id,
        attachment.messageId,
        attachment.filename,
        attachment.mimeType,
        attachment.sizeBytes,
        attachment.content,
        attachment.createdAt,
      )
    return attachment
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id)
  }
}
