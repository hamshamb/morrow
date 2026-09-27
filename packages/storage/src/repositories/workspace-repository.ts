import { randomUUID } from 'node:crypto'
import type { CreateWorkspaceInput, UpdateWorkspaceInput, Workspace } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface WorkspaceRow {
  id: string
  name: string
  description: string | null
  created_at: number
  updated_at: number
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class WorkspaceRepository {
  constructor(private readonly db: AppDatabase) {}

  list(): Workspace[] {
    const rows = this.db
      .prepare('SELECT * FROM workspaces ORDER BY updated_at DESC')
      .all() as WorkspaceRow[]
    return rows.map(rowToWorkspace)
  }

  get(id: string): Workspace | null {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
      WorkspaceRow | undefined
    return row ? rowToWorkspace(row) : null
  }

  create(input: CreateWorkspaceInput): Workspace {
    const now = Date.now()
    const workspace: Workspace = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        'INSERT INTO workspaces (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        workspace.id,
        workspace.name,
        workspace.description,
        workspace.createdAt,
        workspace.updatedAt,
      )
    return workspace
  }

  update(input: UpdateWorkspaceInput): Workspace {
    const existing = this.get(input.id)
    if (!existing) {
      throw new Error(`Workspace not found: ${input.id}`)
    }
    const updated: Workspace = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description === undefined ? existing.description : input.description,
      updatedAt: Date.now(),
    }
    this.db
      .prepare('UPDATE workspaces SET name = ?, description = ?, updated_at = ? WHERE id = ?')
      .run(updated.name, updated.description, updated.updatedAt, updated.id)
    return updated
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
  }
}
