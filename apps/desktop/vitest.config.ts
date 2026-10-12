import { defineConfig } from 'vitest/config'

/**
 * Unit tests only (`*.test.ts`; the Playwright suite is `e2e/*.e2e.ts`). The agent tests run real shells, real git
 * and process-tree kills, which are slow when the whole workspace's suites run in parallel - so the per-test budget
 * is generous. A test that is genuinely stuck still fails; it just is not killed by a loaded machine.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
