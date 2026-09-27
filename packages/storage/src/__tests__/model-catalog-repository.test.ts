import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { ModelCatalogRepository } from '../repositories/model-catalog-repository'
import { ProviderConfigRepository } from '../repositories/provider-config-repository'

describe('ModelCatalogRepository', () => {
  let db: AppDatabase
  let repo: ModelCatalogRepository
  let providerConfigId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new ModelCatalogRepository(db)
    providerConfigId = new ProviderConfigRepository(db).create({
      provider: 'anthropic',
      label: 'Personal key',
      maskedKey: 'sk-...ab12',
      encryptedKey: Buffer.from('ciphertext'),
      baseUrl: null,
    }).id
  })

  afterEach(() => {
    db.close()
  })

  it('returns an empty catalog with a null fetchedAt before anything is cached', () => {
    expect(repo.listForProviderConfig(providerConfigId)).toEqual({
      providerConfigId,
      models: [],
      fetchedAt: null,
    })
  })

  it('caches a fetched model list and returns it back with the fetchedAt timestamp', () => {
    const models = [
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
    ]
    const saved = repo.replaceForProviderConfig(providerConfigId, models, 1_700_000_000_000)
    expect(saved.fetchedAt).toBe(1_700_000_000_000)
    expect(saved.models).toHaveLength(2)

    const listed = repo.listForProviderConfig(providerConfigId)
    expect(listed.fetchedAt).toBe(1_700_000_000_000)
    expect(listed.models.map((m) => m.id).sort()).toEqual(['claude-opus-5-5', 'claude-sonnet-5'])
  })

  it('fully replaces the previous catalog rather than merging with it', () => {
    repo.replaceForProviderConfig(
      providerConfigId,
      [{ id: 'model-a', displayName: null }],
      1_000,
    )
    repo.replaceForProviderConfig(
      providerConfigId,
      [{ id: 'model-b', displayName: null }],
      2_000,
    )
    const listed = repo.listForProviderConfig(providerConfigId)
    expect(listed.models.map((m) => m.id)).toEqual(['model-b'])
    expect(listed.fetchedAt).toBe(2_000)
  })

  it('a refresh that returns zero models clears the cache and reports fetchedAt as null', () => {
    repo.replaceForProviderConfig(providerConfigId, [{ id: 'model-a', displayName: null }], 1_000)
    const cleared = repo.replaceForProviderConfig(providerConfigId, [], 2_000)
    expect(cleared.models).toEqual([])
    expect(cleared.fetchedAt).toBeNull()
    expect(repo.listForProviderConfig(providerConfigId)).toEqual({
      providerConfigId,
      models: [],
      fetchedAt: null,
    })
  })

  it('preserves a null display name (e.g. OpenAI never returns one)', () => {
    repo.replaceForProviderConfig(providerConfigId, [{ id: 'gpt-4o', displayName: null }], 1_000)
    expect(repo.listForProviderConfig(providerConfigId).models).toEqual([
      { id: 'gpt-4o', displayName: null },
    ])
  })

  it('is scoped per provider config, not shared across configs', () => {
    const otherConfigId = new ProviderConfigRepository(db).create({
      provider: 'openai',
      label: 'Work key',
      maskedKey: 'sk-...cd34',
      encryptedKey: Buffer.from('other'),
      baseUrl: null,
    }).id
    repo.replaceForProviderConfig(providerConfigId, [{ id: 'claude-sonnet-5', displayName: null }], 1_000)
    repo.replaceForProviderConfig(otherConfigId, [{ id: 'gpt-4o', displayName: null }], 1_000)

    expect(repo.listForProviderConfig(providerConfigId).models.map((m) => m.id)).toEqual([
      'claude-sonnet-5',
    ])
    expect(repo.listForProviderConfig(otherConfigId).models.map((m) => m.id)).toEqual(['gpt-4o'])
  })

  it('cascades delete when the owning provider config is removed', () => {
    repo.replaceForProviderConfig(providerConfigId, [{ id: 'claude-sonnet-5', displayName: null }], 1_000)
    new ProviderConfigRepository(db).delete(providerConfigId)
    expect(repo.listForProviderConfig(providerConfigId)).toEqual({
      providerConfigId,
      models: [],
      fetchedAt: null,
    })
  })
})
