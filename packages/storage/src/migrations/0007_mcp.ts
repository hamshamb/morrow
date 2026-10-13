import type Database from 'better-sqlite3'
import type { Migration } from './types'

/**
 * Phase 7 - MCP server configuration (ADR-047). Additive only: one new table, no change to any existing table or row.
 * App-level (not per workspace): a server is something the user installed on this computer.
 *
 * Secrets (secret env vars, secret HTTP headers such as Authorization) are NOT in the plain columns: only their
 * KEYS are listed (so the UI can show "set"), and the values live in `secrets`, one blob encrypted with Electron's
 * safeStorage in the main process (the same mechanism as provider API keys, ADR-004).
 */
export const migration0007Mcp: Migration = {
  version: 7,
  name: 'mcp',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE mcp_servers (
        id                  TEXT PRIMARY KEY,
        -- Used in tool wire names (mcp__<name>__<tool>): ^[a-z0-9][a-z0-9-]{0,31}$
        name                TEXT NOT NULL UNIQUE,
        transport           TEXT NOT NULL,                -- stdio | http
        command             TEXT NOT NULL DEFAULT '',     -- stdio: the program (never run through a shell)
        args_json           TEXT NOT NULL DEFAULT '[]',   -- JSON array of strings (argv)
        cwd                 TEXT,
        env_json            TEXT NOT NULL DEFAULT '[]',   -- JSON [{key,value}]  NON-secret variables only
        secret_env_keys     TEXT NOT NULL DEFAULT '[]',   -- JSON array of names whose values are in 'secrets'
        url                 TEXT NOT NULL DEFAULT '',     -- http: https, or http for localhost
        headers_json        TEXT NOT NULL DEFAULT '[]',   -- JSON [{key,value}]  NON-secret headers only
        secret_header_keys  TEXT NOT NULL DEFAULT '[]',
        secrets             BLOB,                         -- safeStorage-encrypted JSON {env:{..},headers:{..}}
        enabled             INTEGER NOT NULL DEFAULT 1,
        disabled_tools_json TEXT NOT NULL DEFAULT '[]',   -- tool names the user switched off
        created_at          INTEGER NOT NULL,
        updated_at          INTEGER NOT NULL
      );
    `)
  },
}
