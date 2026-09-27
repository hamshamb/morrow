# Build State

**Current phase:** Phase 3 — Context / Files (complete) → Phase 4 next

**Completed:**

- Phase 0: environment inspected, core V1 dependency licenses verified
  (all MIT/Apache-2.0), `git init`, docs/ARCHITECTURE.md, docs/DECISIONS.md,
  docs/OPEN_SOURCE_INVENTORY.md, docs/BUILD_STATE.md created.
- Phase 1: pnpm workspace monorepo (`apps/desktop`, `packages/shared`,
  `packages/storage`); strict TypeScript base config; ESLint 10 flat config
  + Prettier; Electron shell via `electron-vite` (main/preload/renderer,
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  single-instance lock); typed IPC contract (`@ai-workspace/shared`
  `RendererApi` + `IPC_CHANNELS`) — no ad hoc `ipcRenderer.invoke` outside
  preload; SQLite via `better-sqlite3` with a versioned migration runner
  (`schema_migrations` table); `WorkspaceRepository` +  `SettingsRepository`;
  React 19 renderer — sidebar (workspace list/create), workspace view
  (rename/delete), theme toggle (light/dark/system via `data-theme` +
  `prefers-color-scheme`).
- Phase 2: AI chat.
  - `packages/providers` (new): our own `ChatProvider` interface
    (`streamChat` -> `AsyncIterable<ProviderStreamEvent>`) wrapping `ai` +
    `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google`; a
    network-free `createMockProvider` for tests; `createProvider(providerId,
    credentials)` factory. No SDK types leak outside this package (ADR-003).
  - `packages/storage`: migration `0002_chat` adds `conversations`,
    `messages`, `message_parts` (workspace-scoped, per-message
    `provider`/`model` attribution, cascading deletes), and
    `provider_configs` (`masked_key` + `encrypted_key BLOB`, never a
    plaintext key — ADR-004, ADR-009). New `ConversationRepository`,
    `MessageRepository`, `ProviderConfigRepository` following the existing
    repository pattern.
  - `packages/shared`: `ProviderId`/`ProviderConfigSummary` schemas (never
    round-trip a raw/encrypted key to the renderer), `Conversation`/
    `Message`/`MessagePart`/`ChatStreamEvent` schemas; `RendererApi`
    extended with `conversations`, `providerConfigs`, `chat` surfaces;
    `chatStreamChannel(requestId)` helper for the per-request streaming
    channel (ADR-008).
  - `apps/desktop` main process: `credential-store.ts` wraps Electron
    `safeStorage` (encrypt/decrypt/mask, never keytar — ADR-004);
    `chat-service.ts` (`ChatService`, no Electron imports, fully unit
    testable) orchestrates persist-user-message -> replay history through
    the resolved provider -> stream deltas -> persist assistant message
    with attribution, and supports per-`requestId` cancellation via
    `AbortController`; new IPC handlers (`ipc/conversation.ts`,
    `ipc/provider-config.ts`, `ipc/chat.ts`) wire it all up; streaming goes
    main -> renderer over a dynamic per-request `webContents.send` channel
    (ADR-008).
  - Renderer: `ChatPanel` (conversation list + message thread + composer)
    embedded in `WorkspaceView`; `MessageList` renders markdown
    (`react-markdown` + `remark-gfm`, both MIT) with per-message
    provider/model attribution; `ModelSelector` (provider config + a small
    hardcoded per-provider model list); cancel button while streaming;
    "Regenerate" re-submits the last user turn (appends a new assistant
    message rather than branching, consistent with the provider-agnostic
    conversation model); `SettingsPanel` to add/test/remove provider API
    keys (masked input, key never echoed back, never logged).

**Tests:**

- `packages/shared`: 37 unit tests (zod schema boundaries — workspace,
  settings, provider config, conversation/message, chat stream events,
  attachment/pending-attachment, workspace-file root/search input,
  `estimateTokens`, context source/selection/inspector-input schemas).
