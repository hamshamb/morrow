# Build State

**Current phase:** Phase 2 — AI Chat (complete) → Phase 3 next

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

- `packages/shared`: 22 unit tests (zod schema boundaries — workspace,
  settings, provider config, conversation/message, chat stream events).
- `packages/storage`: 23 unit tests (`WorkspaceRepository`,
  `SettingsRepository`, `ConversationRepository` incl. cascade delete,
  `MessageRepository` incl. multi-provider thread ordering/attribution,
  `ProviderConfigRepository` incl. that summaries never expose the
  encrypted key), against an in-memory SQLite db.
- `packages/providers`: 8 unit tests (`createMockProvider` streaming/error/
  abort behavior, `createProvider` factory dispatch per provider id). No
  network calls.
- `apps/desktop`: 5 integration tests (`ChatService` against an in-memory
  SQLite db + `createMockProvider` — no network): persists user + assistant
  messages with correct provider/model attribution; **proves a single
  conversation can move Claude -> OpenAI -> Gemini per message without
  branching**; persists a partial message with `status: 'error'` when the
  provider stream fails; throws on an unknown conversation id; `cancel()`
  aborts an in-flight request and the result is persisted `status:
  'cancelled'`.
- All of the above pass: `pnpm -r typecheck`, `eslint .`, `pnpm -r test`
  clean (58 tests total).
- Manual: `pnpm --filter @ai-workspace/desktop build` succeeds;
  `pnpm --filter @ai-workspace/desktop start` launches the packaged app
  with no main-process errors (only the same benign Chromium
  GPU-disk-cache warnings seen in Phase 1 under a restricted profile dir).
- **NOT VERIFIED**: live streaming against a real Anthropic/OpenAI/Google
  API — no API keys are available in this environment. The provider layer
  was deliberately structured so the orchestration (persistence, streaming
  event shape, cancellation, attribution) is proven end-to-end with a mock
  provider instead; the only untested surface is the actual HTTP call made
  by `@ai-sdk/anthropic` / `@ai-sdk/openai` / `@ai-sdk/google`, which are
  unmodified upstream packages doing exactly what their own test suites
  already cover.
- **NOT VERIFIED**: interactive UI walkthrough of the new chat/settings
  screens (typing a message, watching it stream, adding a provider key
  through the Settings panel, clicking Cancel/Regenerate) — no GUI
  automation tool available for a native Electron window in this
  environment. Covered instead by the `ChatService` integration tests
  above plus a clean typecheck/lint of every renderer component. The app
  was left running after the build for manual confirmation, same as Phase 1.

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

**Next exact task:** Phase 3 (per the phased roadmap — check the product
brief/backlog for exact Phase 3 scope before starting; do not begin Phase 4
coding-workspace, Phase 5 agents, Phase 6 multi-model orchestration modes,
or Phase 7 MCP work out of order).
