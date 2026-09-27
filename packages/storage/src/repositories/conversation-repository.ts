import { randomUUID } from 'node:crypto'
import type { Conversation, CreateConversationInput } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface ConversationRow {
  id: string
  workspace_id: string
  title: string
  created_at: number
  updated_at: number
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class ConversationRepository {
  constructor(private readonly db: AppDatabase) {}

  list(workspaceId: string): Conversation[] {
    const rows = this.db
      .prepare('SELECT * FROM conversations WHERE workspace_id = ? ORDER BY updated_at DESC')
      .all(workspaceId) as ConversationRow[]
    return rows.map(rowToConversation)
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
      | ConversationRow
      | undefined
    return row ? rowToConversation(row) : null
  }

  create(input: CreateConversationInput): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: input.title ?? 'New conversation',
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        'INSERT INTO conversations (id, workspace_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        conversation.id,
        conversation.workspaceId,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
      )
    return conversation
  }

  /** Bumps `updatedAt` — used whenever a message is added so recently-active
   * conversations sort to the top of `list()`. */
  touch(id: string): void {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id)
  }
}
