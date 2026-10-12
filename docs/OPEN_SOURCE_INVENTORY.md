# Open Source Inventory

Tracks every external project whose **code** is incorporated, adapted, or
depended on beyond an ordinary npm install of an unmodified package. Studying
an architecture (e.g. Cline's agent loop shape) without copying its code is
not logged here — only actual reuse/adaptation of code or substantial
config/schema is.

Ordinary, unmodified npm dependencies (Electron, React, Vite, TypeScript,
Vercel AI SDK, better-sqlite3, Monaco, xterm.js, node-pty, MCP SDK, zod,
electron-builder, electron-vite) are declared in each
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
| ~~`react-markdown`~~ | ~~10.1.0~~ | MIT      | **Removed 2026-10-12** — replaced by Streamdown (ADR-026)   |
| ~~`remark-gfm`~~     | ~~4.0.1~~ | MIT       | **Removed 2026-10-12** — Streamdown bundles GFM             |

Phase 3 additions, verified 2026-09-27 via `npm view <pkg> license` (ordinary,
unmodified npm dependencies — no code copied/adapted):

| Package  | Version | License | Reason                                                                  |
| -------- | ------- | ------- | ------------------------------------------------------------------------ |
| `ignore` | 7.0.10  | MIT     | `.gitignore`-semantics parser for workspace file indexing exclusion (ADR-011) |

UI redesign additions, verified 2026-10-12 via `npm view <pkg> license`:

| Package                    | Version | License   | Reason                                                                                   |
| -------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------- |
| `@fontsource/ibm-plex-mono` | 5.3.0   | OFL-1.1   | **Font.** IBM Plex Mono, bundled locally for all UI chrome (nochan visual language, ADR-018). SIL Open Font License 1.1 permits bundling/redistributing the font with software (it may not be sold on its own); explicitly approved for this use. Only the latin 400/500/600 files are imported (`main.tsx`); unmodified. |

models.dev integration additions (ADR-021…026), verified 2026-10-12 via
`npm view <pkg> license version`; ordinary, unmodified npm dependencies:

| Package                          | Version | License    | Reason                                                                 |
| -------------------------------- | ------- | ---------- | ----------------------------------------------------------------------- |
| `@ai-sdk/xai`                    | 5.0.20  | Apache-2.0 | xAI (Grok) provider for `ai`                                            |
| `@ai-sdk/mistral`                | 4.0.62  | Apache-2.0 | Mistral provider                                                        |
| `@ai-sdk/groq`                   | 4.0.59  | Apache-2.0 | Groq provider                                                           |
| `@ai-sdk/deepseek`               | 3.0.63  | Apache-2.0 | DeepSeek provider (typed thinking/effort; routed by id override)        |
| `@ai-sdk/cerebras`               | 3.0.67  | Apache-2.0 | Cerebras provider                                                       |
| `@ai-sdk/togetherai`             | 3.0.68  | Apache-2.0 | Together AI provider                                                    |
| `@ai-sdk/perplexity`             | 5.0.10  | Apache-2.0 | Perplexity provider                                                     |
| `@openrouter/ai-sdk-provider`    | 3.1.0   | Apache-2.0 | OpenRouter provider (peer `ai ^7`)                                      |
| `@ai-sdk/openai-compatible`      | 3.0.67  | Apache-2.0 | Generic OpenAI-compatible route (Ollama, custom endpoint, every models.dev provider with a plain `api` URL) |
| `streamdown`                     | 2.7.0   | Apache-2.0 | Streaming markdown renderer replacing react-markdown (ADR-026)          |
| `use-stick-to-bottom`            | 1.1.6   | MIT        | Auto-scroll that yields when the user scrolls up                        |
| `tsx` (dev only)                 | 4.23.15 | MIT        | Runs `scripts/update-models-snapshot.ts` and the check scripts          |

All of the `@ai-sdk/*` packages depend on `@ai-sdk/provider` 4.x, the major used
by the installed `ai@7.0.118`. `pnpm-workspace.yaml` `allowBuilds` and the
`@types/node` override are unchanged (none of these packages has an install
script).

**models.dev data.** `https://models.dev` — repository `anomalyco/models.dev`,
**MIT**, "Copyright (c) 2025 models.dev" (license text verified via the GitHub
API 2026-10-12). We use its published `api.json` as *data*: downloaded at
runtime (cached under userData, ADR-021) and a trimmed copy committed as
`packages/providers/src/data/models-dev-snapshot.json` (generated by
`scripts/update-models-snapshot.ts`, no hand edits). MIT notice:

```
MIT License

Copyright (c) 2025 models.dev

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
OUT OF OR IN CONNECTION WITH THE SOFTWARE.
```

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

| opencode (models.dev integration — provider registry) | `anomalyco/opencode`, tag `v1.18.35` (`packages/opencode/src/provider/provider.ts`) | fetched 2026-10-12 | MIT | The `BUNDLED_PROVIDERS` table (npm package → factory), the rule "unknown `npm` + models.dev `api` URL → `@ai-sdk/openai-compatible` with that base URL", and `includeUsage: true` / `name: <providerID>` for that route | Re-implemented in `packages/providers/src/registry.ts` + `adapters/sdk-provider.ts` as a data-driven resolver (static imports instead of dynamic `Npm.add`, no Effect, no plugin loader); DeepSeek override and the exclusion list are ours | Header comment in `registry.ts` + MIT notice below | The user asked for OpenCode's provider architecture; the logic is framework-agnostic |
| opencode (models.dev integration — reasoning variants) | `anomalyco/opencode`, tag `v1.18.35` (`packages/opencode/src/provider/transform.ts` `variants()` / `sdkKey()`); the current `dev` branch moved this to `packages/core/src/variant.ts` | fetched 2026-10-12 | MIT | Which `providerOptions` key and field each AI SDK package reads for reasoning effort (anthropic `effort`+`thinking`, openai `reasoningEffort`, google `thinkingConfig.thinkingLevel`, openrouter `reasoning.effort`, openai-compatible `reasoningEffort`, …) and the adaptive-vs-budget thinking split for Claude | Re-derived against the installed SDK option schemas and expressed as `reasoning-options.ts` (validation against models.dev `reasoning_options`, SDK-capability intersection, `none` → disabled); no model-id regexes | Header comment in `reasoning-options.ts` + MIT notice below | Hard-won provider-quirk knowledge; checked, not copied blindly |
| opencode (models.dev integration — catalog loader) | `anomalyco/opencode`, tag `v1.14.28` (`packages/opencode/src/provider/models.ts`) and `dev` `packages/core/src/models-dev.ts` | fetched 2026-10-12 | MIT | Architecture only: bundled snapshot as the floor, on-disk cache, periodic refresh, opt-out flag, `reasoning_options` interpretation | Original implementation in `models-dev.ts` (lenient parser/trimmer/normalizer) and `apps/desktop/src/main/models-dev-service.ts` (24 h TTL instead of 5 min, bare GET, user setting) | Header comment in `models-dev.ts` + MIT notice below | Same data source, same shape of problem |

| opencode (Phase 4 — diff summary) | `anomalyco/opencode`, `dev` branch (`packages/ui/src/components/diff-changes.tsx` + `.css`, studied via docs/UI_REFERENCE_OPENCODE.md §7) | studied 2026-09-27 | MIT | The "`+N -M` text" and "five-block proportional bar" variants of the compact change summary | Re-implemented as `components/git/DiffChanges.tsx` + `lib/code/git-ui.ts` (`diffBars`, our own rounding rule: each non-zero side gets ≥ 1 of 5 blocks); nochan tokens (`--ok`/`--signal`) instead of opencode's diff colors; binary/unknown states added | Source comment at the top of `DiffChanges.tsx` and `diffBars` + MIT notice below | The user asked for OpenCode's diff-changes summary; tiny, framework-free arithmetic |
| opencode (Phase 4 — resize handle, horizontal) | same as the resize-handle row above | n/a | MIT | The existing adapted drag hook/handle, extended with a vertical-direction use and a row-resize handle for the bottom panel | `ResizeHandle` gained an `orientation` prop; `.resize-handle--row` added in `styles/code.css` | Existing source comments + MIT notice below | Reuse of the already-adapted piece |

Phase 4 additions (code workspace), verified 2026-10-12 via `npm view <pkg> license`
(ordinary, unmodified npm dependencies — no code copied/adapted):

| Package | Version | License | Reason |
| ------- | ------- | ------- | ------ |
| `monaco-editor` | 0.57.0 | MIT | The code editor and diff editor (ADR-001/033). Lazy-loaded, slim assembly. |
| `@xterm/xterm` | 6.0.0 | MIT | Terminal renderer (ADR-037). |
| `@xterm/addon-fit` | 0.11.0 | MIT | Fits the terminal to its panel and drives PTY resize. |
| `@lydell/node-pty` | 1.2.0-beta.15 | MIT | PTY with prebuilt per-platform binaries (optional deps `@lydell/node-pty-<platform>-<arch>`, MIT; the Windows package carries ConPTY binaries built from Microsoft's Windows Terminal sources, MIT). Chosen over `node-pty` to avoid a native build per Electron ABI (ADR-037). A beta tag — pinned exactly. |
| `@playwright/test` | 1.64.0 | Apache-2.0 | devDependency: drives the real Electron app for the E2E tests and screenshot QA. |

**One asset under CC-BY-4.0 — approved by the owner (2026-10-12) to keep, with attribution.** `monaco-editor` (MIT) bundles
`codicon.ttf`, the icon font Monaco's widgets use (find box, fold arrows, the diff editor's
"hidden lines" expanders). Its upstream, `@vscode/codicons`, is licensed **CC-BY-4.0**
(`npm view @vscode/codicons license`), which is outside the MIT/Apache/BSD list this project
holds itself to. CC-BY requires attribution (creator, license link, note of changes — none
here): *"Codicons © Microsoft Corporation, https://github.com/microsoft/vscode-codicons,
licensed under CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)."* This line is the
attribution and must ship with the app's third-party notices (Phase 10 release packaging).
Decision: the owner chose to keep the font rather than restyle Monaco's widgets.

