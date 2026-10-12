import { describe, expect, it } from 'vitest'
import type { AgentEvent, AgentRun, PermissionRequest, RunReport, ToolRun } from '@ai-workspace/shared'
import {
  decisionText,
  diffLineKind,
  formatDuration,
  initialAgentState,
  promptHeading,
  reduceAgent,
  reportHasContent,
  rowGlyph,
  rowHasDetails,
  splitLabel,
  totalChanges,
  upsertRun,
  type AgentUiState,
} from '../agent-ui'

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'r1',
  workspaceId: 'w',
  conversationId: 'c1',
  userMessageId: 'u1',
  assistantMessageId: null,
  mode: 'build',
  agentId: 'implementer',
  provider: 'custom',
  model: 'm',
  status: 'running',
  steps: 0,
  maxSteps: 25,
  errorText: null,
  report: null,
  startedAt: 1,
  finishedAt: null,
  ...over,
})

const toolRun = (over: Partial<ToolRun> = {}): ToolRun => ({
  id: 't1',
  runId: 'r1',
  workspaceId: 'w',
  conversationId: 'c1',
  seq: 1,
  step: 1,
  toolId: 'filesystem.read',
  risk: 'safe',
  label: 'read src/a.ts',
  summary: '',
  input: '{}',
  detail: null,
  status: 'running',
  decisionSource: null,
  exitCode: null,
  startedAt: 1,
  finishedAt: null,
  durationMs: null,
  ...over,
})

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: 'q1',
  runId: 'r1',
  toolRunId: 't1',
  conversationId: 'c1',
  workspaceId: 'w',
  toolId: 'terminal.execute',
  risk: 'execution',
  allowedDecisions: ['allow_once', 'deny'],
  grantScopeNote: null,
  preview: { kind: 'other', description: 'x' },
  createdAt: 1,
  ...over,
})

const apply = (state: AgentUiState, ...events: AgentEvent[]): AgentUiState =>
  events.reduce((s, event) => reduceAgent(s, { type: 'event', event }), state)

