import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { ProviderConfigRepository } from '../repositories/provider-config-repository'

describe('ProviderConfigRepository', () => {
  let db: AppDatabase
  let repo: ProviderConfigRepository

  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new ProviderConfigRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('creates a provider config and returns a summary without the raw/encrypted key', () => {
    const summary = repo.create({
      provider: 'anthropic',
      label: 'Personal key',
      maskedKey: 'sk-...ab12',
      encryptedKey: Buffer.from('ciphertext'),
      baseUrl: null,
    })
    expect(summary).not.toHaveProperty('encryptedKey')
    expect(summary).not.toHaveProperty('apiKey')
    expect(summary.maskedKey).toBe('sk-...ab12')
    expect(summary.provider).toBe('anthropic')
  })

  it('lists summaries without exposing the encrypted key', () => {
    repo.create({
      provider: 'openai',
      label: 'Work key',
      maskedKey: 'sk-...cd34',
      encryptedKey: Buffer.from('secret-bytes'),
      baseUrl: null,
    })
    const list = repo.list()
    expect(list).toHaveLength(1)
    for (const item of list) {
      expect(item).not.toHaveProperty('encryptedKey')
    }
  })

  it('round-trips the encrypted key bytes via getCredential for main-process use only', () => {
    const created = repo.create({
      provider: 'google',
      label: 'Gemini key',
      maskedKey: 'AIza...wxyz',
      encryptedKey: Buffer.from([1, 2, 3, 4]),
      baseUrl: 'https://generativelanguage.googleapis.com',
    })
    const credential = repo.getCredential(created.id)
    expect(credential).not.toBeNull()
    expect(credential?.encryptedKey.equals(Buffer.from([1, 2, 3, 4]))).toBe(true)
    expect(credential?.baseUrl).toBe('https://generativelanguage.googleapis.com')
  })

  it('returns null for a missing id', () => {
    expect(repo.getCredential('missing')).toBeNull()
    expect(repo.getSummary('missing')).toBeNull()
  })

  it('deletes a provider config', () => {
    const created = repo.create({
      provider: 'anthropic',
      label: 'X',
      maskedKey: 'sk-...0000',
      encryptedKey: Buffer.from('x'),
      baseUrl: null,
    })
    repo.delete(created.id)
    expect(repo.getSummary(created.id)).toBeNull()
  })
})
