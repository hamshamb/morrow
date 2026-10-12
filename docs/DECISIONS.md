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

**Status**: Accepted.

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

**Status**: Accepted.

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

**Status**: Accepted.

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
