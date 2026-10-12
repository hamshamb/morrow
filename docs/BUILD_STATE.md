# Build State

**Current phase:** models.dev + provider registry (complete, on branch —
pending merge): every provider models.dev lists that has a bundled SDK or a
plain OpenAI-compatible URL, plus Ollama and a custom endpoint, with per-model
metadata and exact reasoning-effort values — see "models.dev integration"
below and docs/DECISIONS.md ADR-021…026. Before it: the UI redesign
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

**Next exact task:** **Side-by-side model compare** (send one prompt to
2–3 models at once, responses in columns — Msty/ChatHub style). This is
roadmap **Phase 6** multi-model orchestration and needs real backend work
(parallel provider streams, sibling-response storage); the palette's
"models" group and the composer footer leave room for its entry point
(ADR-019). After that, the original roadmap continues: Phase 4
(repo/editor/terminal workspace — the disabled `/code /terminal /git` tabs),
Phase 5 (agents + tool-permission engine, which unlocks Plan/Build modes),
Phase 7 (MCP). Don't start them out of order.
