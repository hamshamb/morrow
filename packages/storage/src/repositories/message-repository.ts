import { randomUUID } from 'node:crypto'
import type {
  Attachment,
  Message,
  MessagePart,
  OrchestrationMode,
  RoleLabel,
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
  reply_group_id: string | null
  orchestration_mode: string
  role_label: string | null
  in_context: number
  auto_reason: string | null
  reply_index: number | null
  round_index: number | null
  input_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  est_cost_usd: number | null
  error_text: string | null
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
    replyGroupId: row.reply_group_id,
    orchestrationMode: row.orchestration_mode as OrchestrationMode,
    roleLabel: row.role_label as RoleLabel | null,
    inContext: row.in_context !== 0,
    autoReason: row.auto_reason,
    replyIndex: row.reply_index,
    roundIndex: row.round_index,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    latencyMs: row.latency_ms,
    estCostUsd: row.est_cost_usd,
    errorText: row.error_text,
  }
}

/** Orchestration metadata (migration 0005); every field is optional and
 * defaults to what a plain single-model reply has. */
export interface MessageOrchestrationInput {
  replyGroupId?: string | null
  orchestrationMode?: OrchestrationMode
  roleLabel?: RoleLabel | null
  inContext?: boolean
  autoReason?: string | null
  replyIndex?: number | null
  roundIndex?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  latencyMs?: number | null
  estCostUsd?: number | null
  errorText?: string | null
}

export interface CreateMessageInput extends MessageOrchestrationInput {
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
      .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
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

    const meta = {
      replyGroupId: input.replyGroupId ?? null,
      orchestrationMode: input.orchestrationMode ?? ('normal' as OrchestrationMode),
      roleLabel: input.roleLabel ?? null,
      inContext: input.inContext ?? true,
      autoReason: input.autoReason ?? null,
      replyIndex: input.replyIndex ?? null,
      roundIndex: input.roundIndex ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      latencyMs: input.latencyMs ?? null,
      estCostUsd: input.estCostUsd ?? null,
      errorText: input.errorText ?? null,
    }
    const insertMessage = this.db.prepare(
      `INSERT INTO messages (
         id, conversation_id, role, provider, model, status, created_at, updated_at,
         reply_group_id, orchestration_mode, role_label, in_context, auto_reason,
         reply_index, round_index, input_tokens, output_tokens, latency_ms, est_cost_usd, error_text
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        meta.replyGroupId,
        meta.orchestrationMode,
        meta.roleLabel,
        meta.inContext ? 1 : 0,
        meta.autoReason,
        meta.replyIndex,
        meta.roundIndex,
        meta.inputTokens,
        meta.outputTokens,
        meta.latencyMs,
        meta.estCostUsd,
        meta.errorText,
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
      ...meta,
    }
  }

  /** The assistant replies of one reply group, in column / step order. */
  listGroupReplies(replyGroupId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
         WHERE reply_group_id = ? AND role = 'assistant'
         ORDER BY COALESCE(reply_index, 0) ASC, created_at ASC, rowid ASC`,
      )
      .all(replyGroupId) as MessageRow[]
    return rows.map((row) => rowToMessage(row, this.partsFor(row.id), this.attachmentsFor(row.id)))
  }

  /**
   * `[continue with this]`: makes `messageId` the one reply of its group that
   * later turns see (in_context = 1) and takes every other reply of the group
   * out of the context. Nothing is deleted — excluded replies stay persisted
   * and visible. A reply with no group (rows from before orchestration) has no
   * siblings, so it is simply marked in-context. Returns the updated group.
   */
  chooseReply(messageId: string): Message[] {
    const target = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | MessageRow
      | undefined
    if (!target) throw new Error(`Message not found: ${messageId}`)
    if (target.role !== 'assistant') throw new Error('Only an assistant reply can be chosen for the context')
    const choose = this.db.transaction(() => {
      if (target.reply_group_id) {
        this.db
          .prepare(`UPDATE messages SET in_context = 0 WHERE reply_group_id = ? AND role = 'assistant'`)
          .run(target.reply_group_id)
      }
      this.db.prepare('UPDATE messages SET in_context = 1 WHERE id = ?').run(messageId)
    })
    choose()
    if (target.reply_group_id) return this.listGroupReplies(target.reply_group_id)
    const single = this.get(messageId)
    return single ? [single] : []
  }

  /** Marks one message in or out of the context without touching its siblings. */
  setInContext(messageId: string, inContext: boolean): void {
    this.db.prepare('UPDATE messages SET in_context = ? WHERE id = ?').run(inContext ? 1 : 0, messageId)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }
}
