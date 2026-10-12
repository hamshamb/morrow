# Build State

**Current phase:** roadmap **Phase 5 — AI coding tools, permission engine and the
agent loop** (complete, on branch — pending merge): the AI can inspect, edit and run
commands in the workspace under a main-process permission engine, with an audit trail, a
report built from facts and per-file revert — see "Phase 5" below and docs/DECISIONS.md
ADR-040…045. Before it: roadmap **Phase 4 — code workspace** (merged): open the workspace
folder as a repository, edit code in Monaco,
run real terminals, inspect diffs, stage and commit — see "Phase 4 — code
workspace" below and docs/DECISIONS.md ADR-033…038. Before it: roadmap
**Phase 6 — multi-model orchestration** (merged): compare, review, round table and auto behind one
orchestration layer, reached through a small composer mode chip and the command
palette — see "Phase 6" below and docs/DECISIONS.md ADR-027…032. Before it:
models.dev + provider registry (merged): every provider models.dev lists that
has a bundled SDK or a plain OpenAI-compatible URL, plus Ollama and a custom
endpoint, with per-model metadata and exact reasoning-effort values — see
"models.dev integration" below and ADR-021…026. Before it: the UI redesign
(merged — OpenCode-structured, nochan-styled renderer, multi-model UX, first-run
onboarding, keyboard model; ADR-018/019/020), and Phase 4 — model catalog,
reasoning effort, persisted selection (a user-requested feature layered on
Phase 2's chat, not the roadmap's "Phase 4" repo/editor/terminal workspace).

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

- `packages/shared`: 60 unit tests (zod schema boundaries — workspace,
  settings incl. `lastModelSelection` round trip, provider config,
  conversation/message incl. `SendMessageInput.effort`, chat stream events,
  attachment/pending-attachment, workspace-file root/search input,
  `estimateTokens`, context source/selection/inspector-input schemas,
  model-catalog schemas, `ANTHROPIC_FALLBACK_MODELS` content,
  `ANTHROPIC_THINKING_BUDGET_TOKENS` minimum/ordering, and
  `isReasoningCapableModel` per provider).
