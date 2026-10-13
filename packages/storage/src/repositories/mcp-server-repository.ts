import { randomUUID } from 'node:crypto'
import type { McpEntry, McpServerConfig, McpTransport } from '@ai-workspace/shared'
import type { AppDatabase } from '../db'

interface McpServerRow {
  id: string
  name: string
  transport: string
  command: string
  args_json: string
  cwd: string | null
  env_json: string
  secret_env_keys: string
  url: string
  headers_json: string
  secret_header_keys: string
  secrets: Buffer | null
  enabled: number
  disabled_tools_json: string
  created_at: number
  updated_at: number
}

/** A non-secret variable / header as stored. */
export interface McpPlainEntry {
  key: string
  value: string
}

/** Everything the repository stores for a server. `secrets` is already encrypted by the main process. */
export interface McpServerWrite {
  name: string
  transport: McpTransport
  command: string
  args: string[]
  cwd: string | null
  env: McpPlainEntry[]
  secretEnvKeys: string[]
  url: string
  headers: McpPlainEntry[]
  secretHeaderKeys: string[]
  secrets: Buffer | null
  enabled: boolean
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function asPlainEntries(value: unknown): McpPlainEntry[] {
  if (!Array.isArray(value)) return []
  const out: McpPlainEntry[] = []
  for (const item of value as unknown[]) {
    if (item && typeof item === 'object') {
      const { key, value: v } = item as Partial<McpPlainEntry>
      if (typeof key === 'string' && typeof v === 'string') out.push({ key, value: v })
    }
  }
  return out
}

function toEntries(plain: McpPlainEntry[], secretKeys: string[]): McpEntry[] {
  return [
    ...plain.map((e): McpEntry => ({ key: e.key, value: e.value, secret: false })),
    // A secret's value is never read back out of the database into a config object.
    ...secretKeys.map((key): McpEntry => ({ key, value: null, secret: true })),
  ]
}

function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    command: row.command,
    args: asStrings(parseJson(row.args_json)),
    cwd: row.cwd,
    env: toEntries(asPlainEntries(parseJson(row.env_json)), asStrings(parseJson(row.secret_env_keys))),
    url: row.url,
    headers: toEntries(asPlainEntries(parseJson(row.headers_json)), asStrings(parseJson(row.secret_header_keys))),
    enabled: row.enabled === 1,
    disabledTools: asStrings(parseJson(row.disabled_tools_json)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Thrown for a duplicate name so callers can show a normal message. */
export class McpNameTakenError extends Error {
  constructor(name: string) {
    super(`An MCP server named "${name}" already exists.`)
    this.name = 'McpNameTakenError'
  }
}

/**
 * MCP server definitions (app-level). Secret values are an opaque encrypted blob here: `getSecrets` is for the main
 * process only and its result is never serialised to the renderer.
 */
export class McpServerRepository {
  constructor(private readonly db: AppDatabase) {}

  list(): McpServerConfig[] {
    return (this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC, name ASC').all() as McpServerRow[]).map(rowToConfig)
  }

  get(id: string): McpServerConfig | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined
    return row ? rowToConfig(row) : null
  }

  getByName(name: string): McpServerConfig | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name) as McpServerRow | undefined
    return row ? rowToConfig(row) : null
  }

  /** The encrypted secrets blob. Never expose the result to the renderer. */
  getSecrets(id: string): Buffer | null {
    const row = this.db.prepare('SELECT secrets FROM mcp_servers WHERE id = ?').get(id) as { secrets: Buffer | null } | undefined
    return row?.secrets ?? null
  }

  create(input: McpServerWrite): McpServerConfig {
    if (this.getByName(input.name)) throw new McpNameTakenError(input.name)
    const now = Date.now()
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id, name, transport, command, args_json, cwd, env_json, secret_env_keys, url, headers_json,
           secret_header_keys, secrets, enabled, disabled_tools_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.transport,
        input.command,
        JSON.stringify(input.args),
        input.cwd,
        JSON.stringify(input.env),
        JSON.stringify(input.secretEnvKeys),
        input.url,
        JSON.stringify(input.headers),
        JSON.stringify(input.secretHeaderKeys),
        input.secrets,
        input.enabled ? 1 : 0,
        now,
        now,
      )
    return this.get(id) as McpServerConfig
  }

  update(id: string, input: McpServerWrite): McpServerConfig {
    const existing = this.getByName(input.name)
    if (existing && existing.id !== id) throw new McpNameTakenError(input.name)
    const result = this.db
      .prepare(
        `UPDATE mcp_servers SET name = ?, transport = ?, command = ?, args_json = ?, cwd = ?, env_json = ?, secret_env_keys = ?,
           url = ?, headers_json = ?, secret_header_keys = ?, secrets = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.name,
        input.transport,
        input.command,
        JSON.stringify(input.args),
        input.cwd,
        JSON.stringify(input.env),
        JSON.stringify(input.secretEnvKeys),
        input.url,
        JSON.stringify(input.headers),
        JSON.stringify(input.secretHeaderKeys),
        input.secrets,
        input.enabled ? 1 : 0,
        Date.now(),
        id,
      )
    if (result.changes === 0) throw new Error(`MCP server not found: ${id}`)
    return this.get(id) as McpServerConfig
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig {
    const result = this.db.prepare('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?').run(enabled ? 1 : 0, Date.now(), id)
    if (result.changes === 0) throw new Error(`MCP server not found: ${id}`)
    return this.get(id) as McpServerConfig
  }

  setDisabledTools(id: string, tools: string[]): McpServerConfig {
    const unique = [...new Set(tools)]
    const result = this.db.prepare('UPDATE mcp_servers SET disabled_tools_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(unique), Date.now(), id)
    if (result.changes === 0) throw new Error(`MCP server not found: ${id}`)
    return this.get(id) as McpServerConfig
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
  }
}
