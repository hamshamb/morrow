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
- xterm.js + `@lydell/node-pty` (prebuilt node-pty) for integrated terminals; system `git` via `execFile` (no git library)
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

## Code workspace (Phase 4)

The workspace's folder (`workspace_file_roots`, chosen with the native dialog) becomes a
repository you can open, edit, run commands in and commit from — an AI workspace with
coding tools, not an IDE. ADR-033…038.

```
renderer  TopBar (/chat /code /terminal /git)     WorkspaceView  (single owner of the hooks below)
          CodeView ── FileTree · EditorTabs · SearchPanel · CodeEditor (Monaco, lazy)
          GitView  ── change groups · commit box · DiffViewer (Monaco diff, lazy)
          BottomPanel ── TerminalView (xterm.js, lazy) · Output log
          hooks: useCodeWorkspace · useGitStatus · useTerminals · useOutputLog
                 │ typed IPC  RendererApi.fs.* / .git.* / .terminal.*   (zod-validated in ipc/code.ts)
main      CodeFileService ── path-safety.ts (relative path in; realpath containment; deny-list)
          GitService ── execFile('git', [argv…]), parse-only helpers (git-parse.ts)
          TerminalManager ── pty-native.ts (lazy @lydell/node-pty) · shell-detect.ts
shared    code.ts: limits + zod schemas for every payload; SENSITIVE/NOISE pattern split
```

- **The renderer never sees an absolute path or a whole repository.** It asks for one
  directory level, one file, one diff, one search; the main process owns all filesystem,
  git and PTY access (ADR-035/036/037).
- **Editing**: Monaco keeps one model per open file (so undo survives tab switches) and is
  the source of truth for text while editing; `useCodeWorkspace` holds tab and per-file
  state and reads text back through an imperative `EditorApi` only on save. Dirty = the
  model's alternative version id differs from the saved baseline. Saves are atomic and
  hash-guarded; a file changed on disk is flagged on window focus and asks before it is
  overwritten. Open tabs persist per workspace in the settings table (`codeSessions`,
  additive, defaulted) and come back after a restart; only the active one is read at once.
- **Changes view**: status = `status --porcelain=v2 -z` + two `diff --numstat -z`
  + `log -1`; a file appears under Staged and Unstaged when both apply. The diff editor is
  fed two plain texts from main. It polls every 4 s while visible, on window focus and after
  every action.
- **Shared context** (the product's differentiator): `[+ file to chat]` /
  `[+ selection to chat]` add the editor's current text as a pending attachment in the
  existing Context Inspector (ADR-038) — no new context plumbing.
- **Pages vs panel**: `/chat`, `/code`, `/git` are pages (mounted lazily, kept mounted, so
  chat drafts and editor state survive); `/terminal` toggles the bottom panel.

## Security model

- **Repository files** (Phase 4): relative paths only; absolute, `..`, NUL, `:` and
  Windows-stripped names are rejected; symlinks/junctions/8.3 names are resolved and must
  stay inside the root; `.env*`, keys, credentials and `.git/` are refused on the requested
  and the resolved path; writes are atomic, size-capped and hash-guarded; text is UTF-8 only.
  Residual: a TOCTOU swap between check and use (needs repository write access). Tests:
  `path-safety.test.ts`, `code-file-service.test.ts`.
- **Terminals** (Phase 4): a PTY starts only from a user action; there is no AI → terminal
  path; every shell is killed on app quit; shells inherit the app environment minus
  `ELECTRON_*`/`NODE_OPTIONS`. A terminal is a full shell as the user — the trust boundary
  is "the user typed it", not a sandbox. Phase 5 must put any agent-proposed command behind
  the permission engine.
- **Git** (Phase 4): `execFile` with an argument array, `shell: false`, fixed read/stage/commit
  subcommand set (a test enumerates it), `core.fsmonitor=false` so a repository cannot run a
  program on a refresh; `commit` runs the repository's own hooks — same as the user running
  `git commit`. Secrets are never displayed or bulk-staged.
- **Renderer CSP**: unchanged in Phase 4 (`default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline'; img-src 'self' data:`); Monaco's worker is a `'self'` asset.
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
