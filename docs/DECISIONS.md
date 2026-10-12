# Architecture Decision Records

Format: short, dated, append-only. Superseded decisions are marked, not
deleted.

## ADR-001: Electron + React + TypeScript + Vite over Tauri (2026-09-27)

**Decision**: Build on Electron via `electron-vite`, React 19, strict
TypeScript.

**Why**: The target ecosystem (Vercel AI SDK, official MCP SDK, Monaco,
xterm.js, node-pty) is TypeScript/Node-first. Electron avoids a Rust bridge
for every one of those integrations. Tauri's smaller binary size is a real
advantage but not decisive for V1; it can be revisited after profiling if
resource usage becomes a problem.

**Status**: Accepted.

## ADR-002: pnpm workspace monorepo (2026-09-27)

**Decision**: `apps/desktop` + `packages/*` under a single pnpm workspace.

**Why**: Clean boundaries between the Electron shell, storage, provider
abstraction, and tool layer without publishing separate npm packages.
Coarse-grained packages — avoid micro-package fragmentation.

**Status**: Accepted.

## ADR-003: Vercel AI SDK as the model abstraction (2026-09-27)

**Decision**: Use `ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` +
`@ai-sdk/google` as the low-level streaming/tool-calling layer, wrapped by
our own `packages/ai-core` provider-independent interface. Ollama and
OpenAI-compatible endpoints are integrated via `@ai-sdk/openai-compatible`
style adapters rather than a bespoke client.

**Why**: Apache-2.0 licensed, actively maintained, already normalizes
streaming/tool calling/structured output across providers. Reinventing this
would be pure cost with no product differentiation. Our own conversation
schema and orchestration modes (Compare/Review/Round Table/Auto) sit on top
so we are never locked into the SDK's own conversation model.

**Status**: Accepted. Do not adopt Vercel AI Gateway as a requirement —
provider-direct calls with user-supplied keys remain the default path.

## ADR-004: Electron `safeStorage` instead of keytar/napi-rs-keyring (2026-09-27)

**Decision**: Use Electron's built-in `safeStorage` module (OS
keychain/DPAPI/libsecret backed) to encrypt provider credentials at rest,
storing the encrypted blob in SQLite. No native keyring dependency.

**Why**: `keytar` is archived/unmaintained. `@napi-rs/keyring` is viable but
adds a native module and platform prebuild surface we don't need — Electron
already ships equivalent OS-backed encryption with zero extra native
compilation. Smaller dependency surface, one fewer native module to rebuild
per Electron ABI bump.

**Status**: Accepted.

## ADR-005: better-sqlite3 for storage, node-pty for terminals (2026-09-27)

**Decision**: `better-sqlite3` (synchronous, simple, MIT) for application
state; `node-pty` (MIT) for terminal PTYs; `@xterm/xterm` for terminal
rendering; `monaco-editor` for code editing.

**Why**: All are the de facto standard, permissively licensed, and used
directly rather than reimplemented, per the "do not build a code editor /
terminal emulator" directive. Both `better-sqlite3` and `node-pty` are
native modules requiring an Electron-ABI rebuild step
(`@electron/rebuild`), which is accepted as necessary cost for local-first
storage and real terminals.

**Status**: Accepted.

## ADR-006: Official MCP TypeScript SDK (2026-09-27)

**Decision**: `@modelcontextprotocol/sdk` for all MCP client behavior
(stdio first, streamable HTTP once stable in our target SDK version).

**Why**: Directive is explicit — do not create a proprietary equivalent.

**Status**: Accepted.

## ADR-007: Provider-independent internal tool layer (2026-09-27)

**Decision**: One internal tool registry (`filesystem.*`, `git.*`,
`terminal.execute`, `workspace.search`, `mcp.call`) that every provider
calls through. Provider adapters translate our tool schema into each
SDK's tool-calling format; they never implement their own tool logic.

**Why**: Prevents provider-specific logic and duplicated permission/audit
enforcement from leaking into the UI or into three separate tool
implementations.

**Status**: Accepted.

## ADR-008: Streaming chat responses over per-request IPC event channels (2026-09-27)

**Decision**: A chat turn is sent via a single `ipcMain.handle` call
(`chat:send-message`) that resolves once the assistant message is fully
persisted. While that request is in flight, the main process pushes
incremental text deltas to the renderer via `webContents.send` on a channel
named dynamically per request: `` `chat:stream:${requestId}` `` (see
`chatStreamChannel` in `packages/shared/src/ipc.ts`). The renderer generates
`requestId` (via `crypto.randomUUID()`) and subscribes with
`ipcRenderer.on` *before* invoking `sendMessage` with that same id, so no
chunk can be missed to a race. `ChatStreamEvent` is a discriminated union
(`delta` | `done` | `error`); `done` always carries the final persisted
`Message` (including its terminal `status`), so the renderer's source of
truth is the same object whether the turn completed, errored, or was
cancelled.

**Why considered alternatives**:
- A single shared streaming channel multiplexed by `requestId` inside the
  payload was rejected — it forces every subscriber to filter irrelevant
  events and makes unsubscribing on unmount error-prone.
- Returning an `AsyncIterable`/Node stream across the context-bridge isn't
  supported by Electron's structured-clone-based IPC; chunked events are the
  standard pattern for this transport.

**Cancellation**: `chat:cancel(requestId)` aborts an `AbortController` kept
in `ChatService` (`apps/desktop/src/main/chat-service.ts`) keyed by
`requestId`; the provider stream observes `AbortSignal` and the partial
response is persisted with `status: 'cancelled'`.

**Status**: Accepted.

## ADR-009: Provider credential masking computed at write time, not read time (2026-09-27)

**Decision**: `provider_configs.masked_key` (e.g. `"sk-ant...ab12"`) is
computed once from the plaintext key when a credential is added and stored
alongside the encrypted blob, rather than derived by decrypting the key
every time the renderer lists configured providers.