- `packages/storage`: 47 unit tests (`WorkspaceRepository`,
  `SettingsRepository`, `ConversationRepository` incl. cascade delete,
  `MessageRepository` incl. multi-provider thread ordering/attribution and
  attachment persistence/hydration, `ProviderConfigRepository` incl. that
  summaries never expose the encrypted key, `AttachmentRepository` incl.
  cascade delete with its message, `WorkspaceFileRepository` incl.
  root set/update/cascade-delete, `replaceIndex`/`listFiles`/
  `getFileContent`, and FTS5 `search()` in both `'and'` and `'or'` modes),
  against an in-memory SQLite db.
- `packages/providers`: 8 unit tests (`createMockProvider` streaming/error/
  abort behavior, `createProvider` factory dispatch per provider id). No
  network calls.
- `apps/desktop`: 38 integration/unit tests:
  - `ChatService` (5 Phase 2 + 5 Phase 3, in-memory SQLite +
    `createMockProvider` — no network): the original Phase 2 behaviors
    (attribution, multi-provider thread, partial-message-on-error,
    unknown-conversation throw, cancellation) plus Phase 3: persists
    attachments scoped to the new user message without leaking them into
    its own displayed text; injects the resolved context block as one
    extra, non-persisted `role: 'system'` provider message; resolves
    selected workspace files by reading real indexed content; sends
    nothing extra when no context is selected (proves Phase 2 behavior is
    unchanged); drops prior history from the provider request (but not
    from what's persisted) when `includeHistory: false`.
  - `ContextService`: `buildInspectorState` (history char count incl.
    draft, per-attachment/per-file sources, auto-surfaced retrieval
    snippets excluding already-selected files, no retrieval on a
    too-short draft, total/token rollups) and `resolveContextBlock`
    (attachment/file/retrieval content inclusion, per-source and total
    character-cap truncation and ordered source-dropping).
  - `walkWorkspaceFiles`: indexes an eligible file's content; lists but
    never reads an unsupported-but-not-denied extension; **proves the
    exclusion deny-list actually works** — `.env`/`.env.local`,
    `node_modules/`, `.git/`, and private-key files never appear in the
    walk result even with an empty/absent `.gitignore`; an additional
    `.gitignore` exclusion is respected; symlinks are not followed; a
    combined fixture tree surfaces only the safe files.
  - `readAttachmentFile`: mime-type inference, unsupported-extension
    rejection, oversized-file rejection.
- All of the above pass: `pnpm -r typecheck`, `eslint .`, `pnpm -r test`
  clean (130 tests total).
- Manual: `pnpm --filter @ai-workspace/desktop build` succeeds;
  `pnpm --filter @ai-workspace/desktop start` launches the packaged app
  with no main-process errors (only the same benign Chromium
  GPU-disk-cache warnings seen in Phase 1 under a restricted profile dir).
- **VERIFIED (manually, by the user, against real provider APIs)**: live
  Anthropic and OpenAI keys added through the Settings panel, "Test
  connection" succeeded, and chat confirmed working end-to-end through the
  UI. This also caught two real bugs, both fixed and committed:
  - Stale/retired Claude model ids (`claude-3-5-haiku-latest`,
    `claude-sonnet-4-5`, `claude-opus-4-1`) in the test-connection call and
    `ModelSelector` catalog caused every Anthropic connection test to fail
    with `not_found_error` regardless of key validity. Fixed to the current
    Claude 5 family (`claude-sonnet-5`, `claude-opus-5-5`,
    `claude-haiku-4-5-20251001`) — commit `1351a95`.
  - `App` and `SettingsPanel` each called `useProviderConfigs()`
    independently, so saving a key refreshed only `SettingsPanel`'s own
    copy; the composer (fed by `App`'s separate copy) kept showing "No
    providers configured" after a successful save. Fixed by lifting the
    hook to `App` as the single owner, passed down as props — commit
    `28eb009`.
  - Separately noted (not a bug): an org-level/unscoped Anthropic API key
    returns `"not scoped to a workspace"` from the Messages API — that's an
    Anthropic account/key-configuration detail, not something the app can
    or should work around.
- Phase 3: Context / Files.
  - `packages/shared`: `Attachment`/`PendingAttachment` schemas
    (`attachment.ts`, `MAX_ATTACHMENT_BYTES` cap); `WorkspaceFileRoot`/
    `WorkspaceFileIndexEntry`/`WorkspaceFileSearchResult` schemas plus
    `SUPPORTED_TEXT_EXTENSIONS`, `DEFAULT_DENY_PATTERNS`,
    `MAX_INDEXED_FILE_CHARS`, `MAX_INDEXED_FILES` (`workspace-file.ts`);
    `ContextSource`/`ContextInspectorState`/`ContextSelection`/
    `GetContextInspectorInput` schemas plus `estimateTokens()`,
    `CONTEXT_TOTAL_CHAR_CAP`, `CONTEXT_PER_SOURCE_CHAR_CAP` (`context.ts`,
    ADR-012/ADR-013). `Message.attachments` and
    `SendMessageInput.contextSelection` (optional/backward-compatible)
    added to `conversation.ts`. `RendererApi`/`IPC_CHANNELS` extended with
    `chat.getContextInspector`, `attachments.pickFile`, and a
    `workspaceFiles` namespace (`getRoot`/`pickRoot`/`reindex`/`list`/`search`).
  - `packages/storage`: migration `0003_context` adds `attachments`
    (message-scoped, cascading delete), `workspace_file_roots` (one root
    path per workspace), `workspace_files` (indexed metadata + extracted
    text content, replaced wholesale on every (re)index), and the
    `workspace_files_fts` FTS5 virtual table with an `AFTER DELETE` trigger
    keeping it in sync (ADR-010/ADR-011). New `AttachmentRepository` and
    `WorkspaceFileRepository` (`replaceIndex`, `listFiles`,
    `getFileContent`, `search` with `'and'`/`'or'` MATCH modes,
    `buildFtsQuery`). `MessageRepository` now persists/hydrates attachments
    alongside a message in the same transaction.
  - `apps/desktop` main process: `workspace-file-indexer.ts`
    (`walkWorkspaceFiles`) walks a workspace's file root with the `ignore`
    package (MIT) seeded from the built-in deny-list then the workspace's
    own `.gitignore`, never following symlinks (ADR-011);
    `attachment-reader.ts` (`readAttachmentFile`) enforces the same
    supported-extension allowlist and a size cap when reading a picked
    file; `context-service.ts` (`ContextService`, Electron-free, unit
    tested like `ChatService`) computes both the Context Inspector preview
    and the actual injected context block from the same per-source
    truncation logic (ADR-013); new IPC handlers
    (`ipc/workspace-file.ts`, `ipc/attachment.ts`) using `dialog.showOpenDialog`
    for folder/file pickers; `chat-service.ts` extended to persist
    attachments with the user message and inject the resolved context
    block as one extra, non-persisted `role: 'system'` provider message.
  - Renderer: `ContextInspectorView` (pure presentational — sources list
    with per-source toggle checkboxes, token estimates, running total);
    `WorkspaceFilesPanel` (pick/change a workspace's file root, reindex,
    browse indexed files); `ChatPanel` extended with an attach-file button,
    an inline workspace-file search-and-add box, removable
    attachment/context-file chips, and the debounced Context Inspector
    fetch-and-resolve wiring that turns the toggle state into the
    `ContextSelection` sent with the message. `useWorkspaceFiles` is owned
    once by `WorkspaceView` and passed down to both `WorkspaceFilesPanel`
    and `ChatPanel` as props — deliberately following the single-owner
    pattern from the `useProviderConfigs` fix (commit 28eb009) rather than
    each component fetching its own copy.
  - No PDF support (skipped — see Known limitations). No embeddings/vector
    search (not in scope for V1 — see ADR-010).

**Known issues:**

- pnpm's build-script allowlist (`pnpm-workspace.yaml` `allowBuilds`) had to
  explicitly approve `better-sqlite3`, `esbuild`, and `electron` — `electron`'s
  own binary download postinstall did not re-trigger automatically after
  approval and had to be run manually once (`node install.js` inside the
  electron package). Reproduced again in this worktree's fresh install;
  future clean installs should just work once approved.
- `apps/desktop` main bundle is now ~1.9MB (unminified-warning threshold)
  because `ai` + all three `@ai-sdk/*` provider packages are bundled into
  the main process rather than externalized (they're workspace-adjacent
  runtime deps, not optional). Acceptable for V1; revisit with code
  splitting/dynamic import per provider if startup time becomes an issue.
- Model ids offered in the renderer's `ModelSelector` are a small hardcoded
  list per provider (`apps/desktop/src/renderer/src/lib/models.ts`) rather
  than fetched from each provider's models API — fine for V1, revisit if
  providers rename/retire models frequently.
- "Regenerate" always appends a new assistant message after the last user
  turn; it does not delete or edit history. This matches the
  no-branching conversation model but means regenerating repeatedly grows
  the thread rather than replacing the previous attempt.
- The `electron` binary-download issue above recurred identically in the
  Phase 3 worktree (a fresh `pnpm install` left `node_modules/.pnpm/electron@.../
  node_modules/electron/dist` missing until `node install.js` was run
  manually inside that package) — confirms this is a real, reproducible
  pnpm/electron-postinstall interaction on this machine, not a one-off.
- **No PDF support.** No well-maintained MIT/Apache-2.0/BSD-licensed PDF
  text-extraction library was evaluated and adopted in the time available
  for this phase — attaching or indexing a `.pdf` is not supported; `.pdf`
  is in the built-in deny-list so it's never silently mis-read as text
  either. Revisit if a suitable license-clean library is identified.
- **No embeddings/vector search.** Retrieval is lexical (SQLite FTS5) only
  for V1 — see ADR-010. The FTS5 table is not configured with a stemming
  tokenizer, so exact word-form matches only (e.g. "authenticate" does not
  match "authenticated").
- Workspace file indexing is a full re-walk + full index replace on every
  (re)index (no incremental/mtime-based diffing), capped at
  `MAX_INDEXED_FILES` (5000) — see ADR-011. Fine for V1-scale workspaces;
  would need revisiting for a very large repository as a file root.
- The Context Inspector's auto-surfaced retrieval snippets re-run an FTS5
  search against the *current draft text* on a 300ms debounce as the user
  types — fine at V1 scale, but not throttled/cancelled against a slow
  provider; a very fast typist could have a couple of stale-but-harmless
  inspector fetches in flight (each just overwrites the previous one).
- Attachment/workspace-file pickers (`attachments.pickFile`,
  `workspaceFiles.pickRoot`) and the Context Inspector's toggle UI were
  **NOT interactively verified** — no GUI automation was available in this
  session. The underlying logic is covered by real unit tests
  (`ContextService`, `walkWorkspaceFiles`, `readAttachmentFile`,
  `WorkspaceFileRepository`, `ChatService` context-selection wiring) and
  the app was confirmed to build and launch without a main-process crash,
  but clicking through the actual file-picker dialogs and Context Inspector
  panel has not been done. Per Phase 2's precedent, expect the user to
  manually test this and report any real UI bugs.
- A duplicate `@types/node` version issue (pre-existing, unrelated to
  Phase 3 feature code — see ADR-014) was found and fixed via a
  `pnpm-workspace.yaml` `overrides` pin while getting `pnpm -r typecheck`
  clean for this phase.

**Next exact task:** Phase 4 (per the phased roadmap — check the product
brief/backlog for exact Phase 4 scope before starting; do not begin Phase 5
agents/tool-permission-engine, Phase 6 multi-model orchestration modes, or
Phase 7 MCP work out of order).
