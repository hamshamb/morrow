import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { READ_ONLY_TOOLS, type AgentEvent, type PermissionRequest } from '@ai-workspace/shared'
import { makeHarness, put, type Harness } from './agent-harness'

let h: Harness
afterEach(() => h?.cleanup())

const FAKE_KEY = 'sk-ant-' + 'api03-ZyXwVuTsRqPoNmLkJiHgFeDcBa'

/** A command that works in both PowerShell and bash. */
const node = (code: string): string => `node -e "${code.replace(/"/g, '\\"')}"`

const lastToolRun = (id: 'terminal.execute' | 'filesystem.patch' | 'filesystem.read' = 'terminal.execute') =>
  h.repo.listToolRuns(h.runId).filter((r) => r.toolId === id).at(-1)

describe('terminal.execute through the permission engine', () => {
  it('asks first, showing the exact command, cwd, shell and timeout; runs only after allow-once', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    let markerBeforeAnswer = true
    h.autoAnswer = false
    h.onPrompt = (request) => {
      markerBeforeAnswer = existsSync(join(h.root, 'ran.txt'))
      expect(request.preview).toMatchObject({
        kind: 'command',
        command: node("require('fs').writeFileSync('ran.txt','yes')"),
        cwd: realpathSync.native(h.root),
        timeoutSeconds: 60,
      })
      expect((request.preview as { shell: string }).shell.length).toBeGreaterThan(0)
      expect(request.risk).toBe('execution')
      expect(request.allowedDecisions).toEqual(['allow_once', 'allow_session', 'allow_workspace', 'deny'])
      h.engine.respond({ requestId: request.requestId, decision: 'allow_once' })
    }
    const out = await h.call('terminal_execute', { command: node("require('fs').writeFileSync('ran.txt','yes')") })
    expect(markerBeforeAnswer).toBe(false) // nothing ran while the prompt was open
    expect(out.isError).toBe(false)
    expect(out.text).toContain('exit code: 0')
    expect(readFileSync(join(h.root, 'ran.txt'), 'utf8')).toBe('yes')
    const row = lastToolRun()
    expect(row).toMatchObject({ status: 'ok', risk: 'execution', exitCode: 0, decisionSource: 'prompt-once' })
    expect(row?.summary).toMatch(/^exit 0 · \d+\.\ds$/)
    expect(row?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('deny: the command never runs, and the model is told not to work around it', async () => {
    h = makeHarness()
    h.answers.push('deny')
    const out = await h.call('terminal_execute', { command: node("require('fs').writeFileSync('ran.txt','yes')") })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/DENIED/)
    expect(existsSync(join(h.root, 'ran.txt'))).toBe(false)
    expect(lastToolRun()).toMatchObject({ status: 'denied', decisionSource: 'prompt-deny' })
  })

  it('a failing command is reported with its real exit code; the audit row is "error" but the model gets a normal result', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    const out = await h.call('terminal_execute', { command: node("console.log('boom'); process.exit(7)") })
    expect(out.isError).toBe(false)
    expect(out.text).toContain('exit code: 7')
    expect(out.text).toContain('boom')
    expect(lastToolRun()).toMatchObject({ status: 'error', exitCode: 7 })
    expect(lastToolRun()?.summary).toMatch(/^exit 7/)
  })

  it('runs in the workspace root', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    const out = await h.call('terminal_execute', { command: node('console.log(process.cwd())') })
    expect(realpathSync.native(out.text.split('--- output ---')[1]!.trim())).toBe(realpathSync.native(h.root))
  })

  it('"allow for this workspace" covers that exact command only; the next identical call needs no prompt', async () => {
    h = makeHarness()
    h.answers.push('allow_workspace')
    const command = node('console.log(1+1)')
    await h.call('terminal_execute', { command })
    expect(h.prompts).toHaveLength(1)
    await h.call('terminal_execute', { command })
    expect(h.prompts).toHaveLength(1)
    expect(lastToolRun()).toMatchObject({ status: 'ok', decisionSource: 'workspace-grant' })
    await h.call('terminal_execute', { command: node('console.log(1+2)') })
    expect(h.prompts).toHaveLength(2)
  })

  it('a destructive command offers only allow-once / deny, with the reasons, and a denied one does not run', async () => {
    h = makeHarness({ files: { 'README.md': '# x\n', 'doomed.txt': 'precious' } })
    h.answers.push('deny')
    const denied = await h.call('terminal_execute', { command: 'rm doomed.txt' })
    expect(denied.isError).toBe(true)
    expect(readFileSync(join(h.root, 'doomed.txt'), 'utf8')).toBe('precious')
    const request = h.prompts[0] as PermissionRequest
    expect(request.risk).toBe('destructive')
    expect(request.allowedDecisions).toEqual(['allow_once', 'deny'])
    expect(request.grantScopeNote).toBeNull()
    expect((request.preview as { reasons: string[] }).reasons.join(' ')).toMatch(/deletes files/)
    expect(lastToolRun()).toMatchObject({ risk: 'destructive', status: 'denied' })

    // Trying to smuggle a stronger answer through is refused, and the command still has not run.
    h.autoAnswer = false
    const pending = h.call('terminal_execute', { command: 'rm doomed.txt' })
    await new Promise((r) => setTimeout(r, 100))
    const second = h.prompts[1] as PermissionRequest
    expect(h.engine.respond({ requestId: second.requestId, decision: 'allow_workspace' }).ok).toBe(false)
    expect(h.engine.respond({ requestId: second.requestId, decision: 'allow_session' }).ok).toBe(false)
    expect(existsSync(join(h.root, 'doomed.txt'))).toBe(true)
    expect(h.repo.listGrants(h.workspaceId)).toEqual([])
    h.engine.respond({ requestId: second.requestId, decision: 'allow_once' })
    expect((await pending).isError).toBe(false)
    expect(existsSync(join(h.root, 'doomed.txt'))).toBe(false)
    expect(lastToolRun()).toMatchObject({ risk: 'destructive', status: 'ok', decisionSource: 'prompt-once' })

    // And a repeat asks again.
    put(h.root, 'doomed.txt', 'again')
    h.autoAnswer = true
    h.answers.push('deny')
    await h.call('terminal_execute', { command: 'rm doomed.txt' })
    expect(h.prompts).toHaveLength(3)
  })

  it('Plan mode: the terminal is available but every command asks, and grants are not honoured', async () => {
    h = makeHarness({ mode: 'plan', allowedTools: [...READ_ONLY_TOOLS, 'terminal.execute'] })
    const { AgentRepository } = await import('@ai-workspace/storage')
    new AgentRepository(h.db).addGrant({ workspaceId: h.workspaceId, toolId: 'terminal.execute', risk: 'execution', command: node('console.log(5)') })
    h.answers.push('allow_once')
    await h.call('terminal_execute', { command: node('console.log(5)') })
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0]?.allowedDecisions).toEqual(['allow_once', 'deny'])
  })

  it('Plan mode cannot write: the write and patch tools are refused and audited', async () => {
    h = makeHarness({ mode: 'plan', allowedTools: [...READ_ONLY_TOOLS, 'terminal.execute'] })
    const out = await h.call('filesystem_write', { path: 'x.txt', content: 'x' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/not available/)
    expect(existsSync(join(h.root, 'x.txt'))).toBe(false)
    expect(h.repo.listToolRuns(h.runId).at(-1)).toMatchObject({ toolId: 'filesystem.write', status: 'denied', decisionSource: 'mode-blocked' })
    expect(h.prompts).toHaveLength(0)
  })

  it('a read-only agent in Build mode cannot use the terminal at all', async () => {
    h = makeHarness({ mode: 'build', allowedTools: READ_ONLY_TOOLS })
    const out = await h.call('terminal_execute', { command: 'echo hi' })
    expect(out.isError).toBe(true)
    expect(h.prompts).toHaveLength(0)
  })

  it('an unknown tool name is refused, audited, and cannot reach anything', async () => {
    h = makeHarness()
    const out = await h.call('shell_exec', { command: 'rm -rf /' })
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/no tool named/)
    expect(h.repo.listToolRuns(h.runId).at(-1)).toMatchObject({ status: 'denied', decisionSource: 'mode-blocked' })
  })

  it('times out a long command, kills it, and says so', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    const started = Date.now()
    const out = await h.call('terminal_execute', { command: node('setTimeout(()=>{},60000)'), timeoutSeconds: 1 })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(out.text).toMatch(/TIMED OUT/)
    expect(lastToolRun()).toMatchObject({ status: 'error' })
    expect(lastToolRun()?.summary).toMatch(/timed out/)
  })

  it('cancelling the run mid-command kills it and records it as cancelled', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    const promise = h.call('terminal_execute', { command: node("console.log('started'); setTimeout(()=>{},60000)") })
    await new Promise((r) => setTimeout(r, 1500))
    h.controller.abort()
    const out = await promise
    expect(out.isError).toBe(true)
    expect(out.text).toMatch(/cancelled/)
    expect(lastToolRun()).toMatchObject({ status: 'cancelled' })
  })

  it('cancelling while the permission prompt is open withdraws the prompt and runs nothing', async () => {
    h = makeHarness()
    h.autoAnswer = false
    const promise = h.call('terminal_execute', { command: node("require('fs').writeFileSync('ran.txt','x')") })
    await new Promise((r) => setTimeout(r, 100))
    expect(h.engine.pendingRequests()).toHaveLength(1)
    h.controller.abort()
    const out = await promise
    expect(out.isError).toBe(true)
    expect(existsSync(join(h.root, 'ran.txt'))).toBe(false)
    expect(h.engine.pendingRequests()).toEqual([])
    expect(lastToolRun()).toMatchObject({ status: 'cancelled', decisionSource: 'cancelled' })
  })

  it('streams live output as tool-output events', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    await h.call('terminal_execute', { command: node("console.log('live-chunk-1')") })
    const chunks = h.events.filter((e): e is Extract<AgentEvent, { type: 'tool-output' }> => e.type === 'tool-output')
    expect(chunks.map((c) => c.chunk).join('')).toContain('live-chunk-1')
  })
})