describe('reduceAgent', () => {
  it('builds the live run from the event stream, in order', () => {
    const state = apply(
      initialAgentState,
      { type: 'run-start', run: run() },
      { type: 'step', runId: 'r1', step: 1 },
      { type: 'text-delta', runId: 'r1', delta: 'Let me ' },
      { type: 'text-delta', runId: 'r1', delta: 'look.' },
      { type: 'tool', runId: 'r1', toolRun: toolRun({ id: 't2', seq: 2, label: 'read b' }) },
      { type: 'tool', runId: 'r1', toolRun: toolRun({ id: 't1', seq: 1 }) },
      { type: 'tool', runId: 'r1', toolRun: toolRun({ id: 't1', seq: 1, status: 'ok', summary: '12 lines' }) },
    )
    expect(state.live).toMatchObject({ runId: 'r1', step: 1, text: 'Let me look.', maxSteps: 25 })
    expect(state.live?.toolRuns.map((t) => [t.id, t.status])).toEqual([
      ['t1', 'ok'],
      ['t2', 'running'],
    ])
  })

  it('ignores events from some other run', () => {
    const state = apply(initialAgentState, { type: 'run-start', run: run() }, { type: 'text-delta', runId: 'other', delta: 'x' }, { type: 'step', runId: 'other', step: 9 })
    expect(state.live).toMatchObject({ text: '', step: 0 })
  })

  it('tracks permission prompts and drops them when answered, deduplicating repeats', () => {
    let state = apply(initialAgentState, { type: 'permission-request', request: request() }, { type: 'permission-request', request: request() })
    expect(state.permissions).toHaveLength(1)
    state = apply(state, { type: 'permission-request', request: request({ requestId: 'q2' }) })
    expect(state.permissions.map((p) => p.requestId)).toEqual(['q1', 'q2'])
    state = apply(state, { type: 'permission-resolved', requestId: 'q1', runId: 'r1' })
    expect(state.permissions.map((p) => p.requestId)).toEqual(['q2'])
  })

  it('pending prompts restored after a reload merge without duplicating', () => {
    let state = apply(initialAgentState, { type: 'permission-request', request: request() })
    state = reduceAgent(state, { type: 'pending', requests: [request(), request({ requestId: 'q9' })] })
    expect(state.permissions.map((p) => p.requestId)).toEqual(['q1', 'q9'])
  })

  it('streams command output into the live run and the bottom panel log, capped', () => {
    const command = toolRun({ id: 'c1', toolId: 'terminal.execute', label: 'run pnpm test', status: 'running' })
    let state = apply(initialAgentState, { type: 'run-start', run: run() }, { type: 'tool', runId: 'r1', toolRun: command })
    state = apply(state, { type: 'tool-output', runId: 'r1', toolRunId: 'c1', chunk: 'hello ' }, { type: 'tool-output', runId: 'r1', toolRunId: 'c1', chunk: 'world' })
    expect(state.live?.outputs['c1']).toBe('hello world')
    expect(state.outputLog).toHaveLength(1)
    expect(state.outputLog[0]).toMatchObject({ toolRunId: 'c1', label: 'run pnpm test', text: 'hello world', status: 'running' })
    state = apply(state, { type: 'tool', runId: 'r1', toolRun: { ...command, status: 'ok', exitCode: 0 } })
    expect(state.outputLog[0]).toMatchObject({ status: 'ok', text: 'hello world' })

    const flood = apply(state, { type: 'tool-output', runId: 'r1', toolRunId: 'c1', chunk: 'x'.repeat(100_000) })
    expect(flood.live?.outputs['c1']!.length).toBeLessThanOrEqual(40_001)
    expect(flood.outputLog[0]!.text.length).toBeLessThanOrEqual(40_001)
  })

  it('a command that was denied, is still waiting, or was rejected never appears in the output log', () => {
    const base = { id: 'c9', toolId: 'terminal.execute' as const, label: 'run rm x' }
    let state = apply(initialAgentState, { type: 'run-start', run: run() }, { type: 'tool', runId: 'r1', toolRun: toolRun({ ...base, status: 'pending' }) })
    expect(state.outputLog).toEqual([])
    state = apply(state, { type: 'tool', runId: 'r1', toolRun: toolRun({ ...base, status: 'denied', exitCode: null }) })
    expect(state.outputLog).toEqual([])
    // ...but the activity row for it is still shown.
    expect(state.live?.toolRuns.map((t) => t.status)).toEqual(['denied'])
    state = apply(state, { type: 'tool', runId: 'r1', toolRun: toolRun({ id: 'c10', toolId: 'terminal.execute', label: 'run x', status: 'error', exitCode: null, decisionSource: 'not-asked' }) })
    expect(state.outputLog).toEqual([])
    state = apply(state, { type: 'tool', runId: 'r1', toolRun: toolRun({ id: 'c11', toolId: 'terminal.execute', label: 'run node --test', status: 'error', exitCode: 1 }) })
    expect(state.outputLog.map((e) => e.toolRunId)).toEqual(['c11'])
  })

  it('only terminal commands go to the agent output log', () => {
    const state = apply(initialAgentState, { type: 'run-start', run: run() }, { type: 'tool', runId: 'r1', toolRun: toolRun() })
    expect(state.outputLog).toEqual([])
  })

  it('run-end clears the live run and any prompt of that run', () => {
    let state = apply(initialAgentState, { type: 'run-start', run: run() }, { type: 'permission-request', request: request() })
    state = apply(state, { type: 'run-end', run: run({ status: 'completed' }), detail: { ...run({ status: 'completed' }), toolRuns: [] } })
    expect(state.live).toBeNull()
    expect(state.permissions).toEqual([])
  })
})

describe('upsertRun', () => {
  it('replaces by id and keeps start order', () => {
    const a = { ...run({ id: 'a', startedAt: 1 }), toolRuns: [] }
    const b = { ...run({ id: 'b', startedAt: 2 }), toolRuns: [] }
    expect(upsertRun([b], a).map((r) => r.id)).toEqual(['a', 'b'])
    expect(upsertRun([a, b], { ...a, status: 'completed' as const }).find((r) => r.id === 'a')?.status).toBe('completed')
  })
})

