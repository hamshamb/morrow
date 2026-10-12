import type Database from 'better-sqlite3'
import type { Migration } from './types'

/**
 * Phase 6 — multi-model orchestration (ADR-027). Additive only: every new
 * column is nullable or has a default, so existing rows stay valid and behave
 * exactly as before (`in_context` defaults to 1 = replayed to providers,
 * `orchestration_mode` to 'normal', everything else NULL).
 */
export const migration0005Orchestration: Migration = {
  version: 5,
  name: 'orchestration',
  up(db: Database.Database) {
    db.exec(`
      -- Groups the sibling replies to one user turn (= the user message's id).
      -- NULL on rows written before this migration and on user messages.
      ALTER TABLE messages ADD COLUMN reply_group_id TEXT;
      -- normal | compare | review | roundtable | auto
      ALTER TABLE messages ADD COLUMN orchestration_mode TEXT NOT NULL DEFAULT 'normal';
      -- proposal | critique | alternative | synthesis | review | revision
      ALTER TABLE messages ADD COLUMN role_label TEXT;
      -- 0 = persisted and visible but never sent to a provider again.
      ALTER TABLE messages ADD COLUMN in_context INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE messages ADD COLUMN auto_reason TEXT;
      -- Position inside the reply group (compare column / pipeline step).
      ALTER TABLE messages ADD COLUMN reply_index INTEGER;
      -- 1-based round number inside a round table.
      ALTER TABLE messages ADD COLUMN round_index INTEGER;
      -- Provider-reported usage (NULL when none was reported; Phase 2 stored none).
      ALTER TABLE messages ADD COLUMN input_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN output_tokens INTEGER;
      ALTER TABLE messages ADD COLUMN latency_ms INTEGER;
      -- Estimated USD cost = models.dev price x usage; NULL when unknown.
      ALTER TABLE messages ADD COLUMN est_cost_usd REAL;
      -- Why a failed reply failed (provider message), so an errored compare
      -- column still explains itself after a restart.
      ALTER TABLE messages ADD COLUMN error_text TEXT;

      CREATE INDEX idx_messages_reply_group_id ON messages(reply_group_id);
    `)
  },
}