describe('secrets never reach the model, the audit log or the child process', () => {
  it('redacts secrets in command output, in the stored detail, and in the stored input', async () => {
    h = makeHarness()
    h.answers.push('allow_once')
    const command = node(`console.log('token is ${FAKE_KEY}')`)
    const out = await h.call('terminal_execute', { command })
    expect(out.text).not.toContain(FAKE_KEY)
    expect(out.text).toContain('[REDACTED]')
    const row = lastToolRun()
    expect(row?.detail).not.toContain(FAKE_KEY)
    expect(row?.input).not.toContain(FAKE_KEY)
    expect(row?.label).not.toContain(FAKE_KEY)
    // ...but the user's prompt showed the real command, because they must see exactly what will run.
    expect((h.prompts[0]?.preview as { command: string }).command).toContain(FAKE_KEY)
  })

  it('redacts secrets inside a file the model reads (a .env-style assignment in a normal file)', async () => {
    h = makeHarness({ files: { 'config.ts': `export const cfg = {\n  apiKey: '${FAKE_KEY}',\n}\nDATABASE_PASSWORD=hunter2hunter2\n` } })
    const out = await h.call('filesystem_read', { path: 'config.ts' })
    expect(out.text).not.toContain(FAKE_KEY)
    expect(out.text).not.toContain('hunter2hunter2')
    expect(out.text).toContain('export const cfg')
  })

  it('the model sees a redacted diff, while the file on disk keeps the real bytes', async () => {
    h = makeHarness({ files: { 'a.txt': `key = ${FAKE_KEY}\nname = old\n` } })
    h.answers.push('allow_once')
    await h.call('filesystem_read', { path: 'a.txt' })
    const out = await h.call('filesystem_patch', { path: 'a.txt', old_string: 'name = old', new_string: 'name = new' })
    expect(out.isError).toBe(false)
    expect(out.text).not.toContain(FAKE_KEY)
    expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe(`key = ${FAKE_KEY}\nname = new\n`)
  })

  it('the child process does not inherit credential-looking environment variables or known secret values', async () => {
    process.env['AIW_TEST_SERVICE_TOKEN'] = 'visible-if-leaked-1234'
    process.env['AIW_TEST_INNOCENT'] = 'carries-the-provider-key-value-9999 inside'
    try {
      h = makeHarness({ secrets: ['the-provider-key-value-9999'.replace('the-', 'carries-the-')] })
      h.answers.push('allow_once')
      const out = await h.call('terminal_execute', {
        command: node("console.log([process.env.AIW_TEST_SERVICE_TOKEN, process.env.AIW_TEST_INNOCENT, process.env.ELECTRON_RUN_AS_NODE].map(String).join('|'))"),
      })
      expect(out.text).toContain('undefined|undefined|undefined')
    } finally {
      delete process.env['AIW_TEST_SERVICE_TOKEN']
      delete process.env['AIW_TEST_INNOCENT']
    }
  })
})

