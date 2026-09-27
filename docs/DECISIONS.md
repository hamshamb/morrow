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
