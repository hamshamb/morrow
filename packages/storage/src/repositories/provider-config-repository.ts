import { randomUUID } from 'node:crypto'
import type { ProviderConfigSummary, ProviderId } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface ProviderConfigRow {
  id: string
  provider: string
  label: string
  masked_key: string
  encrypted_key: Buffer
  base_url: string | null
  created_at: number
  updated_at: number
}

function rowToSummary(row: ProviderConfigRow): ProviderConfigSummary {
  return {
    id: row.id,
    provider: row.provider as ProviderId,
    label: row.label,
    maskedKey: row.masked_key,
    baseUrl: row.base_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Credential material needed to actually call a provider. Only ever used
 * inside the main process (to decrypt via Electron `safeStorage` right
 * before a request) — never serialized across the IPC boundary and never
 * exposed through `ProviderConfigSummary`.
 */
export interface ProviderCredential {
  id: string
  provider: ProviderId
  encryptedKey: Buffer
  baseUrl: string | null
}

export interface CreateProviderConfigInput {
  provider: ProviderId
  label: string
  maskedKey: string
  encryptedKey: Buffer
  baseUrl: string | null
}

export class ProviderConfigRepository {
  constructor(private readonly db: AppDatabase) {}

  list(): ProviderConfigSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM provider_configs ORDER BY created_at ASC')
      .all() as ProviderConfigRow[]
    return rows.map(rowToSummary)
  }

  getSummary(id: string): ProviderConfigSummary | null {
    const row = this.db.prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as
      | ProviderConfigRow
      | undefined
    return row ? rowToSummary(row) : null
  }

  /** Never expose the result of this method to the renderer. */
  getCredential(id: string): ProviderCredential | null {
    const row = this.db.prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as
      | ProviderConfigRow
      | undefined
    if (!row) return null
    return {
      id: row.id,
      provider: row.provider as ProviderId,
      encryptedKey: row.encrypted_key,
      baseUrl: row.base_url,
    }
  }

  create(input: CreateProviderConfigInput): ProviderConfigSummary {
    const now = Date.now()
    const summary: ProviderConfigSummary = {
      id: randomUUID(),
      provider: input.provider,
      label: input.label,
      maskedKey: input.maskedKey,
      baseUrl: input.baseUrl,
      createdAt: now,
      updatedAt: now,
    }
    this.db
      .prepare(
        `INSERT INTO provider_configs
           (id, provider, label, masked_key, encrypted_key, base_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        summary.id,
        summary.provider,
        summary.label,
        summary.maskedKey,
        input.encryptedKey,
        summary.baseUrl,
        summary.createdAt,
        summary.updatedAt,
      )
    return summary
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM provider_configs WHERE id = ?').run(id)
  }
}
