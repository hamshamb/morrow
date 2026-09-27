# Open Source Inventory

Tracks every external project whose **code** is incorporated, adapted, or
depended on beyond an ordinary npm install of an unmodified package. Studying
an architecture (e.g. Cline's agent loop shape) without copying its code is
not logged here — only actual reuse/adaptation of code or substantial
config/schema is.

Ordinary, unmodified npm dependencies (Electron, React, Vite, TypeScript,
Vercel AI SDK, better-sqlite3, Monaco, xterm.js, node-pty, MCP SDK, zod,
electron-builder, electron-vite, simple-git) are declared in each
`package.json` with their upstream license (all MIT or Apache-2.0, verified
2026-09-27 via `npm view <pkg> license`) and are not duplicated here unless
their code is copied/adapted rather than imported as a package.

Phase 2 additions, verified 2026-09-27 via `npm view <pkg> license` (all
ordinary, unmodified npm dependencies — no code copied/adapted):

| Package             | Version  | License    | Reason                                                    |
| ------------------- | -------- | ---------- | ---------------------------------------------------------- |
| `ai`                | 7.0.118  | Apache-2.0 | Provider-independent streaming/tool-calling core (ADR-003) |
| `@ai-sdk/anthropic`  | 4.0.65   | Apache-2.0 | Anthropic adapter for `ai`                                  |
| `@ai-sdk/openai`     | 4.0.78   | Apache-2.0 | OpenAI adapter for `ai`                                     |
| `@ai-sdk/google`     | 4.0.82   | Apache-2.0 | Google (Gemini) adapter for `ai`                            |
| `react-markdown`     | 10.1.0   | MIT        | Chat message markdown rendering                             |
| `remark-gfm`         | 4.0.1    | MIT        | GitHub-flavored markdown (tables, strikethrough) in chat    |

Phase 3 additions, verified 2026-09-27 via `npm view <pkg> license` (ordinary,
unmodified npm dependencies — no code copied/adapted):

| Package  | Version | License | Reason                                                                  |
| -------- | ------- | ------- | ------------------------------------------------------------------------ |
| `ignore` | 7.0.10  | MIT     | `.gitignore`-semantics parser for workspace file indexing exclusion (ADR-011) |

PDF text extraction was considered for the file-attachment/indexing feature
but skipped for V1 — no well-maintained MIT/Apache-2.0/BSD-licensed
extractor was evaluated and adopted in the time available; see
BUILD_STATE.md "Known limitations". No embeddings/vector-search library was
added either — FTS5 (bundled in `better-sqlite3`, already declared above) is
the V1 lexical-retrieval baseline (ADR-010), not a new dependency.

| Project                                             | Repository | Version/commit | License | Files/components reused | Modifications | Required attribution | Reason for reuse |
| --------------------------------------------------- | ---------- | -------------- | ------- | ----------------------- | ------------- | -------------------- | ---------------- |
| _(none yet — no code copied/adapted as of Phase 0)_ |            |                |         |                         |               |                      |                  |

## Studied for architecture only (no code copied)

- **Vercel AI SDK** — provider abstraction, streaming, tool-calling shape.
  Used as a direct dependency (see table above rule — not "adapted code"),
  not studied-only; listed here for cross-reference.
- **AnythingLLM** (core, MIT) — workspace/RAG/document-ingestion patterns.
  No code copied yet. If a specific module is adapted in a later phase
  (e.g. chunking strategy), it will be added to the table above with
  license/attribution before merge.
- **Cline** (Apache-2.0) — coding-agent loop shape (plan → tool call →
  observe → diff → finish), permission/approval UX. No code copied; our
  agent loop and permission engine are original implementations informed by
  the pattern.

## Policy

- MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause: preferred, usable freely
  with attribution as required by the license.
- MPL: acceptable only after explicit review, logged here before merge.
- GPL / AGPL / SSPL / BSL / source-available non-compete / branding-restricted
  / commercial-use-restricted / custom licenses preventing derivative
  products: not used without explicit user approval, logged here if ever
  approved.
- Being public on GitHub does not imply permission to copy code.
