import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the REAL Electron app (the production build in
 * `out/`) with a throwaway --user-data-dir. Run with `pnpm --filter
 * @ai-workspace/desktop test:e2e` (it builds first). Files are named
 * `*.e2e.ts` so vitest's unit-test glob never picks them up.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 240_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  expect: { timeout: 20_000 },
})