describe('row presentation', () => {
  it('splits a label into verb and target', () => {
    expect(splitLabel({ toolId: 'filesystem.read', label: 'read src/a.ts' })).toEqual({ title: 'read', subtitle: 'src/a.ts' })
    expect(splitLabel({ toolId: 'terminal.execute', label: 'run pnpm test' })).toEqual({ title: 'run', subtitle: 'pnpm test' })
    expect(splitLabel({ toolId: 'workspace.search', label: 'index search "x"' })).toEqual({ title: 'index search', subtitle: '"x"' })
    expect(splitLabel({ toolId: 'git.status', label: 'git status' })).toEqual({ title: 'git', subtitle: 'status' })
    expect(splitLabel({ toolId: 'git.diff', label: 'git' })).toEqual({ title: 'git', subtitle: '' })
  })

  it('chooses the status glyph', () => {
    expect(rowGlyph({ toolId: 'filesystem.read', status: 'running', exitCode: null })).toEqual({ glyph: '●', tone: 'running' })
    expect(rowGlyph({ toolId: 'filesystem.read', status: 'ok', exitCode: null })).toEqual({ glyph: '●', tone: 'ok' })
    expect(rowGlyph({ toolId: 'terminal.execute', status: 'ok', exitCode: 0 })).toEqual({ glyph: '✓', tone: 'good' })
    expect(rowGlyph({ toolId: 'terminal.execute', status: 'error', exitCode: 1 })).toEqual({ glyph: '✗', tone: 'error' })
    expect(rowGlyph({ toolId: 'filesystem.patch', status: 'denied', exitCode: null }).tone).toBe('denied')
    expect(rowGlyph({ toolId: 'filesystem.patch', status: 'cancelled', exitCode: null }).tone).toBe('cancelled')
  })

  it('knows when a row can expand', () => {
    expect(rowHasDetails({ detail: '+x', status: 'ok', toolId: 'filesystem.patch' }, undefined)).toBe(true)
    expect(rowHasDetails({ detail: null, status: 'ok', toolId: 'filesystem.read' }, undefined)).toBe(false)
    expect(rowHasDetails({ detail: null, status: 'running', toolId: 'terminal.execute' }, 'live output')).toBe(true)
    expect(rowHasDetails({ detail: null, status: 'denied', toolId: 'filesystem.patch' }, undefined)).toBe(true)
  })

  it('words the prompt heading as in the brief', () => {
    expect(promptHeading({ toolId: 'terminal.execute', risk: 'execution' })).toBe('AGENT REQUESTS · run (execution)')
    expect(promptHeading({ toolId: 'filesystem.patch', risk: 'write' })).toBe('AGENT REQUESTS · patch (write)')
    expect(promptHeading({ toolId: 'terminal.execute', risk: 'destructive' })).toBe('AGENT REQUESTS · run (destructive)')
  })

  it('words who allowed a call', () => {
    expect(decisionText('prompt-once')).toBe('approved once')
    expect(decisionText('workspace-grant')).toBe('covered by a workspace grant')
    expect(decisionText(null)).toBe('')
  })

  it('formats durations and diff lines', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(420)).toBe('420ms')
    expect(formatDuration(4300)).toBe('4.3s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(null)).toBe('')
    expect(['+++ b/x', '--- a/x', '@@ -1 +1 @@', '+added', '-removed', ' context'].map(diffLineKind)).toEqual(['meta', 'meta', 'hunk', 'add', 'del', 'context'])
  })

  it('sums changes without counting reverted files', () => {
    expect(totalChanges([{ added: 3, removed: 1 }, { added: 10, removed: 4, reverted: true }, { added: 1, removed: 0 }])).toEqual({ added: 4, removed: 1 })
  })
})

describe('reportHasContent', () => {
  const empty: RunReport = {
    filesInspected: [],
    filesChanged: [],
    changedByCommands: [],
    commands: [],
    tests: { status: 'not_run', command: null, exitCode: null, editsAfterTests: false, detail: '' },
    refused: [],
    toolCalls: 0,
    toolErrors: 0,
    stoppedBy: 'finished',
    modelConcerns: null,
  }
  it('is false for an empty finished report and true as soon as there is something to say', () => {
    expect(reportHasContent(null)).toBe(false)
    expect(reportHasContent(empty)).toBe(false)
    expect(reportHasContent({ ...empty, filesInspected: ['a'] })).toBe(true)
    expect(reportHasContent({ ...empty, stoppedBy: 'cancelled' })).toBe(true)
    expect(reportHasContent({ ...empty, modelConcerns: 'none' })).toBe(true)
  })
})