- `packages/storage`: 55 unit tests (`WorkspaceRepository`,
  `SettingsRepository` incl. persisting/merging `lastModelSelection`,
  `ConversationRepository` incl. cascade delete,
  `MessageRepository` incl. multi-provider thread ordering/attribution and
  attachment persistence/hydration, `ProviderConfigRepository` incl. that
  summaries never expose the encrypted key, `AttachmentRepository` incl.
  cascade delete with its message, `WorkspaceFileRepository` incl.
  root set/update/cascade-delete, `replaceIndex`/`listFiles`/
  `getFileContent`, and FTS5 `search()` in both `'and'` and `'or'` modes,
  `ModelCatalogRepository` incl. wholesale replace, per-provider-config
  scoping, and cascade delete when the owning provider config is removed),
  against an in-memory SQLite db. Also manually verified once (not part of
  the committed suite — depends on the user's real, absolute-path db file)
  against a copy of the real `workspace.sqlite3`: migration 0004 preserved
  every existing `provider_configs`/`conversations`/`messages` row exactly
  and added an empty `model_catalog` table.
- `packages/providers`: 16 unit tests (`createMockProvider` streaming/error/
  abort behavior, `createProvider` factory dispatch per provider id,
  `buildAnthropicProviderOptions`/`buildOpenAiProviderOptions` — the
  effort-to-provider-param mapping, incl. the Haiku/non-reasoning-model
  exclusion and the low<medium<high budget-tier ordering). No network
  calls.
- `apps/desktop`: 60 integration/unit tests:
  - `fetchAnthropicModels`/`fetchOpenAiModels`/`fetchProviderModels`
    (mocked `fetch`, no real network access): correct auth headers
    (`x-api-key`+`anthropic-version` / `Authorization: Bearer`), correct
    endpoint URL incl. a custom base URL, response-to-`ModelCatalogEntry`
    mapping (incl. OpenAI's always-null display name), HTTP-error and
    network-error paths returning `ok: false` with a message rather than
    throwing, and the Google-not-implemented dispatch throwing.
  - `lib/model-picker.ts` (renderer, pure logic): live catalog preferred
    over the static fallback when non-empty, static fallback used when
    nothing is cached yet or the catalog is empty, no options at all for a
    configured OpenAI provider with nothing cached (no OpenAI fallback,
    confirming ADR-015), flattening across multiple provider configs, and
    the search/filter/ranking behavior.
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
  clean (191 tests total).
- Manual: `pnpm --filter @ai-workspace/desktop build` succeeds;
  `pnpm --filter @ai-workspace/desktop start` launches the packaged app
  with no main-process errors (only the same benign Chromium
  GPU-disk-cache warnings seen in Phase 1 under a restricted profile dir).
  Re-verified after Phase 4: same build/launch result, no new errors from
  the model-catalog IPC wiring, `migration 0004` applying, or the rewritten
  `ModelSelector`; the electron binary-download issue (below) recurred
  identically in this worktree too and was fixed the same way.
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
- Phase 4: Model catalog, reasoning effort, persisted selection. User-
  requested directly (not from the phased roadmap) — see ADR-015/016/017.
  - `packages/shared`: new `model-catalog.ts` —
    `ReasoningEffortSchema`/`REASONING_EFFORT_VALUES`,
    `ModelCatalogEntrySchema`/`ProviderModelCatalogSchema`/
    `RefreshModelCatalogResultSchema`, `ANTHROPIC_FALLBACK_MODELS` (the four
    confirmed-current ids only), `isReasoningCapableModel` (per-model-id
    heuristic, no hardcoded allowlist), `ANTHROPIC_THINKING_BUDGET_TOKENS`.
    `AppSettings.lastModelSelection` (ADR-017). `SendMessageInput.effort`
    (optional/nullable, backward-compatible). `RendererApi`/`IPC_CHANNELS`
    extended with a `modelCatalog` namespace (`list`/`refresh`).
  - `packages/storage`: migration `0004_model_catalog` adds `model_catalog`
    (provider-config-scoped, cascading delete — additive only, verified
    against a copy of the real `workspace.sqlite3` that every existing
    `provider_configs`/`conversations`/`messages` row survives untouched).
    New `ModelCatalogRepository` (`listForProviderConfig`,
    `replaceForProviderConfig` — full wholesale replace per refresh, same
    pattern as `workspace_files`).
  - `packages/providers`: `ProviderChatRequest.effort` (optional). New
    `adapters/reasoning-options.ts` (`buildAnthropicProviderOptions`,
    `buildOpenAiProviderOptions` — pure, unit-tested, see ADR-016) wired
    into the Anthropic/OpenAI adapters' `providerOptions`; `shared-stream.ts`
    now forwards an optional `providerOptions` to `streamText`. Google
    adapter unchanged (no effort wiring — see ADR-016).
  - `apps/desktop` main process: `model-catalog-fetcher.ts`
    (`fetchAnthropicModels`, `fetchOpenAiModels`, `fetchProviderModels` —
    Electron-free, injectable `fetch` for tests, no network calls in the
    test suite) calls each provider's real models-list endpoint;
    `ipc/model-catalog.ts` (`refreshModelCatalog` + `registerModelCatalogIpc`)
    fetches-and-caches on demand and exposes the cached list; wired into
    `ipc/provider-config.ts` so adding a provider config also fires a
    best-effort background catalog refresh (never blocks or fails the add
    call). `chat-service.ts` forwards `input.effort` to the provider.
  - Renderer: `ModelSelector.tsx` rewritten from a plain `<select>` pair
    into a compact trigger button that opens a searchable, keyboard-
    navigable popover (`lib/model-picker.ts`'s pure, unit-tested
    `buildModelPickerOptions`/`filterModelPickerOptions` — simple scored
    substring filter, no fuzzy-match library); shows a low/medium/high
    effort control when the selected model is reasoning-capable; always
    offers a free-text custom model id entry regardless of catalog state;
    a "Refresh models" action per provider config. New `useModelCatalogs`
    hook, owned once by `ChatPanel` and passed down to the popover
    (single-owner pattern, matching the `useProviderConfigs` fix from
    commit 28eb009 — re-checked the whole renderer for the same bug class
    and found no other duplicate-hook-fetch case). `ChatPanel` now defaults
    the composer's initial provider/model/effort to
    `AppSettings.lastModelSelection` (when that provider config still
    exists) instead of always `providerConfigs[0]` + its first model, and
    persists every change back to it via a prop threaded down from `App`
    (the single owner of `useSettings`) through `WorkspaceView`.

- UI redesign (user-requested; ADR-018/019/020). References:
  docs/UI_REFERENCE_OPENCODE.md (structure/interaction, MIT) and
  docs/UI_REFERENCE_NOCHAN.md (visual language — the user's own site).
  - **Shell**: 48px workspace rail (square monogram tiles, active
    inverted) + collapsible/resizable session list (`useResizablePanel`,
    drag math adapted from OpenCode) + top bar with slash nav
    (`/chat` working; `/code /terminal /git` disabled "coming soon" — no
    fake tabs) and one primary action `+ new session [c]`. Settings and the
    keyboard sheet are reached from the session-panel footer and the palette;
    the old header theme toggle and always-visible files button are gone.
  - **Conversation**: assistant turns unboxed in serif prose with a model
    chip per turn (`SONNET 5 · ANTHROPIC`); user turns are the only block
    (mono, raised, hairline, square); code blocks with a language header,
    `[copy]`, and a ruled line-number gutter; GFM tables; bracketed actions
    `[copy] [regenerate] [regenerate with…]`; plain-language inline errors
    with `[retry] [switch model]`; blinking block cursor while streaming;
    the thread follows new turns while you're at the bottom.
  - **Composer**: square, `--rule-strong` border; footer = `+` add-menu
    (attach a file / add a workspace file), model chip (model · provider ·
    effort), `[context N]` toggle, `send ↵` / `stop ■`.
  - **Model picker** (shared by the composer chip and "[regenerate with…]"):
    favorites (★, persisted), recent (last 3, persisted), then per-provider
    groups; same scored-substring search as before; effort control and
    custom model id in composer mode.
  - **Command palette** (Ctrl/Cmd+K and Ctrl/Cmd+Shift+P): new session,
    switch model, context panel, workspace files, settings, keyboard
    shortcuts, favorite models, other workspaces, add an indexed file to
    context. Real actions only.
  - **Context Inspector** is a closed-by-default resizable right panel;
    same gating logic as Phase 3, unchanged.
  - **First-run onboarding** when no provider key exists: paste a key →
    provider detected from its prefix → connection auto-tested → saved →
    catalog fetched → a workspace (if none) and a new session are created
    with the first model selected.
  - **Settings**: connected keys (each with `[remove]` + inline confirm) +
    one paste-a-key field (auto-detect, auto-test, `save key`); Appearance
    (theme). No Agents/MCP/Permissions sections (backends don't exist).
  - **Keyboard**: `c` / Ctrl+N new session, Ctrl+K / Ctrl+Shift+P palette,
    Ctrl+M model picker, Esc closes the open popover/panel and returns to
    the composer, Enter/Shift+Enter; focus returns to the composer after
    every action; `[keyboard]` sheet.
  - **Other UX**: sessions auto-titled from the first message (no model
    call); inline 3-second confirm for destructive actions; deliberate empty
    states with one next action everywhere.
  - **Backend additions (all additive)**: conversation rename end-to-end
    (schema, repository, IPC, preload — used by the session menu and
    auto-titles); `AppSettings.favoriteModels`/`recentModels` (defaulted,
    no migration — key/value table). No new migrations; the real
    `workspace.sqlite3` is untouched by this phase.
  - **New dependency**: `@fontsource/ibm-plex-mono` (OFL-1.1, font — see
    docs/OPEN_SOURCE_INVENTORY.md).
  - **Dev-only browser preview harness**: `dev/mock-api.ts` implements the
    full `RendererApi` with fixture data when `window.api` is undefined,
    dynamically imported behind `import.meta.env.DEV` — verified absent
    from the production bundle (single renderer chunk, none of the mock's
    symbols or fixture strings). `?theme=light|dark|system`,
    `?fixture=empty` (no providers → onboarding), `?fixture=error` (every
    send fails with a raw 401 body).
  - **Tests**: +5 conversation-rename (schema + repository), +6 search-match,
    +7 favorites/recents helpers and settings round-trip, +2 settings
    persistence/legacy-row, +20 UX helpers (key-prefix detection,
    auto-title, plain-language errors, model labels, relative time).
  - **Screenshot QA (done, iterated)**: an Electron capture script loads the
    dev server (mock API) off-screen at 1920x1080 / 1440x900 / 1280x720 dark
    and 1920x1080 light, drives each state through the DOM, and writes PNGs
    that were reviewed one by one; every round's findings were fixed and
    re-captured (see the redesign commits' messages for the list).

- models.dev integration (user-requested: "every AI model and provider");
  ADR-021…026. Part A (backend) then Part B (renderer).
  - **`packages/shared`**: `ProviderId` is a validated string (ADR-024);
    `ReasoningEffort` = `none|minimal|low|medium|high|xhigh|max`;
    `ModelMetadata` (context, price, vision/tools/reasoning, exact efforts,
    knowledge cutoff…), `ProviderRegistryEntry`, `LocalProviderStatus`,
    `ModelsMetadataStatus`; `ModelCatalogEntry.meta`/`ProviderModelCatalog.source`
    (optional); `AppSettings.modelsDevFetchEnabled` (additive, default `true`);
    `detectProviderByKeyPrefix`; IPC: `providers.registry/detectLocal`,
    `modelsMetadata.status/refresh/onChange`. Removed: `PROVIDER_LABELS`,
    `ANTHROPIC_FALLBACK_MODELS`, `isReasoningCapableModel`.
  - **`packages/providers`**: `models-dev.ts` (lenient parse → trim → normalize),
    `registry.ts` (bundled → openai-compatible → excluded; Ollama/custom; popular
    ordering; key prefixes), `catalog.ts` (live ⋈ models.dev join, probe-model
    pick), `reasoning-options.ts` (per-SDK mapping ∩ model values),
    `adapters/sdk-provider.ts` (one adapter for all 12 bundled SDKs),
    `bundled-snapshot.ts` + `data/models-dev-snapshot.json` (**424 KB**, 202
    providers / 916 models) regenerated by `pnpm models:snapshot`. New deps:
    xai, mistral, groq, deepseek, cerebras, togetherai, perplexity, openrouter,
    openai-compatible (all Apache-2.0).
  - **`apps/desktop` main**: `ModelsDevService` (snapshot → `userData/
    models-dev-cache.json` → ≤ 24 h network refresh, opt-out, bare GET),
    `ProviderCatalogService` (registry, join, per-family live list fetch incl.
    Google/OpenAI-compatible/Ollama, models.dev-probe connection test, local
    detection, chat provider + metadata lookup), `model-catalog-fetcher.ts`
    rewritten, IPC wiring + a push event when a download lands. `ChatService`
    passes the model's metadata so the effort is validated before it is sent.
  - **Renderer**: `ProviderList` + `AddProvider` (onboarding and Settings:
    searchable, popular first, Ollama `local · detected` / `not running`,
    custom endpoint, `connected` markers); `KeyEntry` for keyed, keyless and
    custom providers; model-picker rows with one muted metadata line
    (`1M ctx · $2/$10 · vision tools reasoning`) and an effort control showing
    exactly the model's values (hidden when none; `none` shown as `off`);
    context panel budget `~18K / 1M` (signal colour ≥ 80 %); Settings → Models
    (source/status, download on/off, `[refresh now]`); `Markdown.tsx` on
    Streamdown; `use-stick-to-bottom` scroll with `[↓ latest]`. Dev mock gained
    metadata fixtures for 6 providers (incl. xhigh/max, an Ollama local
    provider) and `?ollama=down`, `?ctx=<tokens>` flags;
    `pnpm --filter @ai-workspace/desktop dev:renderer` serves it at
    `http://127.0.0.1:5199` for browser QA.
  - **Tests**: 371 pass (shared 70, storage 62, providers 89, desktop 150; was
    231). New, all network-free: registry resolution (bundled/openai-compatible/
    excluded/overrides/ordering), snapshot trimming and size, models.dev parser
    leniency, effort normalization (incl. `xhigh`/`max`/sentinels), catalog join,
    probe-model choice, per-SDK effort mapping and validation, wire-format tests
    with a stubbed `fetch` (the request body really carries
    `reasoning_effort: max`; Ollama sends no `Authorization`), cache freshness
    (fresh/stale/24 h), opt-out (zero `fetch` calls), bare-GET assertion, failed/
    garbage download keeps the old catalog, Ollama detection (up/down/timeout),
    every list-endpoint shape, ProviderId validation, settings partial update,
    migrations re-run over populated rows. Tests for removed behaviour
    (`isReasoningCapableModel`, the three-value enum, `ANTHROPIC_FALLBACK_MODELS`,
    renderer `STATIC_FALLBACK_MODELS`, the old `/v1/models` URL shape, bare `sk-`
    → OpenAI) were replaced by their successors rather than kept.
  - **Verified**: `pnpm -r typecheck`, `pnpm exec eslint .`, `pnpm -r test` green;
    `pnpm --filter @ai-workspace/desktop build` succeeds; the dev mock is absent
    from `out/renderer/assets/*.js` (no "Personal Website" / `installMockApi`);
    the built app launched with a throw-away `--user-data-dir`: no main-process
    errors, migrations applied, and a **real download of models.dev** was written
    to `models-dev-cache.json` (2.8 MB reduced; 202 runnable providers, 6,420 chat
    models) — `claude-sonnet-5` efforts `low…max`, `gpt-5.6` `none…max`, DeepSeek
    routed to `@ai-sdk/deepseek`; a **copy** of the real `workspace.sqlite3`
    (WAL included) opens with migrations `[1,2,3,4]` unchanged and every row valid.
  - **Bundle sizes**: main `out/main/index.js` 1.93 MB → **3.17 MB** (+1.24 MB: 9
    new SDK packages + the 424 KB snapshot); renderer JS 1.26 MB → **1.98 MB**
    (+0.72 MB, Streamdown's unified/rehype/marked stack, net of react-markdown).
  - **Screenshot QA (done)**: an Electron capture script drove the dev server
    (mock API) at 1920x1080 dark, 1280x720 dark and 1920x1080 light; 39 PNGs in
    `.claude/paused/models-screenshots/` (picker with metadata and effort rows for
    Sonnet 5 / GPT-5.6, Haiku with no effort row, onboarding with Ollama `not
    running` and `detected`, search, Settings providers/add/models, context panel
    ok and warn). Findings fixed: the provider list showed "no provider matches"
    while the registry was still loading (now `loading providers…`); the visible
    list hid Ollama (taller list, selected row scrolled into view); per-source
    token counts used raw numbers (`~12000`) instead of `~12K`; the Settings dialog
    was too short for the list (taller).

- Phase 6 — multi-model orchestration (ADR-027…032). One layer over the existing
  chat pipeline; NORMAL stays the unchanged default.
  - **Data (migration 0005, additive)**: `messages` gained `reply_group_id`,
    `orchestration_mode`, `role_label`, `in_context` (default 1), `auto_reason`,
    `reply_index`, `round_index`, `input_tokens`, `output_tokens`, `latency_ms`,
    `est_cost_usd`, `error_text` — all nullable or defaulted. Phase 2 stored no
    usage, so the usage/cost columns are new. `AppSettings.autoPreference`
    (`cheapest|balanced|best`, default `balanced`) is a key/value setting (no migration).
  - **`packages/shared/orchestration.ts`**: limits (`COMPARE` 2–4, round table ≤ 3
    rounds / 2–4 participants / ≤ 13 calls), zod IPC inputs and stream events,
    `estimateCostUsd`/`formatEstimatedCost`, and the pure `pickAutoModel`.
    `Message` gained the defaulted orchestration fields; `ChatStreamEvent` an
    additive `start` event.
  - **`packages/providers`**: the `done` event carries `usage` (from the AI SDK's
    `finish` part; omitted when the provider reported none). The mock provider can
    report usage and pause per chunk (for concurrency/cancel tests).
  - **Main**: `ChatService` split into `persistUserTurn` / `buildProviderMessages`
    (honors `in_context`) / `runTurn` (persists usage, latency, est. cost, error
    text); `[regenerate]` is now a true sibling reply (`regenerateOfMessageId`, no
    duplicated user message). `OrchestrationService` (Electron-free): `compare`
    (parallel, per-column requestId/cancel, failure isolation, "cancel all"),
    `review` + `applySuggestions` (the primary answer is never edited), `roundTable`
    (fixed capped plan, sequential, one cancel), `auto`, `retryReply`,
    `setInContext`. `orchestration-prompts.ts` holds the exact prompts;
    `auto-candidates.ts` builds Auto's pool from saved provider configs.
    `ContextService`'s history count ignores out-of-context replies.
  - **IPC (additive)**: `chat.compare/review/applySuggestions/roundTable/auto/
    retryReply/setInContext/cancelOrchestration/onOrchestrationEvent`.
  - **Renderer**: composer mode chip (`chat ▾` → chat / compare / review / round
    table / auto; Ctrl+Shift+M opens it, arrows/Enter/Esc) that reveals only that
    mode's controls (model slots, reviewer, ordered round-table turns with roles,
    synthesizer and a 1–3 rounds stepper, Auto's cheapest/balanced/best);
    palette entries "Compare models…", "Review with…", "Round table…", "Auto-pick
    model"; `CompareView` (equal columns, independent scroll, status/latency/usage/
    est. cost per column, inverted `IN CONTEXT` chip, dimmed siblings,
    `[continue with this]`, inline `[retry]`/`[switch model]`, `[stop]` per column and
    `[stop all]`; stacks below N × 260 px so it never hides a column behind a
    scrollbar); `ReviewGroup` (answer, then a ruled-off `REVIEW · model` block,
    `[apply suggestions]` → a `REVISED` sibling block); `RoundTableView` (header with
    participants and `round n/N`, labelled `PROPOSAL/CRITIQUE/ALTERNATIVE/SYNTHESIS`
    turns, `[stop]`); Auto's muted `Auto → model · reason: …` line; stats
    (`2.4s · 1.8K in · 340 out · est. $0.0042`, `—` when unpriced) on every compare/
    round-table/review block and on hover for plain replies. `useChat` now
    shows the user's turn immediately (optimistic) and owns all live run state.
  - **Dev mock**: fixtures for every mode (`dev/mock-orchestration.ts`: a 3-column
    compare with one failed and one chosen column, a review, a 4-turn round table, an
    Auto pick with attachment) plus working mock behavior (`?failmodel=<id>` makes one
    compare column fail).
  - **Tests**: 514 pass (shared 122, storage 72, providers 90, desktop 230; was 373).
    New and all network-free: migration over populated rows + `in_context` default +
    every column nullable/defaulted; `chooseReply`; history replay excludes
    non-context siblings (compare, regenerate, legacy rows, failed empty replies);
    compare parallelism (a column cannot start until another has — a sequential
    implementation would hang), per-column channels, one-column failure isolation,
    unresolvable provider, cancel-all and single-column cancel, 2–4 limit; review
    never mutates the primary (byte-for-byte equal before/during/after), apply
    creates a new sibling, retry-review reuses the primary; round-table order,
    transcript hand-off, rounds, **cap enforced server-side** (4/0/1.5 rounds,
    5 participants, non-proposal start all rejected before any call; max plan =
    exactly 13 calls; model output cannot add a turn), cancel mid-table, failed-turn
    stop; auto rules (vision, pdf, context overflow incl. boundary, complexity,
    cheapest/balanced/best, no-key, deprecated, unrated, unpriced, determinism under
    reordering, tie-breaks); cost estimation incl. unknown pricing/usage; usage
    flows through the real SDK pipeline (stubbed `fetch`); renderer thread grouping,
    formatting and mode validation.
  - **Verified**: `pnpm -r typecheck`, `pnpm exec eslint .`, `pnpm -r test` green;
    `pnpm --filter @ai-workspace/desktop build` OK and the dev mock is absent from
    `out/renderer/assets/*.js` (no "Personal Website", `installMockApi`, mock
    fixtures); the built app launched with a throwaway `--user-data-dir`: empty
    stderr, migrations `[1,2,3,4,5]` applied, models.dev cache written; migration
    0005 over a **copy** of the real `workspace.sqlite3` (+ WAL/SHM): migrations
    `[1,2,3,4]` → `[1,2,3,4,5]`; rows before → after: workspaces 2→2, conversations
    2→2, messages 6→6, message_parts 6→6, provider_configs 2→2, model_catalog
    14→14, settings 6→6, attachments 0→0; `messages` columns 8→20; all 6 messages
    validate against the zod schema as plain in-context `normal` replies; the live
    file was never opened. Bundle: main 3.17 → 3.22 MB, renderer 1.98 → 2.05 MB.
  - **Screenshot QA (done, iterated)**: an Electron capture script drove the dev
    server at 1920x1080 dark, 1280x720 dark and 1920x1080 light — 84 PNGs in
    `.claude/paused/phase6-screenshots/` (compare 3-col incl. errored + chosen, review,
    round table, auto, the mode menu (click and Ctrl+Shift+M), the palette with the
    new commands, each mode's composer controls, live streaming of every mode,
    continue-with-this / retry / apply-suggestions interactions, compare beside the
    context panel at 1280). Findings fixed: duplicate React keys (a group reused its
    user message's id), the round-table header named only the participants that had
    started (now planned up front), turn stats ran into the round label, compare
    columns hid behind a horizontal scroll at 1280 with the context panel open
    (now stack), mode-menu blurbs wrapped, and failures with no reply to carry them
    (limit errors, missing key) were invisible (now an inline error line).

- **Phase 4 — code workspace** (roadmap Phase 4; the disabled `/code /terminal /git`
  nav entries are live). ADR-033…038. Branch `worktree-agent-ab3e1f50fb4e5f9af`.
  - **Shared**: `code.ts` — limits + zod schemas for the `fs` / `git` / `terminal`
    surfaces (`RendererApi` extended, additive), `codeSessions` setting (additive,
    defaulted: restored tabs per workspace), the deny-list split into
    `SENSITIVE_DENY_PATTERNS` + `NOISE_EXCLUDE_PATTERNS` (`DEFAULT_DENY_PATTERNS`
    unchanged as their concatenation, so the indexer is untouched).
  - **Main** (`main/code/`): `path-safety.ts` (relative-only, realpath containment,
    deny-list on requested + resolved path), `file-service.ts` (lazy `listDir`,
    `readFile` with binary/size/UTF-8 states, atomic hash-guarded `writeFile` with
    BOM kept, `listPaths`, bounded `searchText`), `git-service.ts` + `git-parse.ts`
    (system git via `execFile` arg arrays; status/numstat/log parsing; both diff
    sides; stage/unstage/commit only), `terminal-manager.ts` + `shell-detect.ts` +
    `pty-native.ts` (`@lydell/node-pty`, lazily loaded), `ipc/code.ts` (zod on every
    input), PTYs killed on `before-quit`/`will-quit`, native confirm on window close
    with unsaved files (`will-prevent-unload`).
  - **Renderer**: `/code` (lazy FileTree with git markers, EditorTabs with inverted
    active chip + dirty dot + middle-click close, Monaco host, inline unsaved /
    conflict / save-error strips, status bar with `[+ file to chat]` /
    `[+ selection to chat]` / `[save]`, Ctrl+P quick open, Ctrl+Shift+F text search,
    restored tabs); `/git` (branch + HEAD, Staged / Unstaged / Untracked groups with
    `+N -M`, per-file and bulk stage/unstage, commit box with Ctrl+Enter, Monaco diff
    editor side-by-side / inline, whole-file view for new/deleted files, "Git not
    found" / "not a repository" / "no folder" states); bottom panel (`TERMINAL |
    OUTPUT`, multiple xterm.js terminals, exit status + `[restart]`, resize via
    addon-fit, Ctrl+`, `/terminal` toggles it); command-palette group `code`
    (Open file…, Search in files…, Show code, Toggle terminal, New terminal, Show
    changes, Commit…); keyboard sheet updated; resizable explorer / changes list /
    bottom panel. Monaco and xterm themes come from the nochan tokens (dark + light).
  - **Tests**: 629 unit tests pass (shared 129, storage 73, providers 90, desktop 337;
    was 514) **plus 18 Playwright tests against the real built Electron app**. New
    unit tests: path safety (absolute / `..` / NUL / `:` / trailing dot, symlink and
    junction escape — a real *file* symlink case is skipped with an explicit reason
    when the OS refuses to create one — deny-list, 8.3 short names, link into `.git`),
    file service (binary / invalid UTF-8 / size tiers, atomic write leaves no temp
    file, stale-write conflict `changed`/`deleted`/`exists`, overwrite only when told,
    BOM, CRLF, tree + quick-open filters, search), git parsing against fixtures,
    git argument construction (no shell, `--` before paths, hostile names stay one
    argv element, subcommand allow-list incl. "never push/reset/clean/…", secrets
    skipped by stage-all), **an integration test against a real temp repository**
    (init → commit → modify → stage → diff → commit, renames, deletions, binary,
    untracked, awkward names, subdirectory root, unborn branch), shell detection, the
    PTY manager with a fake PTY (spawn / resize / coalesced output / exit / kill /
    killAll / limits) **and a real PTY smoke test** (spawn the detected shell, `echo`,
    assert output, kill, assert the pid is gone — it runs under vitest's Node 26 because the prebuilt
    binary also loads there; the Electron 44 side is proven by the E2E below), renderer libs (tabs, tree, quick
    open ranking, git UI helpers, theme derivation).
    E2E (`apps/desktop/e2e`, `pnpm --filter @ai-workspace/desktop test:e2e`):
    open repository (native dialog stubbed) → edit → Ctrl+S (file on disk checked) →
    stale-write conflict → dirty-tab inline confirm → quick open / search → middle-click
    close → terminal starts only on request, runs a command, output asserted, cwd =
    repo root, shell pid alive → second terminal, `exit 3` shows its exit status,
    `[restart]` → Output tab → changes view + real diff editor → stage → commit (author
    = the temp repo's identity, `git show HEAD:` content checked, only the staged file
    committed, no push/reset/clean/force control exists) → Monaco's worker started under
    the **unchanged** CSP, no console errors, **empty main-process stderr** → quit and
    every shell pid is gone → relaunch restores tabs and starts no terminal. Plus:
    IPC boundary through the real preload (absolute / traversal / `.env` / `.git` /
    write-outside / bad input all refused), no-folder / not-a-repo / **git missing from
    PATH** states, and the native unsaved-changes confirm ("keep editing" keeps the
    window, "discard" closes it). Two real bugs were found by the E2E and fixed:
    restart-terminal dropped the new tab (stale ref), and typing right after
    Ctrl+Shift+F could land in the open file (the overlay's focus is now synchronous).
  - **Verified**: `pnpm install`, `pnpm -r typecheck`, `pnpm exec eslint .`,
    `pnpm -r test` green; `electron-vite build` OK. Bundle (renderer is now minified —
    electron-vite defaults it off): main chunk **1.98 → 1.00 MB** (what chat startup
    loads), lazy chunks Monaco **3.15 MB** (+118 KB CSS, 153 KB codicon font) and its
    **275 KB** worker, xterm **332 KB**, ~84 per-language tokenizer chunks of 1–42 KB;
    main process 3.22 → 3.27 MB, preload 222 KB. The dev mock is absent from
    `out/renderer/assets/*.js` (grep for `Personal Website`, `personal-website`,
    `installMockApi`, `refreshMiddleware`, `createMockCodeApi`: 0 hits). Monaco is its own
    chunk (`monaco-setup-*.js`, reached only through a dynamic `import()`).
    The PTY loads in the built Electron app: `@lydell/node-pty` 1.2.0-beta.15 resolves its
    prebuilt `conpty.node` from `node_modules` (externalized by electron-vite) — proven by
    the E2E running PowerShell 7 through it; no `@electron/rebuild` entry and no
    `allowBuilds` change were needed.
  - **Screenshot QA (done, iterated)**: from the **real Electron app** against a
    throwaway repo with staged / unstaged / untracked changes, at 1920x1080 dark,
    1280x720 dark and 1920x1080 light — 48 PNGs in
    `.claude/paused/phase4-screenshots/` (`qa-screenshots.e2e.ts`; the dev-mock
    version `e2e/qa/qa-mock.mjs` was used for the first passes). Findings fixed: tab
    labels sat at the top of their row; the explorer header overflowed (dropped its
    label); branch names were upper-cased by the chip style (`chip--raw`); the diff
    sides label sat at the bottom (now in the header, `HEAD → staged`,
    `index → working tree`); a new/untracked file diffed against "one empty line" drew a
    phantom removed row (now a whole-file view); the diff editor overflowed the page by
    1 px, which produced a horizontal scrollbar and a strip at the bottom; diff
    backgrounds were muddy in light (alpha lowered); search results had no match
    highlight; Ctrl+K inside Monaco starts a chord (now opens the palette); xterm's black
    viewport showed as a strip under the last row in the light theme.

- **Phase 5 — AI coding tools, permission engine, agent loop** (roadmap Phase 5; the composer's
  `plan` / `build` modes). ADR-040…045. Branch `worktree-agent-aa5c9f5e55233a7f8`.
  - **Providers** (`packages/providers`): `streamWithModel` — still the only `streamText` call — takes
    `toolOptions { tools: AgentToolSpec[], maxSteps }` and emits `step-start | tool-call | tool-result | tool-error |
    step-finish` (plain chat sends no tools and sees only the old events). Tools go through `tool()` + `jsonSchema(…,
    { validate })`, the loop is `stopWhen: isStepCount(n)`, results return as `text` / `error-text`, the system prompt rides
    `instructions`; the last step's instructions say "wrap up" (no `toolChoice: 'none'` — Anthropic drops `tools` and rejects
    `tool_use` history). Wire names use `_` (`filesystem_read`): neither API accepts a dot.
  - **Shared**: `agent.ts` — tool ids, risk classes, limits (steps 25/100, wall 20 min/2 h, command 120 s/900 s), decisions
    and decision sources, permission request / preview, audit row, report, run, events, `BUILTIN_AGENTS`, the pure
    `effectiveTools(agent, mode)`; `AppSettings.agentLimits` / `agentOverrides` (additive, defaulted); `plan` and `build` added
    to `COMPOSER_MODES`.
  - **Storage**: migration **0006** (additive, four new tables): `agent_runs`, `tool_runs` (the audit trail),
    `permission_grants`, `agent_file_snapshots`; `AgentRepository`. A run left `running` by a crash is closed at the next start.
  - **Main** (`main/agent/`): `tools/` (10 tools on the Phase 4 services; `git.log` added to `GitService`), `tool-executor.ts`
    (validate → classify → prepare → permission → run → audit → redact, one write/execution call at a time per run),
    `permission-engine.ts`, `command-classifier.ts`, `command-runner.ts` (one non-interactive shell command, timeout, tail-kept
    capped output, ANSI stripped, tree kill, synchronous kill on quit, credentials stripped from the env, real exit codes
    through PowerShell), `redactor.ts`, `unified-diff.ts` (`diff`), `run-report.ts`, `agent-changes.ts` (list / diff / revert),
    `system-prompt.ts`, `agent-service.ts` (the bounded loop, persistence, report), `ipc/agent.ts`; `code/code-services.ts`
    shares one `CodeFileService` / `GitService` between the editor and the agent.
  - **Renderer**: composer mode chip with `plan` / `build` (disabled with a reason when the model has `tool_call: false`),
    agent picker; thread: compact activity rows (`● read src/x.ts  12 lines`, `✓ run node --test  exit 0 · 0.6s`, collapsible diff /
    live output), inline permission prompt (`AGENT REQUESTS · run (execution)`, exact command + cwd, `[allow once] [allow session]
    [allow workspace] [deny]`, destructive variant with only once / deny and a signal warning, keyboard O/S/W/D, Esc denies),
    run report block; right-hand **Changes** panel (files with `+N -M`, Monaco diff, `[revert file]` / `[revert all]`,
    `[revert anyway]` for a file edited since); bottom panel **AGENT** tab with live command output; Settings → **Agents**
    (limits, the six agents, instruction editing) and **Permissions** (grants, revoke); palette entries.
  - **Tests**: **1165** unit tests pass (shared 150, storage 82, providers 117, desktop 816; was 647) **plus 29 Playwright
    tests against the real built app** (was 18). New, all network-free:
    - *Real-SDK wire tests* (`tool-wire.test.ts`, 25): Anthropic Messages, OpenAI Responses and OpenAI Chat Completions, each
      with scripted SSE in its real format — tool serialization and where the system prompt lands, a parsed tool call, our
      result sent back in the provider's shape, `is_error`, invalid arguments, unknown tool, parallel calls, the step bound,
      abort mid-tool, and "plain chat is unchanged".
    - *Agent loop through the real SDK* (`agent-service.test.ts`, 43 = 13 × 3 formats + guards): read (no prompt) → patch (prompt
      with diff) → run tests → report; deny; failing tests; a pipe-masked test not counted; edits after the last test run
      flagged; a hostile file stays data and the destructive prompt offers once/deny; Plan exposes no write/terminal; step limit;
      cancel while a prompt is open and while a command runs; wall-clock limit; no `tool_call` support refused before anything
      is saved; one run per workspace; read-only agents in Build.
    - *Permission engine* (25): default ask, grant scopes (session per conversation, workspace persisted, exact-command keys,
      tool+risk keys, revoke), destructive / no-grant refuse any grant answer and ignore stored grants, forged / repeated /
      expired / mis-decided request ids, cancel while pending, abort signal, ids are random UUIDs.
    - *Tools + executor* (44 + 25): each tool's validation and path-safety reuse (absolute, `..`, secrets, `.git`, junction
      escape), **patch exact-once** (0 / 2 matches, empty, identical, whitespace hint, CRLF, BOM), **stale-hash refusal** (and
      edited-while-prompt-open), write overwrite threshold, snapshots keep the exact bytes, git tools on a real repository,
      audit rows (order, decision sources, redacted input), live output events, redaction in results / stored detail / stored
      input, child env scrubbed, serialization of write/exec calls.
    - *Classifier* (242): tables of destructive (incl. quoted / split / computed / nested / chained / obfuscated: `r""m`, `$cmd`,
      `bash -c "rm …"`, `xargs rm`, `git checkout -- .`, `Remove-Item -Recurse`, redirects outside the workspace, hidden control
      characters), plain execution (incl. text that only *mentions* danger: `echo rm`), network, no-grant, test-command
      detection, and a **"known gaps"** table asserting what it cannot see.
    - *Runner* (23, real shell, real process trees), *redactor* (19), *unified diff* (12, incl. `git diff` agreement and
      patch round trips), *changes / revert* (19: exact bytes restored incl. BOM + CRLF, created file removed, edited-since
      refused / forced, revert all, forged path), *report facts*, shared (+14), storage (+9 incl. migration 0006 over populated
      rows), renderer reducer / row helpers (17) and `modeProblem` for plan/build.
    - *E2E* (`e2e/agent.e2e.ts`, 11; scripted OpenAI-compatible server as a **custom endpoint**, so the real provider adapter
      and SDK run): "Find why this test is failing and fix it." in a temp git repo with a failing `node --test` — reads
      without prompts → command prompt with exact text + cwd → test really fails (exit 1) → patch prompt shows the diff while the
      file on disk is untouched → approve → file changed exactly → tests rerun and **exit 0** → report matches disk, exit codes
      and audit decisions; Changes panel lists `src/math.js +1 -1`, shows Monaco's diff, `[revert file]` restores the exact
      original bytes; a destructive `rm` offers only allow-once / deny, `W` / `S` do nothing, deny keeps the file and the report
      says "denied by you"; cancel mid-run kills a command (its pid is gone); Plan's Planner is not offered a write tool or the
      terminal; a model without tool support gets disabled plan/build with the reason; Settings → Permissions lists and revokes
      grants; **quitting kills a running command and leaves no prompt behind**; a workspace grant survives a restart; no console
      errors and empty main-process stderr. Run twice: green both times.
  - **Real bugs found by this phase's own tests and fixed**: (1) **zod as a direct `dependency` of the app broke the sandboxed
    preload** (`window.api` undefined) — now a `devDependency`; (2) **a command still running when the app quit survived it**
    (the asynchronous `taskkill` was cut short by the exit) — the quit path now kills synchronously; (3) PowerShell's `-Command`
    reported exit 1 for any failing native program (would have made "exit 3"/"exit 0" claims untrustworthy) — wrapped to keep the
    real code; (4) colour escape codes in command output (`FORCE_COLOR` inherited from the parent) — stripped and the variable
    removed; (5) screenshot QA: denied/failed rows put their whole message in the row's summary (overflowed the page), the
    composer footer pushed the send button out of the box once `[changes N]` appeared, the destructive prompt advertised keys for
    answers it does not accept, "granted now ago", a running command did not open its output.
  - **Verified**: `pnpm install --frozen-lockfile`, `pnpm -r typecheck`, `pnpm exec eslint .`, `pnpm -r test` green (exit codes
    checked, not piped away); `pnpm --filter @ai-workspace/desktop test:e2e` (build + 29 tests) green **twice**; the production
    renderer bundle has no `Personal Website` / mock strings (0 hits in `out/renderer/assets/*.js`). Bundles: main 3.27 → **3.42
    MB**, preload 222 → **238 KB** (zod bundled), main renderer chunk 1.00 → **1.05 MB**. **Migration 0006 over a COPY of the
    real `workspace.sqlite3` (+ WAL/SHM; the live file was only copied, never opened)**: migrations `[1,2,3,4,5]` → `[1,2,3,4,5,6]`;
    row counts before → after: workspaces 0→0, conversations 0→0, messages 0→0, message_parts 0→0, attachments 0→0,
    provider_configs 2→2, model_catalog 14→14, settings 8→8, workspace_file_roots 0→0, workspace_files 0→0 (`schema_migrations`
    5→6); the four new tables exist and are empty; `messages` / `settings` rows byte-identical. (The user's real database
    currently holds no conversations, so the populated-rows case is covered by the unit test that seeds rows and migrates.)
  - **Screenshot QA (done, iterated)**: from the **real app** (real main process + preload, scripted model), captured with
    `webContents.invalidate()` then `capturePage()`, at 1920x1080 dark, 1280x720 dark and 1920x1080 light — 45 PNGs (15 states ×
    3) in `.claude/paused/phase5-screenshots/`: Plan composer, plan run in progress (rows + step 5/25), plan finished with
    report, execution prompt (command + cwd), patch prompt with diff, run report, Changes panel + Monaco diff, destructive
    prompt, denied run + report, a running command with live output, bottom-panel AGENT tab, Settings → Permissions, Settings →
    Agents, a model without tool support (composer problem line and the disabled mode menu). Each was looked at; the fixes are
    item (5) above.

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
- ~~Model ids offered in the renderer's `ModelSelector` are a small
  hardcoded list per provider rather than fetched from each provider's
  models API~~ — **fixed in Phase 4** (live-fetched, cached catalog per
  provider config — see ADR-015). A small static fallback remains for
  Anthropic only, and Google still uses a small hardcoded list (see Phase 4
  Known limitations below).
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
- ~~**Google model catalog is not live-fetched.**~~ **Fixed by the models.dev
  integration** (ADR-023): Google is fetched live (`x-goog-api-key`,
  `generateContent` models only — unit-tested with a mocked `fetch`, **not**
  exercised against a real Google key) and falls back to models.dev's list.
  Historical note: `fetchProviderModels`
  throws for `google`; the renderer keeps the small hardcoded two-model
  list from Phase 2 (`lib/models.ts`) and "Refresh models" for a Google
  provider config returns `ok: false` with an explanatory message instead
  of attempting a network call. Explicitly allowed by the task ("if time
  allows... don't block on it") — see ADR-015. Google's `ListModels`
  endpoint uses the same header-auth pattern (`x-goog-api-key`) as
  Anthropic/OpenAI and would follow the same `fetchProviderModels` shape if
  picked up later.
- **Reasoning effort is not wired up for Google models at all** (chat
  itself is unaffected — only the effort selector/parameter). See ADR-016.
- The `testConnection` probe in `ipc/provider-config.ts` (used by
  Settings' "Test connection" button, before a provider config exists to
  fetch a real catalog for) still uses its own small hardcoded per-provider
  probe model id, unchanged from Phase 2 — this is a narrower, different
  concern than the picker's catalog (validating that a not-yet-saved key
  works at all, not offering model choices) and was left as-is rather than
  in scope for the live-catalog work.
- **The new model-picker popover, the low/medium/high effort control, and
  the persisted-last-used-selection default were NOT interactively
  verified** — no GUI automation was available in this session (same
  constraint as Phase 3's file pickers/Context Inspector). The underlying
  logic is covered by real unit tests (`model-catalog-fetcher`,
  `reasoning-options`, `ModelCatalogRepository`, `lib/model-picker`, plus
  the extended shared-schema and settings-repository tests) and the app was
  confirmed to build, migrate a copy of the real db, and launch without a
  main-process crash — but clicking through the actual popover (search,
  arrow-key navigation, Enter/Escape, the effort buttons, the custom-model
  entry, "Refresh models") and confirming the remembered selection actually
  restores correctly across a restart has not been done. Per Phase 2/3
  precedent, expect the user to manually test this and report any real UI
  bugs.

- **UI redesign — known limitations:**
  - Screenshot QA ran the real renderer (Electron's Chromium) against the
    dev-only mock API, not the real main process. The real app was built
    and launched (no main-process errors), and the logic layer is covered by
    the test suite, but the native file/folder pickers and live provider
    streaming were not driven through the GUI against real keys in this
    session.
  - `[retry]` / `[regenerate]` reuse the existing regenerate semantics
    (re-send the last user turn, append the answer), so retrying a failed
    turn also re-appends that user message to the persisted history.
  - The serif stack resolves to Sitka Text on Windows (Iowan Old Style /
    Charter are macOS/Linux fonts); assistant prose looks slightly heavier
    there than on nochan under macOS.
  - No syntax highlighting in code blocks (monochrome by design for now;
    `--code-function`/`--code-changed` tokens are reserved).
  - The composer textarea is a fixed 3 rows that scrolls; it does not
    auto-grow. ↑-to-edit-last-message is not implemented (no message-edit
    backend exists). `@model` mentions (P1) were skipped.
  - First-run onboarding creates a workspace named "My workspace" when none
    exists.

- **models.dev integration — known limitations:**
  - **Nothing was run against real provider APIs** for the new providers: the
    wire format is proven with a stubbed `fetch` (request URL, body, headers,
    reasoning parameter) and the SDK option schemas, not with live xAI/Mistral/
    Groq/DeepSeek/OpenRouter/Ollama calls. The only live traffic this session
    was the real `GET https://models.dev/api.json` (works; see Verified). The
    user's existing Anthropic/OpenAI keys were not exercised either. Expect
    provider-specific surprises (e.g. an OpenAI-compatible server that rejects
    `stream_options.include_usage`) on first real use; Ollama in particular was
    only tested with a mocked `/api/tags`, not a running daemon.
  - **Not supported**: Azure OpenAI, Amazon Bedrock, Google Vertex, SAP AI Core,
    watsonx, GitLab, Cloudflare Workers AI/AI Gateway, Snowflake, Databricks,
    GitHub Copilot, and the Vercel AI Gateway (never mandatory) — ADR-025. A
    provider whose models.dev entry needs a per-model `provider` override has
    those models dropped (ADR-022).
  - **Effort control covers effort-style reasoning only.** Models that reason
    through `budget_tokens` only (Claude Haiku 4.5/Sonnet 4.5, Gemini 2.5) or a
    plain on/off toggle expose no control in V1; Perplexity's SDK cannot send an
    effort at all, so none is offered. Anthropic's budget tiers
    (`ANTHROPIC_THINKING_BUDGET_TOKENS`) are a starting point, as in ADR-016.
  - **Key-prefix hints** for xAI (`xai-`), Groq (`gsk_`), OpenRouter (`sk-or-`),
    Perplexity (`pplx-`) and Cerebras (`csk-`) come from provider-key guides, not
    first-party docs (which show placeholders only). A bare `sk-` key is now
    ambiguous (OpenAI or DeepSeek) and asks the user to pick, a small regression
    from the old "`sk-` means OpenAI" guess.
  - **Metadata can be stale or wrong.** models.dev is community data: prices,
    context sizes and effort lists can lag a provider; the bundled snapshot is a
    point-in-time copy (regenerate with `pnpm models:snapshot`, a manual step);
    with the download turned off, models newer than the snapshot show no
    metadata (they still work — unknown ids are offered and nothing reasoning-
    related is sent for them).
  - **The snapshot is deliberately partial** (202 providers, the long tail of
    aggregators capped): the first-run/offline provider list is therefore shorter
    than the live one (which, once downloaded, is uncapped).
  - **Bundle growth**: main process 1.93 → 3.17 MB, renderer 1.26 → 1.98 MB
    (see Bundle sizes). No code splitting yet; the provider SDKs are statically
    imported.
  - `useModelCatalogs` still auto-refreshes a never-fetched config once per
    session; for providers with no list endpoint (Perplexity) or a stopped
    Ollama that records a quiet `ok: false` that the picker does not surface.
  - The Browser-pane screenshot tool was unreliable at emulated sizes (tiled /
    stale frames), so the mandated PNGs were captured with an Electron script
    against the same dev server; the pane was used for interactive spot checks
    (console errors, DOM state) at its native 800x450.
  - Scroll-follow behaviour was checked scripted (lands at bottom, escapes on
    wheel-up, `[↓ latest]` appears, send jumps to bottom) but a user scrolling
    *during* a long live stream was not exercised — the mock stream is too short.

- **Phase 6 — known limitations:**
  - **Nothing here ran against real provider APIs.** Orchestration is proven with the
    mock provider (concurrency, isolation, cancel, caps, prompts, persistence) and the
    usage path with a stubbed `fetch` through the real SDK; screenshots use the dev mock.
    Expect first-contact surprises with real providers — e.g. a provider that reports no
    usage (cost shows `—`), or one that rejects a review prompt's leading system message.
  - **Estimated cost ignores cache discounts and is only as good as models.dev's price**
    (community data); it is always labelled "est." and `—` when price or usage is unknown.
  - **`retryReply` replays without the original Context Inspector selection** (workspace
    files / attachments are not stored with the turn), so a retried column can differ from
    the others when files were attached. `[regenerate]` has the same property it always had.
  - **Auto's "best" is a price-tier proxy** (models.dev has no quality score), and a prompt
    needing PDF input will rarely find a model: PDF/image attachments cannot be picked in the
    composer yet (the attachment reader only accepts text), so Auto's vision rule is
    exercised by tests and the mock but not by a real attachment today.
  - **Retry of a review/round-table step is not offered** (only a failed review via
    `[retry review]`); a failed round-table turn ends the table — re-run it.
  - **Mode configuration is per window session**, not persisted (only the Auto preference
    is); a new session starts in `chat`. Compare slots carry no per-model reasoning effort.
  - A compare run's `[stop all]`/`cancelOrchestration` cannot interrupt a provider that is
    still *resolving* (before its stream starts); it stops everything once streaming begins.
  - The compare block is wider than the reading column by design (up to 1600 px); at the
    narrowest widths it stacks rather than scrolls.

- **Phase 4 — known limitations:**
  - **Verified on Windows 11 / x64 only.** The terminal, git and path code ran against
    PowerShell 7, a real `git` 2.55 and NTFS. macOS/Linux shells, `@lydell/node-pty`'s
    darwin/linux binaries, POSIX symlink behaviour and a real *file* symlink escape (this
    machine can't create one without Developer Mode — the junction/directory-link cases
    cover the same containment check) were not exercised. A packaged installer was not
    built: it will need the platform PTY package unpacked from the asar.
  - **No language intelligence.** Syntax highlighting only (Monarch) — no hover, go to
    definition, completion, diagnostics or formatting; the TS/CSS/JSON services were left
    out on purpose (ADR-033). Find/replace, multi-cursor, folding and the diff editor work.
  - **One font asset is CC-BY-4.0.** Monaco bundles the codicon font (see
    OPEN_SOURCE_INVENTORY.md) — attribution is recorded; the owner should confirm or
    ask for it to be replaced.
  - **Editing scope**: no create / rename / delete file from the tree (use the terminal), no
    split editors, no drag-reorder of tabs, no "go to line" UI beyond Monaco's Ctrl+G, no
    soft-wrap toggle; files over 1 MB open read-only, over 5 MB not at all; non-UTF-8 text is
    refused rather than guessed. A file with mixed line endings is normalized by Monaco to its dominant
    ending on save (expected Monaco behaviour, not exercised by a test). The file tree honours only the root `.gitignore`.
  - **Search is a bounded scan** (≤ 5000 files / 64 MB / 5 s / 300 hits) with plain substring
    matching — no regex, no whole-word, no include/exclude globs.
  - **Git scope**: status refreshes by polling (4 s while visible), on focus and after
    actions; renames are shown only when git detects them; merge conflicts are listed but not
    resolved here; no hunk-level staging; `commit` runs the repository's hooks and any GPG
    prompt (120 s timeout); an amend, branch switch, push, pull, stash or reset does not
    exist by design.
  - **Terminal scope**: no search, no link detection, no split panes, no per-terminal rename,
    no profile picker (the shell is auto-detected: pwsh → Windows PowerShell → cmd); the
    scrollback is 5000 rows in xterm and 200 KB replayable from main. Quitting kills the PTY
    (verified: the shell pid is gone); whether a deliberately detached grandchild process
    also dies was not tested.
  - **AI → terminal**: at the end of Phase 4 there was deliberately no path from a model to a
    terminal; Phase 5 added one — `terminal.execute`, a separate non-interactive process behind
    the permission engine (ADR-041/042). The user's PTY terminals are still never typed into by a model.
  - Screenshot QA ran the real app, not a packaged build; the native folder dialog is stubbed
    in tests (the real dialog is the existing, untouched Phase 3 picker).

- **Phase 5 — known limitations (be blunt):**
  - **Nothing here ran against a real provider.** The wire format is proven through the real AI SDK with a stubbed
    `fetch` speaking Anthropic Messages, OpenAI Responses and Chat Completions SSE, and the app end to end against a scripted
    OpenAI-compatible server — but no live Anthropic / OpenAI / Gemini call was made with tools. Provider-specific surprises
    are likely on first contact (e.g. a model that emits several tool calls with partial JSON, reasoning-with-tools state
    that Anthropic requires to be echoed back, a compatible server that rejects `tool_choice`, an Anthropic `max_tokens`
    of 128 000 chosen by the SDK default). Gemini / Mistral / Groq / DeepSeek … go through the same adapter but their tool
    wire formats were not exercised at all.
  - **The command classifier is a speed bump, not a sandbox** (ADR-042). It does not see inside scripts, Makefiles or npm
    scripts, aliases / functions defined in the same command, symlinked relative paths, or anything the shell must evaluate;
    "outside the workspace" is judged from path text. Approving `npm run clean` approves whatever `package.json` says.
    These gaps are asserted in a test so they cannot silently drift. Unknown commands are `execution` (ask), never `safe`.
  - **Files changed by commands are not snapshotted and cannot be reverted** (only `write` / `patch` edits can). They are
    listed in the report as "changed by commands" from a before/after `git status`, best effort, repository only, and a file
    already dirty before the run that a command modifies again is not noticed.
  - **Revert** restores a file to how it was before the run's FIRST edit of it; there is no per-edit undo inside a run, no
    revert of a created directory (only the file), and no "revert" for a file renamed by a command.
  - **Redaction is pattern-based**: a secret in an unusual format, split across lines or encoded reaches the provider; a
    command's output may contain a secret the user approved printing. Deny-listed files are the stronger control.
  - **Permission model**: session grants are per conversation and in memory (gone on restart); there is no "allow every
    command" (by design); a workspace grant for `filesystem.patch` covers every file in that workspace, including
    `package.json` or a CI config; the prompt's diff preview is cut at 20 000 characters (counts are exact).
  - **No git commit tool** (`git.commit` was not built; the terminal can run `git commit`, which is allow-once-only). No MCP.
  - **Agents**: instructions are editable, model preference is stored data with no UI, there is no way to create a new agent,
    and `contextPolicy: 'task-only'` is implemented but no built-in uses it.
  - **UI**: a renderer reload mid-run loses the live block (the run continues; open prompts are restored, the composer is
    not locked); one run per workspace; the Changes panel groups by run of the open conversation only; the dev browser mock
    (`pnpm dev:renderer`) has no agent fixtures (agent runs reject there) — the screenshots were taken from the real app.
  - **Verified on Windows 11 / x64 + PowerShell 7 only.** bash/zsh, `cmd` fallback, POSIX process groups and macOS were not
    run (unit tests cover the argument construction and detection with fake `exists`).
  - Prompt-injection resistance is only as strong as the permission prompt: a plausible-looking command or patch that a
    rushed user approves will run.

**Next exact task:** the original roadmap continues with **Phase 7** (MCP) — the tool layer and permission engine are the
integration point (`mcp.call` becomes another provider of `ToolDefinition`s, with its own risk classification and the same
prompts). Don't start it out of order. Before that, short follow-ups worth doing: (1) **run Plan and Build once against live
Anthropic and OpenAI keys** (and one OpenAI-compatible provider such as Groq) and note provider quirks in the tool loop —
this is the biggest unverified surface of Phase 5; (2) a manual pass on macOS/Linux (shell detection, bash, process groups, PTY
binaries, symlink case) and a decision on the codicon font; (3) `git.commit` as an always-ask-every-time tool, and a
per-agent model preference UI, if wanted.
