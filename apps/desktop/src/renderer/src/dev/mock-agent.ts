import { BUILTIN_AGENTS, type RendererApi } from '@ai-workspace/shared'

/** Dev-only agent surface (expanded with fixtures when the Plan/Build UI lands). */
export function createMockAgentApi(): Pick<RendererApi, 'agent'> {
  return {
    agent: {
      run: () => Promise.reject(new Error('Agent runs are not available in the browser preview')),
      cancel: () => Promise.resolve(),
      respondPermission: () => Promise.resolve({ ok: false, reason: 'preview' }),
      pendingPermissions: () => Promise.resolve([]),
      listRuns: () => Promise.resolve([]),
      changes: () => Promise.resolve([]),
      fileDiff: (_runId, path) => Promise.resolve({ status: 'unavailable', path, message: 'preview' }),
      revert: () => Promise.resolve({ reverted: [], skipped: [] }),
      listGrants: () => Promise.resolve([]),
      revokeGrant: () => Promise.resolve(),
      listAgents: () => Promise.resolve([...BUILTIN_AGENTS]),
      updateAgent: () => Promise.resolve([...BUILTIN_AGENTS]),
      onEvent: () => () => undefined,
    },
  }
}