describe('audit trail', () => {
  it('records every call, in order, with risk, decision source, redacted input and timings', async () => {
    h = makeHarness({ files: { 'src/a.ts': 'const a = 1\n' } })
    h.answers.push('allow_session', 'deny')
    await h.call('filesystem_read', { path: 'src/a.ts' })
    await h.call('filesystem_patch', { path: 'src/a.ts', old_string: 'const a = 1', new_string: 'const a = 2' })
    await h.call('filesystem_search', { query: 'const' })
    await h.call('filesystem_write', { path: 'b.txt', content: 'b' })
    const rows = h.repo.listToolRuns(h.runId)
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(rows.map((r) => [r.toolId, r.risk, r.status, r.decisionSource])).toEqual([
      ['filesystem.read', 'safe', 'ok', 'default-safe'],
      ['filesystem.patch', 'write', 'ok', 'prompt-session'],
      ['filesystem.search', 'safe', 'ok', 'default-safe'],
      ['filesystem.write', 'write', 'denied', 'prompt-deny'],
    ])
    for (const row of rows) {
      expect(row.workspaceId).toBe(h.workspaceId)
      expect(row.conversationId).toBe(h.conversationId)
      expect(row.finishedAt).not.toBeNull()
      expect(row.durationMs).not.toBeNull()
    }
    expect(JSON.parse(rows[1]!.input)).toMatchObject({ path: 'src/a.ts', old_string: 'const a = 1' })
  })

  it('emits a tool event for every state change so the UI can render each row live', async () => {
    h = makeHarness({ files: { 'a.txt': 'x\n' } })
    await h.call('filesystem_read', { path: 'a.txt' })
    const statuses = h.events.filter((e) => e.type === 'tool').map((e) => (e as { toolRun: { status: string } }).toolRun.status)
    expect(statuses).toEqual(['pending', 'running', 'ok'])
  })

  it('a stale or invalid edit is audited as an error without ever asking the user', async () => {
    h = makeHarness({ files: { 'a.txt': 'x\n' } })
    await h.call('filesystem_patch', { path: 'a.txt', old_string: 'x', new_string: 'y' })
    expect(lastToolRun('filesystem.patch')).toMatchObject({ status: 'error', decisionSource: 'not-asked' })
    expect(h.prompts).toHaveLength(0)
  })

  it('recordInvalid logs an SDK-rejected call', () => {
    h = makeHarness()
    h.executor.recordInvalid('filesystem_read', { path: 12 }, 'Invalid input')
    expect(h.repo.listToolRuns(h.runId).at(-1)).toMatchObject({ toolId: 'filesystem.read', status: 'error' })
  })
})

