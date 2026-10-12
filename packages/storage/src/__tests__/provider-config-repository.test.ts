import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { runMigrations } from '../migrations'
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

  it('stores any registry provider id and a keyless (empty-blob) local provider', () => {
    const groq = repo.create({
      provider: 'groq',
      label: 'Groq',
      maskedKey: 'gsk_...1234',
      encryptedKey: Buffer.from('c'),
      baseUrl: null,
    })
    const ollama = repo.create({
      provider: 'ollama',
      label: 'Ollama',
      maskedKey: 'no key',
      encryptedKey: Buffer.alloc(0),
      baseUrl: 'http://localhost:11434/v1',
    })
    expect(repo.getSummary(groq.id)?.provider).toBe('groq')
    expect(repo.getCredential(ollama.id)?.encryptedKey.length).toBe(0)
    expect(repo.list().map((c) => c.provider)).toEqual(['groq', 'ollama'])
  })

  it('re-running migrations on a database that already has rows preserves every row (no migration is needed for generalized provider ids)', () => {
    const rows = [
      repo.create({ provider: 'anthropic', label: 'A', maskedKey: 'm1', encryptedKey: Buffer.from('k1'), baseUrl: null }),
      repo.create({ provider: 'openai', label: 'O', maskedKey: 'm2', encryptedKey: Buffer.from('k2'), baseUrl: 'https://proxy.example/v1' }),
      repo.create({ provider: 'google', label: 'G', maskedKey: 'm3', encryptedKey: Buffer.from('k3'), baseUrl: null }),
    ]
    const before = db.prepare('SELECT * FROM provider_configs ORDER BY id').all()
    const versionsBefore = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()

    runMigrations(db)

    expect(db.prepare('SELECT * FROM provider_configs ORDER BY id').all()).toEqual(before)
    expect(db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).toEqual(versionsBefore)
    expect(repo.list().map((c) => c.id)).toEqual(rows.map((r) => r.id))
    // the provider column has no CHECK constraint, so new ids need no schema change
    const cols = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'provider_configs'").get() as { sql: string }
    expect(cols.sql).not.toMatch(/CHECK/i)
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
