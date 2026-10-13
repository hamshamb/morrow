# Morrow

Morrow is a local-first desktop workspace for working with AI models, code, files, terminals, Git, and agents in one place.

It is built for people who want to choose their own model provider while keeping workspace state, credentials, and coding tools on their own machine.

## Highlights

- Connect supported cloud providers, Ollama, or a compatible custom endpoint.
- Keep conversations, workspace files, model preferences, and local state together.
- Compare model responses, run reviews, hold round tables, or let Morrow pick a model automatically.
- Browse and edit a repository with Monaco, inspect Git changes, and run integrated terminals.
- Use Plan and Build agents with main-process permissions, audit trails, command limits, and per-file revert support.
- Store provider credentials with Electron safeStorage instead of plaintext project files.

## Technology

- Electron, React, TypeScript, and Vite
- SQLite with better-sqlite3
- Vercel AI SDK provider adapters
- Monaco Editor and xterm.js
- Zod validation across IPC and provider boundaries

## Requirements

- Node.js 20 or newer
- pnpm 11
- Windows for the current installer release

## Run from source

```bash
pnpm install
pnpm dev
```

The first launch guides you through connecting a provider or local endpoint. API keys remain in the operating system credential store and are never committed to the repository.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm package:win
```

`pnpm package:win` produces an NSIS installer in `release`.

## Security model

Morrow keeps filesystem, Git, terminal, network, and secret access in Electron's main process. The renderer communicates through a narrow validated IPC API.

Agent tools are permission-gated. Commands, writes, network access, and destructive actions are classified before execution. Every tool call is recorded and file changes can be reverted when Morrow has captured a snapshot.

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/DECISIONS.md](docs/DECISIONS.md) for the detailed tradeoffs.

## Beta status

Morrow is in beta. The core chat, code workspace, orchestration, and agent capabilities are implemented, but installer signing, automated update delivery, and broader release testing are still planned work.

## License

Morrow's original source code is available under the [MIT License](LICENSE). Third-party components retain their own licenses and attributions, documented in [docs/OPEN_SOURCE_INVENTORY.md](docs/OPEN_SOURCE_INVENTORY.md).

## Contributor

Created and maintained by [hamshamb](https://github.com/hamshamb).
