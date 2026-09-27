# Build State

**Current phase:** Phase 1 — Desktop Foundation (complete) → Phase 2 next

**Completed:**

- Phase 0: environment inspected, core V1 dependency licenses verified
  (all MIT/Apache-2.0), `git init`, docs/ARCHITECTURE.md, docs/DECISIONS.md,
  docs/OPEN_SOURCE_INVENTORY.md, docs/BUILD_STATE.md created.
- Phase 1: pnpm workspace monorepo (`apps/desktop`, `packages/shared`,
  `packages/storage`); strict TypeScript base config; ESLint 10 flat config
  + Prettier; Electron shell via `electron-vite` (main/preload/renderer,
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  single-instance lock); typed IPC contract (`@ai-workspace/shared`
  `RendererApi` + `IPC_CHANNELS`) — no ad hoc `ipcRenderer.invoke` outside
  preload; SQLite via `better-sqlite3` with a versioned migration runner
  (`schema_migrations` table); `WorkspaceRepository` +  `SettingsRepository`;
  React 19 renderer — sidebar (workspace list/create), workspace view
  (rename/delete), theme toggle (light/dark/system via `data-theme` +
  `prefers-color-scheme`).

**Tests:**

- `packages/shared`: 7 unit tests (zod schema boundaries for workspace/settings input).
- `packages/storage`: 8 unit tests (WorkspaceRepository CRUD, SettingsRepository get/set/validation), against an in-memory SQLite db.
- `apps/desktop`: no unit tests yet (thin IPC wiring only); `pnpm -r typecheck`, `eslint .` clean.
- Manual: `pnpm --filter @ai-workspace/desktop build` succeeds; `pnpm --filter @ai-workspace/desktop start` launches the packaged app with no main-process errors (only benign Chromium GPU-disk-cache warnings under a restricted profile dir).
- **NOT VERIFIED**: interactive UI walkthrough (create/rename/delete a workspace, theme toggle, restart-persistence) — no GUI automation tool available for a native Electron window in this environment. The app was left running after the build for manual confirmation.

**Known issues:**

- pnpm's build-script allowlist (`pnpm-workspace.yaml` `allowBuilds`) had to
  explicitly approve `better-sqlite3`, `esbuild`, and `electron` — `electron`'s
  own binary download postinstall did not re-trigger automatically after
  approval and had to be run manually once (`node install.js` inside the
  electron package). Future clean installs should just work once approved.
- `apps/desktop` renderer bundle is ~650KB unminified-warning threshold
  (React + app code) — fine for V1, revisit if it grows materially.

**Next exact task:** Phase 2 — AI Chat. Add `packages/providers` wrapping
`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google` behind a
provider-independent interface; secure credential storage via Electron
`safeStorage` (see ADR-004) with a `provider_configs` migration; extend the
conversation schema (`conversations`, `messages`, `message_parts`) with
per-message provider/model attribution; model selector + streaming chat UI
in the renderer; verify a single conversation can move
Claude → Claude → OpenAI → Gemini without branching.
