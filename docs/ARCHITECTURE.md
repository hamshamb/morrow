# Architecture

## Product concept

One workspace. Any model. Any tool. Shared context.

The **Workspace** is the primary object, not the AI provider. A workspace owns
conversations, files, repository state, instructions, memory, indexed context,
terminal sessions, Git state, MCP connections, agents, and provider/model
preferences. Every supported model operates on the same shared workspace.

## Stack

- Electron (main + preload + renderer)
- React 19 + TypeScript (strict) + Vite, via `electron-vite`
- SQLite (`better-sqlite3`) for application state, with migrations
- Vercel AI SDK (`ai` + `@ai-sdk/*`) as the provider abstraction layer
- Monaco Editor for code editing
- xterm.js + node-pty for integrated terminals
- Official MCP TypeScript SDK for tool/resource integration
- Zod for schema validation at process/IPC/provider boundaries

Electron+React+TS was chosen over Tauri because the AI/coding tool ecosystem
(Vercel AI SDK, MCP SDK, Monaco, xterm) is predominantly TypeScript/Node-first,
which maximizes safe reuse and minimizes native-bridge work for V1. See
[DECISIONS.md](./DECISIONS.md).

## Monorepo layout

```
apps/
  desktop/              Electron app shell (main, preload, renderer)
packages/
  shared/                Cross-cutting types & zod schemas
  storage/                SQLite schema, migrations, repositories
  ai-core/                Provider-independent chat/model abstraction
  providers/              Thin adapters over @ai-sdk/* per provider
  tools/                  Provider-independent tool layer (fs, git, terminal, mcp)
  mcp/                    MCP client manager
  git/                    Git status/diff/log wrapper
docs/
```

Package boundaries are kept coarse on purpose (avoid micro-package
fragmentation). New packages are added only when a boundary is genuinely
useful for reuse or isolation.

## Process boundaries

- **Main process**: owns SQLite, filesystem access, terminal (PTY), Git,
  provider network calls, MCP server connections, secret storage
  (`Electron safeStorage`). Nothing here is reachable directly from the
  renderer.
- **Preload**: a narrow, typed `contextBridge` API. No Node/Electron APIs are
  exposed wholesale to the renderer (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true` where practical).
- **Renderer**: React UI. Talks to the main process only through the typed
  IPC surface defined in `packages/shared`. Never touches the filesystem, a
  provider API key, or a shell directly.

## Data model (high level)

`Workspace 1—N Conversation 1—N Message 1—N MessagePart`, plus
`WorkspaceMemory`, `Attachment`, `UsageRecord`, `Agent`, `ToolRun`,
`McpServerConfig`, `WorkspaceFileIndex`, `Settings`. See
`packages/storage/src/migrations` for the authoritative schema — this doc
gives shape, migrations give truth.

A conversation is provider-agnostic: each `Message` records which
provider/model produced it, so a single thread can move
Claude → Claude → OpenAI → Gemini without branching.

## Orchestration layer (Phase 6)

One layer over the existing chat pipeline — see ADR-027…032.

```
renderer  ComposerModes (mode chip + that mode's controls) ── useChat ──┐
          CompareView / ReviewGroup / RoundTableView / MessageList      │ typed IPC (RendererApi.chat.*)
main      ipc/chat.ts  (zod-validates every input)                      ▼
          OrchestrationService ── compare | review | applySuggestions | roundTable | auto | retryReply
              │  composes
              ▼
          ChatService  persistUserTurn → buildProviderMessages (in_context filter) → runTurn
              │                                                   └─ stream → persist reply + usage,
              ▼                                                      latency, est. cost
          ChatProvider (packages/providers, models.dev metadata)    MessageRepository (SQLite, migration 0005)
shared    orchestration.ts: limits, input/event schemas, estimateCostUsd, pickAutoModel (pure)
```

- A **turn** is a user message plus the assistant replies whose `reply_group_id`
  points at it. `orchestration_mode` and `role_label` say how a reply was made;
  `in_context` says whether later turns see it (at most one reply per group once the
  turn settles). Everything is additive: a pre-orchestration conversation is a set of
  `normal`, in-context replies with no group.
- **Compare** runs N `runTurn`s in parallel, each on its own `chat:stream:${requestId}`
  channel and abort controller. **Review / round table** are sequential pipelines whose
  steps are fixed (and capped) before the first model call, streamed on one
  `chat:orchestrate:${orchestrationId}` channel. **Auto** picks a model with a pure,
  deterministic function over models.dev metadata, then runs the normal path.
- All limits (2–4 compare models, ≤ 3 round-table rounds, ≤ 13 calls per table) are
  enforced in `OrchestrationService`, not just in the zod schema or the UI.
- The renderer builds its thread from the flat message list (`lib/reply-groups.ts`);
  live (streaming) and stored replies render through the same view model
  (`lib/orchestration-ui.ts`).

## Security model

- Provider API keys are never written to SQLite, JSON, logs, or workspace
  files in plaintext. They are encrypted at rest via Electron's
  `safeStorage` (OS keychain/DPAPI/libsecret-backed) and only decrypted
  in-memory in the main process for the duration of a request.
- Every tool call carries a risk classification (`safe | write | execution |
network | destructive`) and a permission requirement
  (`ask | session | workspace | deny`), enforced in the main process before
  the tool runs — never trusted from renderer or provider input.
- Terminal commands and file writes proposed by an agent require explicit
  user approval by default; nothing destructive runs automatically.
- Document ingestion and repository indexing respect `.gitignore` plus a
  built-in deny-list (`.env*`, credentials, private keys, `.git/`,
  `node_modules/`, build output, binaries).

## Phased delivery

Tracked in [BUILD_STATE.md](./BUILD_STATE.md). Reuse and license decisions
are tracked in [OPEN_SOURCE_INVENTORY.md](./OPEN_SOURCE_INVENTORY.md) and
[DECISIONS.md](./DECISIONS.md).
