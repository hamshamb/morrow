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

UI redesign additions, verified 2026-10-12 via `npm view <pkg> license`:

| Package                    | Version | License   | Reason                                                                                   |
| -------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------- |
| `@fontsource/ibm-plex-mono` | 5.3.0   | OFL-1.1   | **Font.** IBM Plex Mono, bundled locally for all UI chrome (nochan visual language, ADR-018). SIL Open Font License 1.1 permits bundling/redistributing the font with software (it may not be sold on its own); explicitly approved for this use. Only the latin 400/500/600 files are imported (`main.tsx`); unmodified. |

PDF text extraction was considered for the file-attachment/indexing feature
but skipped for V1 — no well-maintained MIT/Apache-2.0/BSD-licensed
extractor was evaluated and adopted in the time available; see
BUILD_STATE.md "Known limitations". No embeddings/vector-search library was
added either — FTS5 (bundled in `better-sqlite3`, already declared above) is
the V1 lexical-retrieval baseline (ADR-010), not a new dependency.

| Project                                             | Repository | Version/commit | License | Files/components reused | Modifications | Required attribution | Reason for reuse |
| --------------------------------------------------- | ---------- | -------------- | ------- | ----------------------- | ------------- | -------------------- | ---------------- |
| opencode (UI redesign — resize handle) | `anomalyco/opencode`, `dev` branch | fetched 2026-09-27 | MIT | Drag-to-resize algorithm (`packages/ui/src/components/resize-handle.tsx`) and hit-target/hover CSS (`resize-handle.css`) | Solid props/signals ported to a React hook (`apps/desktop/src/renderer/src/hooks/useResizablePanel.ts`) + component (`components/shell/ResizeHandle.tsx`); CSS class renamed to `.resize-handle` in this project's stylesheet | Source comment at the top of both files + MIT notice in this file | Small, zero-dependency, framework-agnostic drag math — safe near-direct port per the research doc |
| opencode (UI redesign — command-palette search match) | `anomalyco/opencode`, `dev` branch | fetched 2026-09-27 | MIT | `normalizeModelSearch`/`compactModelSearch`/`matchesModelSearch` (`packages/app/src/components/dialog-select-model-search.ts`, 18 lines, full file) | Renamed and ported to `apps/desktop/src/renderer/src/lib/search-match.ts`; logic otherwise unchanged | Source comment at the top of `search-match.ts` + MIT notice in this file | Trivial, framework-free pure functions — safe near-verbatim port per the research doc |
| opencode (UI redesign — command palette geometry) | `anomalyco/opencode`, `dev` branch | fetched 2026-09-27 | MIT | Dialog sizing/anchoring values (`dialog-command-palette-v2.css`): 640px max width, 36px rows, top-anchored positioning (the 12px radius was dropped — nochan is square) | Re-expressed with this project's own class names (`.command-palette*`) and nochan token variables | Source comment at the top of the `.command-palette` CSS block + MIT notice in this file | Concrete, copyable numeric values with no Solid dependency |

Removed during the redesign (no longer in the code, so no longer claimed):
OpenCode's dark-theme color/radius/typography token values (Milestone 1)
were replaced wholesale by nochan's tokens, and the two OpenCode SVG path
strings (`chevron-down`, `stop`) were dropped when the chrome moved to text
controls. nochan (https://nochan.vercel.app) is the user's own site/design
system — its tokens are used with no licensing concern
(docs/UI_REFERENCE_NOCHAN.md).

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

## Third-party notices

### opencode (anomalyco/opencode)

Referenced only as the structure/interaction source for the UI redesign
(see docs/DECISIONS.md ADR-018 and docs/UI_REFERENCE_OPENCODE.md) — never
as product branding, logo, or an implied affiliation/endorsement. All UI
code in this repo is an original React implementation; only the resize-
handle drag math/hit target, the command-palette dialog geometry, and the
search-match normalization were adapted, per the table above and the
per-file source comments.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Policy

- MIT / Apache-2.0 / BSD-2-Clause / BSD-3-Clause: preferred, usable freely
  with attribution as required by the license.
- MPL: acceptable only after explicit review, logged here before merge.
- GPL / AGPL / SSPL / BSL / source-available non-compete / branding-restricted
  / commercial-use-restricted / custom licenses preventing derivative
  products: not used without explicit user approval, logged here if ever
  approved.
- Being public on GitHub does not imply permission to copy code.
