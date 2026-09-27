import type Database from 'better-sqlite3'
import type { Migration } from './types'

export const migration0002Chat: Migration = {
  version: 2,
  name: 'chat',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE conversations (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title        TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      CREATE INDEX idx_conversations_workspace_id ON conversations(workspace_id);

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        provider        TEXT,
        model           TEXT,
        status          TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);

      CREATE TABLE message_parts (
        id         TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        content    TEXT NOT NULL,
        position   INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_message_parts_message_id ON message_parts(message_id);

      -- Provider API keys are never stored in plaintext. encrypted_key is a
      -- ciphertext blob produced by Electron's safeStorage in the main
      -- process (see ADR-004); this package never sees a plaintext key.
      -- masked_key is a non-sensitive display preview (e.g. "sk-...ab12")
      -- computed once at creation time so the renderer never needs the raw
      -- key just to list configured providers.
      CREATE TABLE provider_configs (
        id            TEXT PRIMARY KEY,
        provider      TEXT NOT NULL,
        label         TEXT NOT NULL,
        masked_key    TEXT NOT NULL,
        encrypted_key BLOB NOT NULL,
        base_url      TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      );
    `)
  },
}