describe('serialization of write/execution calls', () => {
  it('two such calls in one step prompt one after the other, never at the same time', async () => {
    h = makeHarness({ files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } })
    await h.call('filesystem_read', { path: 'a.txt' })
    await h.call('filesystem_read', { path: 'b.txt' })
    h.autoAnswer = false
    const first = h.call('filesystem_patch', { path: 'a.txt', old_string: 'a', new_string: 'A' })
    const second = h.call('filesystem_patch', { path: 'b.txt', old_string: 'b', new_string: 'B' })
    await new Promise((r) => setTimeout(r, 150))
    expect(h.engine.pendingRequests()).toHaveLength(1)
    expect(h.engine.pendingRequests()[0]?.preview).toMatchObject({ path: 'a.txt' })
    h.engine.respond({ requestId: h.engine.pendingRequests()[0]!.requestId, decision: 'allow_once' })
    await first
    await new Promise((r) => setTimeout(r, 150))
    expect(h.engine.pendingRequests()).toHaveLength(1)
    expect(h.engine.pendingRequests()[0]?.preview).toMatchObject({ path: 'b.txt' })
    h.engine.respond({ requestId: h.engine.pendingRequests()[0]!.requestId, decision: 'deny' })
    await second
    expect(readFileSync(join(h.root, 'a.txt'), 'utf8')).toBe('A\n')
    expect(readFileSync(join(h.root, 'b.txt'), 'utf8')).toBe('b\n')
  })

  it('a pending prompt does not stop safe reads in the same run', async () => {
    h = makeHarness({ files: { 'a.txt': 'a\n' } })
    await h.call('filesystem_read', { path: 'a.txt' })
    h.autoAnswer = false
    const pending = h.call('filesystem_patch', { path: 'a.txt', old_string: 'a', new_string: 'A' })
    await new Promise((r) => setTimeout(r, 100))
    const read = await h.call('filesystem_list', {})
    expect(read.isError).toBe(false)
    h.engine.respond({ requestId: h.engine.pendingRequests()[0]!.requestId, decision: 'deny' })
    await pending
  })
})

describe('writes made outside the tools', () => {
  it('a hand-edit after the run does not corrupt anything: snapshots keep the pre-run bytes only', async () => {
    h = makeHarness({ files: { 'a.txt': 'original\n' } })
    h.answers.push('allow_once')
    await h.call('filesystem_read', { path: 'a.txt' })
    await h.call('filesystem_patch', { path: 'a.txt', old_string: 'original', new_string: 'changed' })
    writeFileSync(join(h.root, 'a.txt'), 'user edit\n')
    expect(h.repo.getSnapshot(h.runId, 'a.txt')?.beforeContent?.toString('utf8')).toBe('original\n')
  })
})