Removed during the redesign (no longer in the code, so no longer claimed):
OpenCode's dark-theme color/radius/typography token values (Milestone 1)
were replaced wholesale by nochan's tokens, and the two OpenCode SVG path
strings (`chevron-down`, `stop`) were dropped when the chrome moved to text
controls. nochan (https://nochan.vercel.app) is the user's own site/design
system — its tokens are used with no licensing concern
(docs/UI_REFERENCE_NOCHAN.md).

Phase 5 additions (agent tools, permission engine, agent loop), verified 2026-10-12 via `npm view <pkg> license`
(ordinary, unmodified npm dependencies — no code copied/adapted):

| Package | Version | License | Reason |
| ------- | ------- | ------- | ------ |
| `diff` (jsdiff) | 9.0.0 | BSD-3-Clause | Unified diffs and `+N -M` counts for the edit tools' previews, results and the run report (ADR-043). `dependencies` of `apps/desktop` (externalized in the main process like `ignore`). |
| `zod` | 4.6.5 | MIT | Already used through `@ai-workspace/shared`; now also imported directly by the main-process tool layer (input schemas -> JSON Schema via `z.toJSONSchema`). A `devDependency` of `apps/desktop` **on purpose**: as a `dependency` electron-vite would externalize it and the sandboxed preload (which bundles the shared package) could no longer load (ADR-040). |

**Patterns studied, not copied** (no code adapted, so no attribution entry is required; recorded for provenance): OpenCode's
one-line collapsible tool row (`basic-tool`, docs/UI_REFERENCE_OPENCODE.md §5; re-implemented in `components/agent/ActivityRow.tsx`
with nochan tokens — the existing `DiffChanges` summary is reused as is), and Cline's plan → tool call → observe → diff → finish
loop and per-action approval UX. The loop, permission engine, classifier, redactor, report and revert are original.

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

Referenced as (1) the structure/interaction source for the UI redesign
(see docs/DECISIONS.md ADR-018 and docs/UI_REFERENCE_OPENCODE.md) and (2) the
provider/model-loading architecture for the models.dev integration (ADR-021…023)
— never as product branding, logo, or an implied affiliation/endorsement. All UI
code in this repo is an original React implementation; only the resize-
handle drag math/hit target, the command-palette dialog geometry, the
search-match normalization, and — in `packages/providers` — the provider
factory table / openai-compatible route and the per-SDK reasoning-option
mapping were adapted, per the table above and the per-file source comments.

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
