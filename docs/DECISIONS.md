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
