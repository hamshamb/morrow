import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { SettingsRepository } from '../repositories/settings-repository'

describe('WorkspaceRepository', () => {
  let db: AppDatabase
  let repo: WorkspaceRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new WorkspaceRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates and lists workspaces', () => {
    repo.create({ name: 'First' })
    repo.create({ name: 'Second', description: 'desc' })
    const all = repo.list()
    expect(all).toHaveLength(2)
    expect(all.map((w) => w.name).sort()).toEqual(['First', 'Second'])
  })

  it('persists a workspace across repository instances on the same db handle', () => {
    const created = repo.create({ name: 'Persisted' })
    const reopened = new WorkspaceRepository(db)
    expect(reopened.get(created.id)?.name).toBe('Persisted')
  })

  it('updates a workspace', () => {
    const created = repo.create({ name: 'Original' })
    const updated = repo.update({ id: created.id, name: 'Renamed' })
    expect(updated.name).toBe('Renamed')
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  })

  it('throws when updating a missing workspace', () => {
    expect(() => repo.update({ id: 'missing', name: 'x' })).toThrow()
  })

  it('deletes a workspace', () => {
    const created = repo.create({ name: 'ToDelete' })
    repo.delete(created.id)
    expect(repo.get(created.id)).toBeNull()
  })
})

describe('SettingsRepository', () => {
  let db: AppDatabase
  let repo: SettingsRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new SettingsRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('returns defaults when nothing stored', () => {
    expect(repo.get()).toEqual({ theme: 'system', activeWorkspaceId: null })
  })

  it('persists partial updates and merges with existing state', () => {
    repo.set({ theme: 'dark' })
    repo.set({ activeWorkspaceId: 'ws-1' })
    expect(repo.get()).toEqual({ theme: 'dark', activeWorkspaceId: 'ws-1' })
  })

  it('rejects invalid theme values', () => {
    expect(() => repo.set({ theme: 'neon' as never })).toThrow()
  })
})
