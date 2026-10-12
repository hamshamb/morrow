import type { RendererApi } from '@ai-workspace/shared'

/** Dev-only mock of the Phase 4 code workspace surface (fixtures arrive with the UI). */
export function createMockCodeApi(): Pick<RendererApi, 'fs' | 'git' | 'terminal'> {
  const unavailable = (): never => {
    throw new Error('not mocked yet')
  }
  return {
    fs: {
      listDir: unavailable,
      readFile: unavailable,
      writeFile: unavailable,
      listPaths: unavailable,
      searchText: unavailable,
      reveal: unavailable,
    },
    git: {
      status: unavailable,
      diff: unavailable,
      stage: unavailable,
      unstage: unavailable,
      stageAll: unavailable,
      unstageAll: unavailable,
      commit: unavailable,
    },
    terminal: {
      create: unavailable,
      list: unavailable,
      getBuffer: unavailable,
      write: unavailable,
      resize: unavailable,
      kill: unavailable,
      onEvent: () => () => undefined,
    },
  }
}
