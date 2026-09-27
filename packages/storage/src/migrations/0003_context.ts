import type Database from 'better-sqlite3'
import type { Migration } from './types'

export const migration0003Context: Migration = {
  version: 3,
  name: 'context',
  up(db: Database.Database) {
    db.exec(`
      -- Files attached to a chat message. Content is extracted text only
      -- (see SUPPORTED_TEXT_EXTENSIONS in @ai-workspace/shared) — never a
      -- binary blob. Scoped to the message it was attached to; deleted
      -- along with it.
      CREATE TABLE attachments (
        id          TEXT PRIMARY KEY,
        message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        filename    TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        content     TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX idx_attachments_message_id ON attachments(message_id);

      -- One local folder per workspace, used as the root for file
      -- browsing/indexing/retrieval. Never auto-populated — the user must
      -- explicitly pick a folder (see ARCHITECTURE.md security model).
      CREATE TABLE workspace_file_roots (
        workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        root_path    TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      -- Metadata (+ extracted text content, when eligible) for every file
      -- discovered under a workspace's file root that survived the
      -- .gitignore + built-in deny-list filter. Fully replaced on every
      -- (re)index — see DECISIONS.md (no incremental diffing in V1).
      CREATE TABLE workspace_files (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        mtime_ms      INTEGER NOT NULL,
        content       TEXT,
        indexed_at    INTEGER NOT NULL,
        UNIQUE(workspace_id, relative_path)
      );

      CREATE INDEX idx_workspace_files_workspace_id ON workspace_files(workspace_id);

      -- Lexical (FTS5) index over indexed file content, for the Phase 3
      -- retrieval baseline. Deliberately NOT an embeddings/vector index —
      -- see DECISIONS.md for why lexical search is the V1 baseline.
      -- file_id/workspace_id are UNINDEXED (stored, not tokenized) so a
      -- search can be scoped to one workspace and results mapped back to
      -- workspace_files without a second lookup.
      CREATE VIRTUAL TABLE workspace_files_fts USING fts5(
        file_id UNINDEXED,
        workspace_id UNINDEXED,
        relative_path,
        content
      );

      -- Keeps the FTS index in sync with workspace_files on delete,
      -- including cascade deletes from workspace_files_fts's own FK and
      -- from a workspace being deleted — better-sqlite3/SQLite fires
      -- triggers for cascade deletes too, so this is the only place FTS
      -- cleanup needs to be handled.
      CREATE TRIGGER trg_workspace_files_ad AFTER DELETE ON workspace_files
      BEGIN
        DELETE FROM workspace_files_fts WHERE file_id = old.id;
      END;
    `)
  },
}
