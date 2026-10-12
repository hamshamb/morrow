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
    expect(repo.get()).toEqual({
      theme: 'system',
      activeWorkspaceId: null,
      lastModelSelection: null,
      favoriteModels: [],
      recentModels: [],
      modelsDevFetchEnabled: true,
      autoPreference: 'balanced',
    })
  })

  it('persists partial updates and merges with existing state', () => {
    repo.set({ theme: 'dark' })
    repo.set({ activeWorkspaceId: 'ws-1' })
    expect(repo.get()).toEqual({
      theme: 'dark',
      activeWorkspaceId: 'ws-1',
      lastModelSelection: null,
      favoriteModels: [],
      recentModels: [],
      modelsDevFetchEnabled: true,
      autoPreference: 'balanced',
    })
  })

  it('persists a last-used model selection and merges it with other settings', () => {
    repo.set({
      lastModelSelection: { providerConfigId: 'pc-1', model: 'claude-sonnet-5', effort: 'high' },
    })
    repo.set({ theme: 'dark' })
    expect(repo.get()).toEqual({
      theme: 'dark',
      activeWorkspaceId: null,
      lastModelSelection: { providerConfigId: 'pc-1', model: 'claude-sonnet-5', effort: 'high' },
      favoriteModels: [],
      recentModels: [],
      modelsDevFetchEnabled: true,
      autoPreference: 'balanced',
    })
  })

  it('persists favorite and recent models alongside the other settings', () => {
    repo.set({ favoriteModels: [{ providerConfigId: 'pc-1', model: 'claude-sonnet-5' }] })
    repo.set({
      recentModels: [{ providerConfigId: 'pc-2', model: 'gpt-5.1', effort: null }],
    })
    const stored = repo.get()
    expect(stored.favoriteModels).toEqual([{ providerConfigId: 'pc-1', model: 'claude-sonnet-5' }])
    expect(stored.recentModels).toEqual([{ providerConfigId: 'pc-2', model: 'gpt-5.1', effort: null }])
  })

  it('reads settings written before favorites/recents/modelsDevFetchEnabled existed (no migration needed)', () => {
    // Simulates a pre-existing key/value settings table from an older build.
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
    upsert.run('theme', JSON.stringify('dark'))
    upsert.run('activeWorkspaceId', JSON.stringify('ws-1'))
    upsert.run('lastModelSelection', JSON.stringify(null))
    expect(repo.get()).toEqual({
      theme: 'dark',
      activeWorkspaceId: 'ws-1',
      lastModelSelection: null,
      favoriteModels: [],
      recentModels: [],
      modelsDevFetchEnabled: true,
      autoPreference: 'balanced',
    })
  })

  it('persists the models.dev opt-out and later unrelated updates do not undo it', () => {
    repo.set({ modelsDevFetchEnabled: false })
    repo.set({ theme: 'light' })
    expect(repo.get().modelsDevFetchEnabled).toBe(false)
  })

  it('rejects invalid theme values', () => {
    expect(() => repo.set({ theme: 'neon' as never })).toThrow()
  })
})