**Why**: The masked preview is not sensitive (it reveals only a few
characters, the same as e.g. a payment provider's "card ending in 1234"),
so storing it avoids invoking `safeStorage.decryptString` — and therefore
touching the OS keychain — on every provider-list render. Decryption is
reserved for the moment a request actually needs to call the provider.

**Status**: Accepted.

## ADR-010: SQLite FTS5 for lexical retrieval, not embeddings (2026-09-27, Phase 3)

**Decision**: Index workspace file content into a `workspace_files_fts` FTS5
virtual table (`better-sqlite3`'s bundled SQLite — verified directly against
this project's exact `better-sqlite3` version that `CREATE VIRTUAL TABLE ...
USING fts5(...)`, `bm25()`, and `snippet()` all work before committing to
this) and rank/snippet matches with `bm25()`/`snippet()`. No
embeddings/vector index in Phase 3.

**Why**: The product brief states lexical search is the V1 retrieval
baseline and embeddings are only justified later — Phase 3 doesn't meet that
bar. FTS5 ships inside `better-sqlite3` at zero extra dependency/native-module
cost, requires no network calls or model downloads, and is good enough for
"find relevant files by keyword" over a local workspace.

**Tradeoffs accepted**: no semantic/fuzzy matching, no stemming (the FTS5
table is *not* configured with `tokenize='porter'`, so plurals/word forms
must match exactly — e.g. searching "authenticate" will not match
"authenticated"). A user-facing keyword search box
(`WorkspaceFileRepository.search`, default `mode: 'and'`) requires every
token to match the same file — appropriate for a deliberate multi-keyword
search. The Context Inspector's auto-surfaced "relevant files" suggestion
from free-form chat draft text instead uses `mode: 'or'` (any token
matches) — requiring every word of a natural-language sentence to appear
verbatim in one file would almost never match anything.

**Status**: Accepted.

## ADR-011: Workspace file exclusion — built-in deny-list always wins, full re-walk per (re)index (2026-09-27, Phase 3)

**Decision**: `walkWorkspaceFiles` (`apps/desktop/src/main/workspace-file-indexer.ts`)
builds one `ignore`-package (MIT) filter per walk: the hardcoded
`DEFAULT_DENY_PATTERNS` (`.env*`, credentials/private-key file patterns,
`.git/`, `node_modules/`, build output directories, common binary/media
extensions — see `packages/shared/src/workspace-file.ts`) is always added
first, then the workspace root's own `.gitignore` (if present) is appended
on top. Symlinks are never followed. A full re-walk replaces the entire
index every time (`WorkspaceFileRepository.replaceIndex`) — no incremental
diffing against the previous index.

**Why**: The deny-list must apply even when a workspace has no
`.gitignore`, or a `.gitignore` that doesn't happen to exclude something
sensitive — see ARCHITECTURE.md "Security model" ("Document ingestion and
repository indexing respect `.gitignore` plus a built-in deny-list").
Layering the deny-list first, with `.gitignore` only ever adding more
exclusions, means nothing the user's own `.gitignore` does can widen what
gets indexed past the built-in floor. `ignore` (MIT, zero dependencies) is a
correct, permissively-licensed `.gitignore`-semantics parser — reimplementing
gitignore glob matching would be pure risk for no benefit.

**Tradeoffs accepted**: full re-walk on every (re)index is `O(files)` and
will get slow on a very large repository — capped at `MAX_INDEXED_FILES`
(5000) as a safety valve for V1. Revisit with incremental (mtime-based)
diffing if this becomes a real workflow pain point.

**Status**: Accepted.

## ADR-012: Token estimate = characters ÷ 4, always labeled an estimate (2026-09-27, Phase 3)

**Decision**: `estimateTokens()` (`packages/shared/src/context.ts`) is
`Math.ceil(characterCount / 4)`. Every UI surface that shows a token count
derived from it (the Context Inspector) labels it as an estimate.

**Why**: A real tokenizer is provider- and model-specific (different
providers use different BPE vocabularies), and Phase 3 explicitly should
not add a tokenizer dependency just to show a rough context-size indicator.
Chars/4 is the standard back-of-envelope heuristic for English-ish text and
is good enough for "does this look huge or small," which is all the Context
Inspector needs it for.

**Status**: Accepted.

## ADR-013: Context selection injected as one synthetic, non-persisted provider message (2026-09-27, Phase 3)

**Decision**: What the Context Inspector leaves toggled on for a turn
(`ContextSelection` in `SendMessageInputSchema.contextSelection`) is
resolved by `ContextService.resolveContextBlock` into a single block of text
injected as one extra `role: 'system'` message immediately before the
current user turn in the array sent to the provider
(`apps/desktop/src/main/chat-service.ts`). It is never written to
`messages`/`message_parts` — the persisted conversation only ever contains
what the user actually typed. Two character caps apply, in order
(attachments, then explicitly selected workspace files, then retrieval
snippets): `CONTEXT_PER_SOURCE_CHAR_CAP` (20,000 chars) truncates any single
source, and `CONTEXT_TOTAL_CHAR_CAP` (60,000 chars) truncates/drops sources
once the combined block would exceed it. `includeHistory: false` also
drops every prior persisted message from the provider request for that one
call (without deleting anything).

**Why**: This is the mechanism that makes "what's toggled on in the Context
Inspector is what goes out" literally true — `ContextService` is the single
place both the inspector preview and the actual send path compute source
content, using the same per-source truncation, so the inspector's numbers
are not decorative. Not persisting the block keeps the visible chat thread
free of large file dumps (which would also break "Regenerate" and history
replay, since every later turn resends the full history). Ordered
truncation (rather than i.e. proportionally shrinking every source) keeps
behavior simple and predictable — the brief asks for the simple selection
mechanism, not a full compaction/summarization system.

**Status**: Accepted.

## ADR-014: Pin a single `@types/node` version across the workspace (2026-09-27, Phase 3)

**Decision**: `pnpm-workspace.yaml` gets an `overrides: { '@types/node':
24.19.0 }` entry.

**Why**: Without it, `apps/desktop`'s own tsc compilation pulled in two
different `@types/node` versions simultaneously — one via `electron-vite`'s
own peer-resolved copy, one via `packages/providers`' devDependency copy —
which produced spurious `Property 'onabort' is missing in type
'AbortSignal'` errors from incompatible duplicate ambient global
declarations. Confirmed via a clean isolation test (reverting only the
Phase 3 files and re-running `tsc`) that this was a pre-existing dependency-
resolution issue, not something Phase 3 code introduced — it just hadn't
been exercised by any file's type graph yet. Pinning one version workspace-
wide removes the duplicate declaration entirely.

**Status**: Accepted.

## ADR-015: Live-fetched model catalog, cached per provider config, with a narrow static Anthropic-only fallback (2026-09-27, Phase 4)

**Decision**: `apps/desktop/src/main/model-catalog-fetcher.ts` calls each
provider's real models-list endpoint (`GET /v1/models` for both Anthropic
and OpenAI — headers verified against the installed `@ai-sdk/anthropic`/
`@ai-sdk/openai` source: `x-api-key` + `anthropic-version: 2023-06-01` for
Anthropic, `Authorization: Bearer` for OpenAI) and caches the result in a
new `model_catalog` table (migration 0004), scoped by `provider_config_id`
rather than by provider — two API keys for the same provider can have
access to different model sets. The fetch happens automatically
(fire-and-forget, never blocking or failing `providerConfigsAdd`) right
after a provider config is added, and again on demand via a "Refresh
models" action in the picker. `ModelCatalogRepository.replaceForProviderConfig`
fully replaces the cached set per refresh (same wholesale-replace pattern
as `workspace_files`, see ADR-011) rather than diffing.

A static fallback (`ANTHROPIC_FALLBACK_MODELS` in `packages/shared`) is
shown only before a live fetch has ever succeeded, or if one fails, and
only for Anthropic — the four ids
(`claude-sonnet-5`, `claude-opus-5-5`, `claude-haiku-4-5-20251001`,
`claude-fable-5-1`) were the only ones confirmed current at the time this
was written. **OpenAI has no static fallback at all**: no confirmed-current
OpenAI model ids were available in this session, and the project's own
standing rule ("never hardcode current model names as business logic")
means guessing at ids like a `gpt-5` variant would be exactly the mistake
Phase 2's `not_found_error` bug (BUILD_STATE.md, commit `1351a95`) already
taught this codebase to avoid. An OpenAI provider config's picker is empty
until its first live fetch succeeds (or a custom model id is typed in —
always available regardless of catalog state, per the original product
brief). A free-text custom model id entry is always available in the picker
for every provider, as an explicit override/fallback.

**Known limitation — Google**: `fetchProviderModels('google', ...)` throws
rather than making a request; Google keeps the small hardcoded fallback
list from Phase 2 in the renderer (`lib/models.ts`) unchanged, and its
"Refresh models" action returns `ok: false` with an explanatory message
instead of attempting a call. Google's `ListModels` endpoint uses the same
kind of header auth (`x-goog-api-key`, verified against the installed
`@ai-sdk/google` source) as Anthropic/OpenAI and would follow the same
pattern — this was deliberately left out of Phase 4's scope (the task
explicitly allowed this: "if time allows... don't block on it") rather than
rushed.

**Why**: Stops the model list from going stale again the way the Phase 2
hardcoded catalog did (see BUILD_STATE.md's Known issues). Caching in
SQLite (rather than re-fetching on every app start) keeps the composer
usable offline/without an extra network round trip on every launch, per the
task's explicit requirement ("Cache the fetched list in SQLite... so it
survives restart without re-fetching every launch").

**Status**: Accepted; the Anthropic-only static fallback, the renderer's
hardcoded Google list and "Google live fetch is not implemented" are
**superseded by ADR-021/023** — every config now falls back to models.dev's
list for its provider, and Google's models are fetched live. The
per-config SQLite cache (migration 0004) is unchanged.

## ADR-016: Reasoning/thinking effort mapping — dual-send for Anthropic, direct passthrough for OpenAI (2026-09-27, Phase 4)

**Decision**: A three-tier `low | medium | high` effort selector
(`ReasoningEffortSchema` in `packages/shared`) is exposed per-model in the
composer, gated by a per-model-id heuristic (`isReasoningCapableModel`) —
never a hardcoded model allowlist. `packages/providers/src/adapters/
reasoning-options.ts` maps it onto each provider's actual `providerOptions`,
verified against the exact installed SDK versions in this repo
(`@ai-sdk/anthropic@4.0.65`, `@ai-sdk/openai@4.0.78`):

- **Anthropic**: sends *both* `providerOptions.anthropic.effort` (the lever
  for models that always use adaptive thinking, e.g. `claude-opus-5-5`,
  `claude-fable-5-1` — direct passthrough of `low`/`medium`/`high`) *and*
  `providerOptions.anthropic.thinking = { type: 'enabled', budgetTokens }`
  (the lever for models still on the legacy explicit-budget thinking mode).
  These are independent fields in the SDK's own option schema (not a
  discriminated union against each other), and the SDK's own documented
  behavior is to drop whichever one a given model doesn't support with a
  warning, never a hard error — so sending both means this codebase doesn't
  need to know in advance which "generation" a given (possibly
  previously-unseen, live-fetched) model id belongs to. Budget-token tiers:
  `low: 4000`, `medium: 10000`, `high: 24000` — all comfortably above
  Anthropic's documented 1,024-token minimum, roughly doubling then
  doubling again to give a real difference in thinking room at each tier
  without adding runaway cost at the low end.
- **OpenAI**: `providerOptions.openai.reasoningEffort` accepts
  `'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'` in the installed
  version — our three tiers map directly onto the matching
  `low`/`medium`/`high` values.

**Heuristic for whether a model supports this at all**
(`isReasoningCapableModel` in `packages/shared/src/model-catalog.ts`), by id
only, never an exhaustive allowlist:
- Anthropic: every Claude model *except* Haiku (`id.includes('haiku')`) —
  Haiku does not support extended thinking.
- OpenAI: the `o`-series (`/^o\d/`, e.g. `o1`, `o3`, `o3-mini`, `o4-mini`)
  and the `gpt-5` family (`id.startsWith('gpt-5')`) — OpenAI's
  reasoning-capable model lines as of this writing.
- Google: always `false` — no effort/thinking wiring for Google in Phase 4
  (matches the "known limitation" in ADR-015; Google chat itself is
  unaffected, this only concerns the effort selector).

When a selected model isn't reasoning-capable, the effort control is hidden
in the composer and `ChatService`/the provider adapters never receive (or
silently ignore) an effort value for it — no effort parameter is sent for a
model/provider that doesn't plausibly support it.

**Why**: This is a judgment call with no single "correct" answer — the
installed SDK's own types expose multiple, generation-dependent knobs for
the same underlying concept, and the model ids this app can be pointed at
are open-ended (live-fetched, not a fixed list). Dual-sending for Anthropic
trades a small amount of request payload noise (an unsupported field
dropped with an SDK warning) for correctness across every Claude model
generation without a second per-model-generation lookup table. The budget
tiers are a reasonable, documented starting point, not a scientifically
tuned value — revisit if real usage shows the tiers feel too close together
or too expensive.

**Status**: Accepted; the id-pattern heuristic (`isReasoningCapableModel`) and
the fixed low/medium/high tiers are **superseded by ADR-023** (per-model
capabilities from models.dev). The dual-send idea for Anthropic survives, now
keyed off the model's own `reasoning_options` instead of the model id.

## ADR-017: Persisted last-used model selection (2026-09-27, Phase 4)

**Decision**: `AppSettings.lastModelSelection` (`packages/shared/src/
settings.ts`) is `{ providerConfigId, model, effort } | null`, stored in the
existing flexible key-value `settings` table (no migration needed — it was
already schema-less per key, see `SettingsRepository`). `ChatPanel` saves it
every time the composer's provider/model/effort selection changes (via the
model picker or the effort control), and defaults the composer's initial
selection to it on mount instead of always picking `providerConfigs[0]` +
that provider's first model — but only if the remembered
`providerConfigId` still refers to a provider config that still exists
(it may have been removed since); otherwise it falls back to the previous
behavior.

**Why**: Directly requested ("save past configs... if I used medium
yesterday, today also use medium at startup"). Storing it in `AppSettings`
rather than per-workspace or per-conversation state matches the existing
precedent (`theme`, `activeWorkspaceId` are already global, not
per-workspace) and keeps the mental model simple: one remembered
provider/model/effort for the whole app, restored on the next conversation
started anywhere.

**Status**: Accepted.

## ADR-018: UI redesign — OpenCode for structure/interaction, nochan for visual language; plain CSS, not Tailwind (2026-10-12, UI redesign)

**Decision**: The renderer is redesigned around two references with a
strict division of labor:

- **OpenCode** (`anomalyco/opencode`, MIT — `docs/UI_REFERENCE_OPENCODE.md`)
  = **structure and interaction**: workspace rail + collapsible/resizable
  session list, unboxed assistant turns with only the user's turn as a
  block, one-line activity rows, composer footer row (add-menu, model chip,
  submit alone on the right), command palette (Ctrl/Cmd+K and
  Ctrl/Cmd+Shift+P), contextual right panel, invisible-until-hovered resize
  handles, inline keybind hints.
- **nochan** (https://nochan.vercel.app — the user's own site,
  `docs/UI_REFERENCE_NOCHAN.md`) = **visual language and source of truth**:
  its exact paper/ink token set, IBM Plex Mono chrome, serif long-form
  prose, zero border-radius, rules instead of boxes, inverted chips for
  emphasis, outline uppercase chips for tags, slash-prefixed nav, bracketed
  text actions, square kbd chips, code blocks with a header and ruled
  line-number gutter, accents never used as fills.

This supersedes the first pass of this redesign (Milestone 1), which had
ported OpenCode's own dark-theme color/radius/typography *values*; those
were replaced wholesale by nochan's tokens. OpenCode now contributes only
structure plus a few framework-agnostic *values/algorithms* still in the
code: the resize-handle drag math and hit-target geometry, the
command-palette dialog geometry (640px / 36px rows / top-anchored), and the
search-match normalization — each with a source comment and an entry in
`docs/OPEN_SOURCE_INVENTORY.md`. OpenCode's UI packages are SolidJS, so no
component is imported; everything else is an original React component.
"OpenCode" and "nochan" never appear as branding in the product UI.

**Why not Tailwind (or any CSS framework)**: the look comes from token
*values* and layout *structure*, not from which tool authored the CSS.
Hand-authored CSS on the existing custom-property system needed no new
framework/build-step surface and no rewrite of every component's styling
approach for zero visual gain.

**Font**: IBM Plex Mono is bundled locally via `@fontsource/ibm-plex-mono`
(SIL OFL-1.1 — a font license that permits bundling with software,
explicitly approved for this use), latin subset, weights 400/500/600 only.
Offline-first: no font CDN, and the renderer CSP is `'self'` anyway. The
serif stack is system fonts only.

**Status**: Accepted.

## ADR-019: Deferred multi-model orchestration and agent modes — leave room, build nothing fake (2026-10-12, UI redesign — Milestone 6)

**Decision**: The redesign does **not** build Compare/Review/Round-Table
(or Msty/ChatHub-style side-by-side compare), and does **not** build
Chat/Plan/Build agent modes.

**Why**: Side-by-side compare and the other orchestration modes need real
backend work — parallel provider streams and sibling-response storage —
which is roadmap **Phase 6**. Plan/Build modes need a tool-permission
engine (roadmap **Phase 5**). Neither exists. Rendering visible-but-
non-functional controls for them would violate this project's standing
"no half-finished implementations" rule.

**What was done instead (works on the existing backend today)**:
per-message model attribution chips, "[regenerate with…]" to re-run the
last turn on a different model (appended as a sibling answer, matching the
existing append-not-replace regenerate semantics), favorites/recent models,
and one-click model switching — see ADR-020.

**Leaving room**: the command palette has a "models" group (where a future
"compare across models" command belongs) and the composer footer has free
space between the model chip and the send button for a future mode
selector. Side-by-side compare is recorded in BUILD_STATE.md as the next
phase after this redesign merges.

**Status**: Superseded in part by ADR-027…031 (2026-10-12, Phase 6): compare,
review, round table and auto now exist, reached through the composer's mode chip
and the command palette's "models" group. Plan/Build agent modes remain deferred
to roadmap Phase 5.

## ADR-020: Multi-model UX on the existing backend; key-prefix detection; renderer-side auto-titles (2026-10-12, UI redesign)

**Decisions**:

1. **Favorites and recents** are additive `AppSettings` fields
   (`favoriteModels`, `recentModels`), defaulted to `[]` in the zod schema,
   so settings written by older builds still parse — the key/value
   `settings` table needs no migration. Scoped by provider config (the same
   model id under two keys is two entries, like the catalog — ADR-015).
   Entries whose provider config was removed are pruned at read time.
   Composer model changes update both `lastModelSelection` and Recent;
   a one-off "[regenerate with…]" updates Recent only, so it never silently
   changes the composer's default.
2. **Provider detection from the key prefix** (`sk-ant-` → Anthropic,
   `AIza` → Google, `sk-proj-`/`sk-` → OpenAI, `sk-ant-` checked first;
   otherwise ask) is a form convenience only — the key is still validated
   by a real connection test to the detected provider before it's saved,
   and storage is unchanged (`safeStorage` in main, ADR-004). The test runs
   automatically once the key looks complete (debounced). First-run
   onboarding saves automatically on a passing test (zero detours);
   Settings shows `connected` and waits for one explicit `save key`.
3. **Auto-titles are derived in the renderer** from the first user message
   (first ~6 words, markdown stripped, ≤60 chars) and persisted through the
   existing conversation-rename IPC — no extra model call, no new backend.
   Only conversations still carrying the default title are renamed, so a
   user's own rename is never overwritten.
4. **A never-fetched model catalog refreshes itself once** (in
   `useModelCatalogs`) so a newly added key's picker isn't empty while
   main's own fire-and-forget post-add refresh is still in flight.
5. **Destructive actions use an inline 3-second confirm** (`[delete]` →
   `[confirm delete]`), not modal dialogs.
6. **Provider errors are shown in plain language** (`describeProviderError`)
   under the failed turn, with `[retry]` and `[switch model]` — never raw
   SDK JSON or a stack.

**Status**: Accepted.

## ADR-021: models.dev as the metadata source — bundled snapshot, disk cache, 24h refresh, user opt-out (2026-10-12, models.dev integration)

**Decision**: Model metadata (context window, price, capabilities, knowledge
cutoff, and exact reasoning-effort values) comes from **models.dev**
(`https://models.dev/api.json`, anomalyco/models.dev, MIT; ~5 MB, 226
providers). It is owned by `ModelsDevService` in the main process
(`apps/desktop/src/main/models-dev-service.ts`, Electron-free and unit tested)
with a strict fallback chain:

1. **Bundled snapshot** (`packages/providers/src/data/models-dev-snapshot.json`,
   424 KB) — the floor. Produced by the committed script
   `scripts/update-models-snapshot.ts` (`pnpm models:snapshot`), which keeps only
   the fields the app reads, only providers the registry can run, only
   non-deprecated text-output models, and caps the long tail (aggregators keep
   their newest 4–40 models; the live catalog is not capped).
2. **Disk cache** (`<userData>/models-dev-cache.json`) — the last successful
   download, reduced the same way. Loaded at startup instead of the snapshot.
3. **Network** — `refreshIfStale()` runs once after the window opens and at most
   every 24 h; `modelsMetadata.refresh()` is the on-demand path (Settings →
   Models → `[refresh now]`). A failed, malformed or implausibly small (< 5
   providers) download never replaces a good catalog.

The app starts and works fully offline from steps 1–2. **The request is a bare
`GET`** — only `Accept: application/json`, no query string, cookies, ids, keys or
usage data (asserted in a test). A new additive setting
`AppSettings.modelsDevFetchEnabled` (default `true`, Settings → Models) turns the
download off entirely: with it off, neither startup nor the on-demand path ever
touches the network.

**Side fix found on the way**: zod 4 re-applies `.default()` values even under
`.partial()`, so `settings:set({ theme })` was silently resetting
`favoriteModels`/`recentModels` (and would have re-enabled the download). The
partial schema is now built from default-free field definitions
(`AppSettingsPartialSchema`) and the IPC handler uses it; covered by tests.

**Why**: One maintained, MIT-licensed database replaces hand-written id
heuristics for ~8,500 models. A snapshot + cache keeps the product local-first
and usable offline; the opt-out is for users who do not want any background
network call.

**Status**: Accepted.

## ADR-022: Data-driven provider registry; bundled AI SDK packages with an OpenAI-compatible fallback (2026-10-12, models.dev integration)

**Decision**: Providers are keyed by their models.dev id and resolved by one rule
(`packages/providers/src/registry.ts`, adapted from OpenCode's provider loader —
see OPEN_SOURCE_INVENTORY.md):

1. models.dev `npm` names an SDK package we ship → that factory (`bundled`);
2. otherwise, if models.dev gives a plain `api` base URL → `@ai-sdk/openai-compatible`
   against it (`openai-compatible`; `includeUsage: true`, `name` = provider id);
3. otherwise → excluded.

Bundled (all Apache-2.0, `npm view <pkg> license` re-checked 2026-10-12; every
one depends on `@ai-sdk/provider` 4.x, the same major as the installed
`ai@7.0.118`, and type-checks and runs against it): `@ai-sdk/anthropic`, `openai`,
`google`, `xai`, `mistral`, `groq`, `deepseek`, `cerebras`, `togetherai`,
`perplexity`, `@openrouter/ai-sdk-provider`, `@ai-sdk/openai-compatible`. models.dev
lists DeepSeek under openai-compatible; a one-entry override routes it to
`@ai-sdk/deepseek` (typed thinking/effort options, `reasoning_content`).
Models carrying a per-model transport override (`provider.npm/api` — e.g. a
gateway fronting Anthropic models) are dropped when the catalog is parsed: the
registry wires one transport per provider, and sending them down the wrong one
would 404.

Also excluded: any `api` containing `${…}` (needs extra account settings:
Cloudflare Workers AI, Databricks, Snowflake…), and explicit non-key providers
(see ADR-025). Local providers (LM Studio's `127.0.0.1` URL) are marked
`isLocal`/keyless. **Ollama** is our own entry (`http://localhost:11434/v1`,
configurable, keyless, detected via `GET /api/tags` with a 1.5 s timeout) and the
**custom endpoint** is a generic OpenAI-compatible entry (base URL + optional
key). `buildProviderRegistry` orders them: Anthropic, OpenAI, Google, xAI, Mistral,
Groq, DeepSeek, OpenRouter, Ollama, then the rest A–Z, custom last.

**Connection test**: cloud providers get a one-token chat request to the cheapest
non-reasoning priced chat model **from models.dev** (`pickProbeModel` — no
hardcoded ids); local/custom endpoints and providers with no priced model are
verified by listing their models (`GET <base>/models`, `/api/tags` for Ollama).
Key-prefix hints (onboarding autodetect) come from the registry
(`keyPrefix`): `sk-ant-`, `sk-or-`, `sk-proj-`, `AIza`, `xai-`, `gsk_`, `pplx-`,
`csk-`. The vendors' own docs show only placeholders, so the xAI/Groq/OpenRouter/
Perplexity/Cerebras prefixes were confirmed from provider-key guides, not
first-party docs; a wrong guess is harmless because every key is still verified by
a real test. Ambiguous prefixes (bare `sk-` = OpenAI **or** DeepSeek, Mistral,
Together) are deliberately absent — the UI asks the user to pick.

**Status**: Accepted.

## ADR-023: Catalog join and per-model reasoning-effort mapping (2026-10-12, models.dev integration)

**Decision**: A provider config's model list is the **join** of what its key can
access with models.dev metadata: the live `GET …/models` ids (cached per config in
`model_catalog`, unchanged) enriched by id (exact, case-insensitive, then with a
date/`-latest` suffix stripped); when no live list exists — not fetched yet, no
list endpoint (Perplexity), or the call failed — models.dev's own non-deprecated
chat list for the provider is shown, so the picker is never empty and never needs
a network round trip. Live ids models.dev knows are not chat models
(embeddings, image generators) are dropped; unknown ids are kept without
metadata. `modelCatalog.list/refresh` keep their IPC shape; entries gain an
optional `meta` and the catalog an optional `source` (`live | metadata | empty`).
The live list is now fetched for Google (`x-goog-api-key`, `generateContent`
models) and every OpenAI-compatible provider (`{data:[…]}` or Together's bare
array); Ollama uses `/api/tags`.

`isReasoningCapableModel` and the low/medium/high enum are gone. `ReasoningEffort`
is the set that appears in models.dev: `none, minimal, low, medium, high, xhigh,
max` (the `default`/`null` sentinels are dropped). A model's
`ModelMetadata.reasoningEfforts` is its models.dev list **intersected with what the
provider SDK can put on the wire** (`reasoning-options.ts`), verified against the
installed SDK option schemas and OpenCode's `transform.ts`:

| SDK | providerOptions key / field | values the SDK can send |
|---|---|---|
| anthropic | `anthropic.effort` (+ `thinking`) | none→`thinking:disabled`, low…max |
| openai | `openai.reasoningEffort` | none…max |
| google | `google.thinkingConfig.thinkingLevel` | minimal…high |
| xai | `xai.reasoningEffort` | none…xhigh |
| mistral | `mistral.reasoningEffort` | none, high |
| groq / cerebras | `groq.` / `cerebras.reasoningEffort` | none…high |
| deepseek | `deepseek.reasoningEffort` + `thinking` | none, low, high, max |
| openrouter | `openrouter.reasoning.effort` | none…xhigh |
| togetherai, openai-compatible | `openaiCompatible.reasoningEffort` | any |
| perplexity | — | nothing |

Anthropic models that also list `budget_tokens` (Opus 4.5/4.6, Sonnet 4.6) get an
explicit `thinking.enabled` budget; effort-only models (4.7+/5.x) get
`thinking.adaptive` — the SDK itself converts a budgeted request to adaptive for
models that reject budgets. Budget-only and toggle-only models (Haiku 4.5, Gemini
2.5) expose **no** effort levels in V1. The main process re-validates the
composer's effort against the model's list before any request (`validateEffort`),
so a stale value is dropped, never sent; the renderer shows exactly the model's
levels and hides the control when there are none. `none` is shown as `off`, and a
separate `default` button means "send nothing".

**Why**: Per-model truth from data instead of regexes ("every Claude except
Haiku", "o-series or gpt-5"), exact values (`xhigh`, `max`, `minimal`) instead of
three invented tiers, and no silent mis-sends: unsupported → nothing is sent or
offered.

**Status**: Accepted (supersedes the heuristic parts of ADR-015/016).

## ADR-024: `ProviderId` is a validated string, not an enum (2026-10-12, models.dev integration)

**Decision**: `ProviderIdSchema` is `^[a-z0-9][a-z0-9._-]*$` (≤ 64 chars) instead of
`z.enum(['anthropic','openai','google'])`; the type is `string`. Every place that
assumed three values became registry-driven (`PROVIDER_LABELS`,
`STATIC_FALLBACK_MODELS`, the key-entry provider list, onboarding blurbs,
`switch (provider)` in the fetcher and factory). **No migration**: `provider_configs.provider`
and `messages.provider` are plain `TEXT` without a `CHECK`, rows written by older
builds (`anthropic`/`openai`/`google`) are valid under the new rule, and keyless
providers store an empty encrypted-key blob. Verified three ways: a unit test
re-runs the migrations over a populated database and compares every row;
`scripts/check-db-copy.ts` opened a **copy** of the real `workspace.sqlite3` (WAL
included) — migrations `[1,2,3,4]` unchanged, 2 provider configs, 2 conversations
and 6 messages all still validate; and the settings keys are additive
(`modelsDevFetchEnabled` is read with a default). `AddProviderConfigInput.apiKey` may
now be empty at the schema level; the add/test handlers enforce `keyRequired`.

**Status**: Accepted.

## ADR-025: Providers deliberately not supported yet — Azure, Bedrock, Vertex, AI Gateway, Copilot (2026-10-12, models.dev integration)

**Decision**: These stay out until the app has a non-API-key credential model:
Azure OpenAI / Azure AI Services (resource name + Azure credentials), Amazon
Bedrock (AWS credentials/region), Google Vertex and Vertex-Anthropic (Google Cloud
credentials), SAP AI Core, watsonx, GitLab, Cloudflare Workers AI / AI Gateway and
Snowflake/Databricks (templated account URLs), and GitHub Copilot (OAuth device
flow). **The Vercel AI Gateway is never mandatory**: `@ai-sdk/gateway` is
installed only transitively by `ai`, no route in the registry uses it, and every
provider is called directly with the user's own key. Excluded providers simply do
not appear in the registry; `resolveProviderRuntime` reports the reason, and a
stored config whose provider later leaves the catalog degrades to its cached
model list instead of failing the picker.

**Status**: Accepted.

## ADR-026: Streamdown and use-stick-to-bottom for the message thread (2026-10-12, models.dev integration)

**Decision**: `react-markdown` + `remark-gfm` are replaced by **Streamdown 2.7.0**
(Apache-2.0, Vercel; "streaming markdown" from the AI Elements ecosystem), and the
hand-rolled scroll-follow effect by **use-stick-to-bottom 1.1.6** (MIT).

*Streamdown without Tailwind*: its default renderers carry Tailwind utility
classes, which are inert here (ADR-018: no Tailwind). Probing the rendered HTML
showed real `h1…`, `p`, `ul/ol/li`, `table`, `blockquote` elements that the existing
nochan `.prose` rules style unchanged (`className="prose"` makes Streamdown's root
the `.prose` element), and four default renderers that swap the semantic tag —
`strong` → `<span>`, links → `<button>` + a link-safety modal, fenced code → its own
widget, inline code → utility classes. Those are overridden in
`components/Markdown.tsx` (`strong`, `a`, `pre` → our `CodeBlock`, `code`), and its
code/table/link controls are turned off. Result: identical visual language,
verified in screenshots. It additionally repairs half-streamed markdown (unclosed
fences/bold) and re-renders only the changing block. Cost: the renderer bundle grew
from 1.26 MB to 1.98 MB (unified/rehype/marked); the streaming cursor is now a CSS
`::after` on the last paragraph/list item.

*Scroll*: the view stays pinned to new text while it streams, stops following the
moment the user scrolls up (a `[↓ latest]` action appears), and a send jumps to the
bottom. Behaviour verified in the real renderer (see BUILD_STATE.md).

**Status**: Accepted.

## ADR-027: Orchestration data model — reply groups on `messages`, one orchestration service (2026-10-12, Phase 6)

**Decision**: Multi-model orchestration (compare / review / round table / auto)
is *one layer* on top of the existing chat pipeline, not a parallel system.

*Storage (migration 0005, additive only)*: new columns on `messages`, all
nullable or defaulted, so every existing row stays valid and behaves exactly as
before — `reply_group_id` (the user message's id; groups the sibling replies to
one turn, including `[regenerate]` siblings), `orchestration_mode`
(`normal|compare|review|roundtable|auto`, default `normal`), `role_label`
(`proposal|critique|alternative|synthesis|review|revision`), `in_context`
(default 1, ADR-028), `auto_reason`, `reply_index` (column / step position),
`round_index`, `input_tokens`, `output_tokens`, `latency_ms`, `est_cost_usd`
(ADR-031) and `error_text` (so a failed column explains itself after a restart).
Phase 2 stored no usage, so the usage/cost columns are new, not reused. No new
table: a "turn" is a user message plus the assistant messages that point at it.
Verified against a copy of the real `workspace.sqlite3`: 6 messages, 2
conversations and 14 catalog rows survive untouched, and the 6 messages parse as
plain in-context `normal` replies (`scripts/check-db-copy.ts`).

*Code*: `ChatService` is split into `persistUserTurn` / `buildProviderMessages` /
`runTurn` (stream one reply and persist it with attribution, usage, latency and
cost). `sendMessage` is the default path rebuilt from those pieces.
`OrchestrationService` (Electron-free, like `ChatService`) composes `runTurn`
into the four modes; `orchestration-prompts.ts` holds the exact text each model
sees (pure, unit-tested). Pure logic the renderer can reuse (limits, cost,
`pickAutoModel`, IPC schemas) lives in `packages/shared/src/orchestration.ts`.

*IPC (additive)*: `chat.compare`, `chat.review`, `chat.applySuggestions`,
`chat.roundTable`, `chat.auto`, `chat.retryReply`, `chat.setInContext`,
`chat.cancelOrchestration`, `chat.onOrchestrationEvent`; `sendMessage` gained an
optional `regenerateOfMessageId`. One method per mode (rather than a single
`orchestrate({mode, …})`) so each input is a precise zod schema (counts 2–4,
rounds ≤ 3, …) and the typed surface says what each call can do. Streaming
follows ADR-008: compare columns each have their own `chat:stream:${requestId}`
channel (the same `delta | done | error` events, plus an additive `start` event
that names the model — Auto picks it in main), so a column is independently
cancellable; review and round table decide their steps server-side, so they use
one `chat:orchestrate:${orchestrationId}` channel carrying step-tagged events.
`cancelOrchestration(id)` stops everything an orchestration is running or about
to run.

*Failure isolation*: `runTurn(..., { isolateFailures })` turns even an
unresolvable provider into an error reply, and compare uses `Promise.allSettled`,
so one failing column never affects the others; the error is stored on the reply
and shown inline with `[retry]` / `[switch model]` (`retryReply` re-runs that
slot and replaces the failed message).

**Status**: Accepted.

## ADR-028: `in_context` — which replies later turns see (2026-10-12, Phase 6)

**Decision**: A message is replayed to a provider only if `in_context = 1`.
After a turn settles, **at most one assistant reply per reply group is in
context**; the others stay persisted and visible but are never sent again.
`[continue with this]` (`chat.setInContext`) moves the single in-context
reply within its group (`MessageRepository.chooseReply`, one transaction;
nothing is deleted).

Defaults: *compare* — the first **complete** column in column order (not finish
order) is in context, i.e. "if you just keep typing, you continue from the first
column", marked with an inverted `IN CONTEXT` chip; *review* — the primary
answer is in context, the review and any revision are not; *round table* — the
synthesis, else the last finished turn; *regenerate* — the new reply replaces
its siblings in the context (only if it produced text); *auto* — the reply.
A failed reply with no text is never in context (an empty assistant turn is
rejected by several providers). History building, the Context Inspector's
history count and Auto's context-size estimate all use the same filter, so the
inspector shows what is actually sent. Rows from before migration 0005 default
to `in_context = 1`, so old conversations replay exactly as before.

**Why not "delete the other columns"**: the user asked to see and keep them;
exclusion is a flag, so switching the chosen reply later is lossless.

**Status**: Accepted.

## ADR-029: Round-table iteration cap — a fixed plan, enforced in the main process (2026-10-12, Phase 6)

**Decision**: A round table is *planned* before anything runs:
`planRoundTable` expands `participants × rounds` (+ an optional synthesis) into
a fixed list of steps and refuses it unless `1 ≤ rounds ≤ 3` (default 1), there
are 2–4 participants, the first turn is a proposal, and the total is at most
`ROUND_TABLE_MAX_CALLS` = 3 × 4 + 1 = 13 provider calls. Nothing is persisted and
no model is called for a refused plan. Steps run strictly sequentially; no model
output can add a step, so there is no model-to-model loop to bound. The cap is
checked in three places — the zod IPC schema, the UI controls, and
`OrchestrationService` itself (a direct call with `rounds: 4` throws
`OrchestrationLimitError`) — and the service is the one that matters.

A failed turn ends the table (later turns would argue with nothing); what
finished stays. One `cancelOrchestration` aborts the running step and every later
one. Each step's prompt is the question plus the transcript so far plus a role
instruction appended to the final user turn (never extra mid-conversation system
messages); later rounds ask the proposer to revise in light of the critique and
the alternative. Roles are fixed to proposal / critique / alternative / synthesis
because the labels are part of the product (outline chips on every turn).

**Status**: Accepted.

## ADR-030: Auto routing — deterministic rules over models.dev metadata (2026-10-12, Phase 6)

**Decision**: `pickAutoModel(input, candidates, prefs) → { choice, reason, rules }`
in `packages/shared` is a pure function; same input, same pick, no ML, no
randomness, no stored state. Rules, in order: (1) only models from a provider
config the user has saved (`hasKey`), never `deprecated` ones; (2) models without
models.dev metadata are used only when nothing rated exists (then: first by
provider/model id, and the reason says so); (3) attachments need input support —
`image/*` → image input (`inputModalities` or the flat `vision` flag), PDF → `pdf`
input; no capable model means *no pick* (the attachment is never silently
dropped); (4) context fit — estimated tokens (chars ÷ 4 of in-context history +
prompt + attachments) plus 4096 reserved for the answer must fit `limit.context`
(unknown window: kept); (5) a *complex* prompt — at least 1200 characters, a
fenced code block, or one of a short keyword list (prove, derive, debug,
refactor, architecture, optimize, step-by-step, trade-offs, algorithm, analyze,
design, investigate, migrate, root cause) — restricts the pool to
reasoning-capable models when any remain; (6) the user's setting
(`AppSettings.autoPreference`, default `balanced`; also overridable per turn)
picks from what is left by list price (input + output USD per 1M tokens):
`cheapest` = lowest price (unpriced last; ties → fast family such as
haiku/flash/mini/nano/lite, then newest), `balanced` = the upper-median price,
`best` = reasoning-capable first, then highest price, then newest. The final
tie-break everywhere is provider id, config id, model id.

The reply stores `orchestration_mode = 'auto'` and `auto_reason`, and shows
`Auto → <model> · reason: needs vision, cheapest capable`. The user overrides with
`[regenerate with…]` or by leaving Auto. If no model qualifies the call fails with
the reason instead of falling back. "Best" by price is a stated proxy for
capability — models.dev has no quality score — and is documented as such.

**Status**: Accepted.

## ADR-031: Cost estimation — models.dev price × provider-reported usage, labelled "est." (2026-10-12, Phase 6)

**Decision**: `estimateCostUsd(cost, usage) = (input × cost.input + output ×
cost.output) / 1 000 000`, computed in the main process when a reply is persisted
and stored in `est_cost_usd`. It is `null` — shown as `—`, never a made-up number —
when the model has no known price or the provider reported no (or only partial)
usage. Usage comes from the AI SDK's final `finish` part (`totalUsage`), carried on
the provider `done` event; a provider that reports nothing yields no usage at all
(not zeros). The UI always labels the figure "est." (cache read/write discounts are
not applied because the stream reports totals only; community-sourced prices can be
stale — ADR-021). A compare header sums the known estimates and marks a partial sum
with `+`. Latency is wall-clock from request to the last token.

**Status**: Accepted.

## ADR-032: Orchestration UI — progressive disclosure through one mode chip (2026-10-12, Phase 6)

**Decision**: NORMAL stays the clean default; there are no permanent compare/review
buttons. The composer footer gets one small mode chip (`chat ▾`, inverted when the
mode is not `chat`) beside the model chip; picking a mode reveals only that mode's
controls in a ruled row above the footer (compare: 2–4 model slots; review: the
reviewer; round table: ordered turns with a role each, an optional synthesizer and a
1–3 rounds stepper; auto: cheapest / balanced / best). The same modes are reachable
from the command palette's "models" group ("Compare models…", "Review with…", "Round
table…", "Auto-pick model") and Ctrl+Shift+M opens the menu; arrows, Enter and Esc
work. In compare / round table / auto the single-model chip is dimmed (it is unused);
in review it is the answering model. Modes are sticky for the session (the chip stays
inverted so a multi-model send is never a surprise) and reset to `chat` in a new window.

Layout decisions made by screenshot: (1) the compare block breaks out of the 72ch
reading column (up to 1600 px, centred on the scroll area) because three readable
columns need ~800 px; (2) each column scrolls independently (`max-height: min(54vh,
600px)`); (3) when the scroll area cannot give N columns 260 px each (a 1280 px window
with the context panel open) the columns **stack** instead of hiding behind a
horizontal scrollbar — a column nobody can see (here the failed one) is worse than a
longer page; (4) the chosen column has a 2 px ink top rule and an inverted `IN CONTEXT`
chip, the others are dimmed to 72 % and light up on hover; (5) review is the answer
followed by a left-ruled block labelled `REVIEW` with the note "the answer above is
unchanged", and `[apply suggestions]` adds a separate `REVISED` block; (6) role labels
are nochan uppercase outline chips and `IN CONTEXT` is the only inverted chip in a
reply, so mixed-model threads stay legible.

**Status**: Accepted.

## ADR-033: Monaco, lazily loaded and slimmed — worker, CSP, theme, minification (2026-10-12, Phase 4)

**Context**: ADR-001/005 settled "use Monaco, do not build an editor". Open
questions were how it ships in an Electron renderer whose CSP is `'self'`, what to
leave out, and how it stays on-brand.

**Decision**:

- **Lazy**. `lib/monaco/loader.ts` reaches Monaco only through a dynamic `import()`;
  `CodeEditor`, `DiffViewer` and `TerminalView` are `React.lazy` too. Chat startup
  loads the 1.0 MB main chunk; Monaco (3.2 MB, own chunk + 118 KB CSS + 153 KB codicon
  font + a 275 KB worker) and xterm (332 KB) are fetched on first use.
- **Slim build, not `editor.main`**. 0.57's `editor.main` pulls in the TypeScript/CSS/
  HTML/JSON language *services* — multi-megabyte workers that would put project-less
  "cannot find module" diagnostics into a workspace app. `monaco-setup.ts` takes
  `editor.api`, the editing features (find, folding, multi-cursor, clipboard, comment,
  indentation, goto line, diff editor, …), lazy Monarch tokenizers for the bundled
  languages (each its own few-KB chunk) and the base editor worker. Hover, suggest,
  rename and code actions are left out. JSON has no Monarch definition upstream, so a
  20-line tokenizer is registered. Trade-off: syntax colours only — no IntelliSense.
- **One worker kind** (`editor.worker`, imported with Vite's `?worker`). It is emitted
  as a normal asset and loads under the existing CSP **with no change**: the production
  build under `file://` was exercised (diff editor included) and `worker-src` falls back
  to `script-src 'self'`. **No CSP directive was added or loosened in this phase**; had a
  `blob:` worker been needed, the change would be `worker-src 'self' blob:` and would be
  recorded here. (`style-src` already allows `'unsafe-inline'`, which Monaco's runtime
  styles use; the codicon font and xterm CSS are `'self'` assets.)
- **Theme from the tokens**. `lib/monaco/theme.ts` builds the Monaco theme (and
  `buildXtermTheme` the terminal palette) from the live `--paper/--ink/--link/--ok/
  --signal/--code-*` custom properties, re-applied when `data-theme` or the OS scheme
  changes. Syntax: comments `--muted`, strings `--ok`, numbers `--code-changed`,
  keywords `--link`, types/functions `--code-function`. Diff insert/remove backgrounds are
  `--ok`/`--signal` at low alpha. xterm: body `--sunken`, text `--ink`, red/green/
  yellow/blue = signal/ok/code-changed/link, magenta/cyan are blends of those.
- **Renderer is minified.** electron-vite defaults `build.minify: false`; with Monaco in
  the tree that is ~6 MB of unminified JS. `renderer.build.minify: 'esbuild'` takes the
  main chunk from 1.98 MB to 1.0 MB.

**Consequences**: the editor ships ~3.6 MB of lazily loaded code. A future need for
language intelligence (Phase 5/7: LSP, MCP) is a separate decision; the structure leaves
room (`monaco-setup.ts` is the single assembly point). `monaco-editor` bundles the
codicon icon font, which upstream (`@vscode/codicons`) licenses CC-BY-4.0, not MIT —
recorded in OPEN_SOURCE_INVENTORY.md. The owner approved keeping it with attribution
(2026-10-12); the attribution must ship in the release's third-party notices.

**Status**: Accepted.

## ADR-034: File tree, quick open, text search — lazy, filtered in main, bounded scan (2026-10-12, Phase 4)

**Decision**: The renderer never holds the repository. `fs.listDir` returns one level
at a time (the root and folders the user expanded), already filtered by the
indexer's exclusions: `buildIgnoreFilter` (built-in deny-list + the root `.gitignore`) is
**exported from `workspace-file-indexer.ts` and reused**, not re-implemented. To make the
deny-list usable as a *security* boundary the single array was split in
`@ai-workspace/shared` into `SENSITIVE_DENY_PATTERNS` (`.git/`, `.env*`, keys,
credentials) and `NOISE_EXCLUDE_PATTERNS` (`node_modules/`, `dist/`, binaries…);
`DEFAULT_DENY_PATTERNS` is still their concatenation, so the indexer is unchanged. The
tree hides both; reads/writes refuse only the sensitive set (a tracked file under
`build/` that shows up in `git status` must stay openable).

- **Quick open** (Ctrl+P) asks the main process for the current visible path list
  (`fs.listPaths`, ≤ 20 000 paths, a fresh walk — never stale like the index) and ranks it
  in the renderer with the existing normalized-substring matcher extended to multi-token
  AND and name-before-directory ordering. It is not a fuzzy matcher.
- **Text search** is a *bounded scan* (`fs.searchText`): ≤ 5000 files, ≤ 1 MB per file,
  ≤ 64 MB total, 5 s, ≤ 300 results, async, skipping binaries / invalid UTF-8 / secrets.
  The FTS5 index was evaluated and **not used** for this view: it returns one snippet per
  file with no line numbers, tokenizes on word boundaries (so `useSta` finds nothing), and
  is only as fresh as the last reindex — wrong properties for "jump to the line". FTS5
  still serves chat retrieval unchanged.

**Status**: Accepted.

## ADR-035: Path-safety model for repository files (2026-10-12, Phase 4)

**Decision**: Every file operation takes `(workspaceId, relativePath)`; the renderer
never sends an absolute path. `main/code/path-safety.ts` is the one gate:

1. Reject, before touching the disk: non-strings, NUL bytes, absolute paths (POSIX `/x`,
   `\x`, drive `C:`, UNC `\\s\h`), any `..` segment, `:` (NTFS alternate data streams) and
   segments ending in `.` or a space (Windows strips them, so `.git.` would dodge the
   deny-list).
2. Resolve with the OS `realpath` (follows symlinks, junctions and expands Windows 8.3
   short names). For a file that doesn't exist yet the deepest existing ancestor is
   resolved, so a link can't smuggle a *new* file out. The result must stay inside
   `realpath(root)` (`path.relative` containment, case-insensitive on Windows).
3. Apply the sensitive deny-list to the requested spelling **and** the resolved
   location (a link or `GIT~1` into `.git/` is refused). Reads of a denied file return a
   `denied` state with no content; writes and listings throw.
4. Writes: UTF-8 only, ≤ 5 MB, atomic (temp file beside the target, `fsync`, `rename`),
   guarded by the SHA-256 of the bytes the edit started from — a mismatch returns
   `conflict` (`changed` / `deleted` / `exists`) and the file is untouched until the
   user picks "overwrite" in the inline strip. Files that aren't valid UTF-8 are shown as
   "not text" rather than opened lossily, so a save can never corrupt a Latin-1 file; the
   BOM is kept. Opening: ≤ 1 MB editable, ≤ 5 MB read-only, larger or binary → "reveal in
   folder" (`shell.showItemInFolder`, which never executes).

**Known residual risk**: TOCTOU — a link swapped in between check and use. Node has no
`openat`-style API; exploiting it needs write access to the repository, which already
allows editing the files directly. Tests cover absolute, `..`, symlink/junction escape
(a real file symlink where the OS permits, skipped with a note otherwise), 8.3 names,
deny-list, size/binary/encoding, atomic write and the stale-write conflict.

**Status**: Accepted.

## ADR-036: Git through the system `git` with argument arrays, no library (2026-10-12, Phase 4)

**Decision**: `GitService` runs the user's `git` via `child_process.execFile('git',
[...fixed global args, ...args], { shell: false })`; no string is ever built into a
command line. `simple-git` was considered and rejected: this feature needs ~10
subcommands whose exact flags and environment matter for safety, and a thin wrapper
keeps those visible and testable (`buildGitInvocation`) without a dependency.

- **Fixed global args**: `-c core.fsmonitor=false` (a repo's config can name a program
  there; reads must not run it), `-c color.ui=false`, `--literal-pathspecs` (a file called
  `*.ts` or `[x].txt` is that file), `--no-pager`; env `GIT_TERMINAL_PROMPT=0`,
  `GIT_EDITOR=true`, and `GIT_OPTIONAL_LOCKS=0` + `LC_ALL=C` for inspection calls.
- **Only these subcommands exist**: `rev-parse`, `status --porcelain=v2 -z`,
  `diff --numstat -z [--cached]` (counts only — `--no-ext-diff --no-textconv`), `log -1`,
  `show` (blob contents), `add`, `restore --staged` (`rm --cached` on a repository with no
  commits), `commit -m`. There is **no push, pull, fetch, reset, clean, checkout, rebase,
  stash or force**; a unit test enumerates every call the service makes and asserts the set.
- **Diffs are computed by Monaco from two texts**: the main process returns both sides
  (`HEAD:./path`, `:./path`, working tree), so no unified-diff text is parsed.
- **Paths** are validated (no absolute, `..`, `.git`), passed after `--`, staged in chunks
  of 100. "Stage all" skips files matching the secrets deny-list (so an untracked, un-ignored
  `.env` is never swept in); staging one explicitly is allowed (a user decision) but its
  content is never displayed.
- **Hooks**: `git commit` runs the repository's own hooks like any commit would; that is the
  user's repository and the user's click. A missing `git` is a `git-missing` state, a
  non-repository a `not-a-repo` state ("initialize" is deliberately not offered).

**Status**: Accepted.

## ADR-037: Terminals — `@lydell/node-pty`, explicit start, lifecycle, bottom panel (2026-10-12, Phase 4)

**Decision**: PTY package **`@lydell/node-pty`** (MIT; a smaller distribution of
`microsoft/node-pty` that ships per-platform *prebuilt* binaries as optional dependencies —
OpenCode's desktop uses it). On this machine (Windows 11 x64, Electron 44) it needed no
toolchain and no `@electron/rebuild` entry, `allowBuilds` stays as it was, and it loads
inside the packaged-style build: electron-vite externalizes it (a `dependency`), the `.node`
resolves from `node_modules`, and it is `import()`ed lazily so a missing/broken binary
becomes a readable terminal error rather than an app-start crash. `node-pty` proper would
have required a native build per Electron ABI. (Not exercised: macOS/Linux binaries; a
packaged installer needs the platform package unpacked from the asar — not built yet.)

- **Explicit start only.** `terminal.create` is the single entry point and is reachable
  only from the UI: `[+ new terminal]`, the first Ctrl+\` / `/terminal` (which opens the
  panel and starts one shell if none exists), or the palette entry. Opening the app, restoring
  a layout or switching workspace never spawns a process (an E2E test asserts zero terminals
  after relaunch). **No IPC exists that writes to a terminal on a model's behalf**; the only
  `write` is keystrokes from xterm. Phase 5's agent/permission engine must add any such path
  through explicit approval.
- **Shell detection** (`shell-detect.ts`, no process is run): Windows `pwsh.exe` on PATH →
  Windows PowerShell → `%ComSpec%`; macOS/Linux `$SHELL` → bash → sh (macOS as a login shell).
  The environment drops `ELECTRON_*`/`NODE_OPTIONS`; `TERM=xterm-256color`.
- **Lifecycle**: `cwd` = the workspace root; max 8 terminals; output coalesced in 8 ms
  batches and a 200 KB scrollback is kept in main so a reloaded renderer can repaint;
  resize = `@xterm/addon-fit` → `terminal.resize`; closing a tab kills the process; a process
  that ends keeps its tab with `exit N` and `[restart]`/`[close]`. Switching workspace keeps
  shells alive (each is tagged with its workspace); **`before-quit` and `will-quit` kill all**
  — verified: after quitting, the real shell's pid is gone.
- **UI**: a bottom panel (`TERMINAL | OUTPUT`, resizable) shown on any page, toggled by
  Ctrl+\` and `/terminal` (which is lit while the panel is open, not a page). Output is a
  bounded log of saves, git actions and terminal starts. A "Problems" tab was omitted (no
  language service feeds it). xterm leaves Ctrl+\` and Ctrl+Shift+P to the app.

**Status**: Accepted.

## ADR-038: "Add to chat context" from the editor reuses pending attachments (2026-10-12, Phase 4)

**Decision**: `[+ file to chat]` and `[+ selection to chat]` in the editor status bar hand
the chat a `PendingAttachment` (filename `path` or `path:12-30`, the editor's *current*
text) through one new signal into `ChatPanel`, which appends it to the existing
`pendingAttachments` — so it shows up in the Context Inspector with its own toggle and
token estimate and is sent by the existing `ContextSelection` path. `ContextService`
and the schemas are untouched. A whole file over the 512 KB attachment cap falls back to the
existing `addToContextSignal` (workspace file by path). Reason for attachments over
workspace-file paths: the index may be stale or may not contain a new file, and the
user expects "what I'm looking at, including unsaved edits".

**Status**: Accepted.

## ADR-039: Attached context goes in the user turn; system prompts go in `instructions` (2026-10-12, supersedes the injection mechanism of ADR-013)

**Context**: A user reported that sending a message with any attachment failed with
"Invalid prompt: System messages are not allowed in the prompt or messages fields. Use the
instructions option instead." `ai@7` rejects *any* `system` message inside `messages`, before a
request is sent, for every provider. ChatService injected the Context Inspector block as a
`system` message right before the user turn (ADR-013), and the review pipeline sent its prompt
as a leading `system` message — so attachments, selected files, retrieval snippets, and
review/round-table runs all failed against real providers. Tests missed it because the
integration tests use mock providers that never run the SDK's prompt validation.

**Decision**:
1. `streamWithModel` (the only `streamText` call site) lifts every `system` message into the
   SDK's `instructions` option, in order; `messages` carries only user/assistant turns. Only
   our own trusted prompts may be sent as `system`.
2. The context block is prepended to the current **user** turn, wrapped in
   `<attached_context>…</attached_context>` with one `<file kind name>` element per source and a
   note that the block is data, not instructions. Attached file content is untrusted, so it must
   not be promoted to system/instruction authority (prompt-injection hardening). Literal
   `<attached_context` / `<file` / closing tags inside file content are neutralized so a file
   cannot close the block and pose as the user; file names are attribute-escaped.
3. A wire-format test drives Anthropic and OpenAI through the real SDK with a stubbed `fetch`
   (system prompt + history + current turn) and asserts the request is actually sent — it fails
   with the reported error on the old code.

**Status**: Accepted.
