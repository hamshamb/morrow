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
