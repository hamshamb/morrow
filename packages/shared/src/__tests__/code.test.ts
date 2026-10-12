import { describe, expect, it } from 'vitest'
import {
  CodeSessionSchema,
  CreateTerminalInputSchema,
  DEFAULT_DENY_PATTERNS,
  FsReadResultSchema,
  FsWriteInputSchema,
  GitCommitInputSchema,
  GitPathsInputSchema,
  GitStatusSchema,
  MAX_RESTORED_TABS,
  NOISE_EXCLUDE_PATTERNS,
  SENSITIVE_DENY_PATTERNS,
  TerminalResizeInputSchema,
} from '../index'

describe('deny-list split', () => {
  it('keeps DEFAULT_DENY_PATTERNS as secrets + noise, with secrets covering .env, keys and the repo internals folder', () => {
    expect(DEFAULT_DENY_PATTERNS).toEqual([...SENSITIVE_DENY_PATTERNS, ...NOISE_EXCLUDE_PATTERNS])
    for (const p of ['.git/', '.env', '.env.*', '*.pem', '*.key', 'id_rsa*']) expect(SENSITIVE_DENY_PATTERNS).toContain(p)
    // Noise (build output, binaries) is hidden from the tree but is not a secret.
    expect(SENSITIVE_DENY_PATTERNS).not.toContain('node_modules/')
    expect(NOISE_EXCLUDE_PATTERNS).toContain('node_modules/')
  })
})

describe('file IPC contracts', () => {
  it('parses each read result shape', () => {
    expect(
      FsReadResultSchema.parse({
        status: 'ok',
        relativePath: 'a.ts',
        content: 'x',
        hash: 'h',
        mtimeMs: 1,
        sizeBytes: 1,
        readOnly: false,
        readOnlyReason: null,
        bom: false,
      }).status,
    ).toBe('ok')
    expect(FsReadResultSchema.parse({ status: 'binary', relativePath: 'a.png', sizeBytes: 3, message: 'm' }).status).toBe('binary')
    expect(() => FsReadResultSchema.parse({ status: 'ok', relativePath: 'a.ts' })).toThrow()
  })

  it('requires a workspace, a path and an expected hash (or null) for writes', () => {
    expect(FsWriteInputSchema.parse({ workspaceId: 'w', relativePath: 'a.ts', content: '', expectedHash: null }).overwrite).toBeUndefined()
    expect(() => FsWriteInputSchema.parse({ workspaceId: 'w', relativePath: '', content: '', expectedHash: null })).toThrow()
    expect(() => FsWriteInputSchema.parse({ workspaceId: 'w', relativePath: 'a', content: '' })).toThrow()
  })
})

describe('repository status IPC contracts', () => {
  it('bounds the number of paths and the commit message', () => {
    expect(() => GitPathsInputSchema.parse({ workspaceId: 'w', paths: [] })).toThrow()
    expect(() => GitPathsInputSchema.parse({ workspaceId: 'w', paths: Array.from({ length: 501 }, (_, i) => `f${i}`) })).toThrow()
    expect(GitPathsInputSchema.parse({ workspaceId: 'w', paths: ['a'] }).paths).toEqual(['a'])
    expect(() => GitCommitInputSchema.parse({ workspaceId: 'w', message: 'x'.repeat(10_001) })).toThrow()
  })

  it('models every non-ok status as its own state', () => {
    for (const state of ['git-missing', 'not-a-repo'] as const) expect(GitStatusSchema.parse({ state }).state).toBe(state)
    expect(GitStatusSchema.parse({ state: 'error', message: 'boom' }).state).toBe('error')
    expect(() => GitStatusSchema.parse({ state: 'ok' })).toThrow()
  })
})

describe('terminal IPC contracts', () => {
  it('rejects absurd or non-integer dimensions', () => {
    expect(CreateTerminalInputSchema.parse({ workspaceId: 'w', cols: 80, rows: 24 }).cols).toBe(80)
    expect(() => CreateTerminalInputSchema.parse({ workspaceId: 'w', cols: 0, rows: 24 })).toThrow()
    expect(() => CreateTerminalInputSchema.parse({ workspaceId: 'w', cols: 80.5, rows: 24 })).toThrow()
    expect(() => TerminalResizeInputSchema.parse({ id: 'x', cols: 100000, rows: 24 })).toThrow()
  })
})

describe('CodeSessionSchema', () => {
  it('caps restored tabs', () => {
    const tabs = Array.from({ length: MAX_RESTORED_TABS + 1 }, (_, i) => `f${i}.ts`)
    expect(() => CodeSessionSchema.parse({ openTabs: tabs, activeTab: null })).toThrow()
    expect(CodeSessionSchema.parse({ openTabs: tabs.slice(0, 3), activeTab: 'f1.ts' }).activeTab).toBe('f1.ts')
  })
})
