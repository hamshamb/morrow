import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_OUTPUT_CHAR_CAP, effectiveTools, BUILTIN_AGENTS } from '@ai-workspace/shared'
import { createMcpToolDefinition } from '../mcp/tool-adapter'
import type { McpToolBinding } from '../mcp/types'
import { makeHarness, type Harness } from './agent-harness'
import { makeMcpBed, stdioServer, type McpTestBed } from './mcp-utils'

/**
 * `mcp.call` through the SAME RunToolExecutor as every other tool, against a real MCP server over real stdio:
 * validate -> assess -> prepare -> permission engine -> run -> audit -> redact -> output cap.
 */

let bed: McpTestBed
let h: Harness | null = null
afterEach(async () => {
  h?.cleanup()
  h = null
  await bed?.cleanup()
})

/** Discovers the tools for a run and builds a harness whose executor can call them. */
async function setup(
  serverNames: string[] = ['fix'],
  options: { secrets?: string[]; commandTimeoutSeconds?: number; allowedTools?: Parameters<typeof makeHarness>[0] extends infer O ? (O extends { allowedTools?: infer A } ? A : never) : never; env?: { key: string; value: string; secret: boolean }[] } = {},
): Promise<McpToolBinding[]> {
  bed = makeMcpBed()
  for (const name of serverNames) bed.config.save(stdioServer(name, options.env ? { env: options.env } : {}))
  const bindings = await bed.manager.discoverRunTools(new AbortController().signal)
  h = makeHarness({
    extraTools: bindings.map((b) => createMcpToolDefinition(b, bed.manager)),
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.commandTimeoutSeconds ? { commandTimeoutSeconds: options.commandTimeoutSeconds } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
  })
  return bindings
}

const rows = () => (h as Harness).repo.listToolRuns((h as Harness).runId)
const lastRow = () => rows().at(-1)!

describe('discovery - which MCP tools a run is given', () => {
  it('offers every enabled server\'s tools as mcp__<server>__<tool>, with unique valid wire names', async () => {
    const bindings = await setup(['fix', 'second'])
    const names = bindings.map((b) => b.wireName)
    expect(names).toContain('mcp__fix__echo')
    expect(names).toContain('mcp__second__echo')
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(bindings.find((b) => b.tool.name === 'weird.name with spaces')?.wireName).toMatch(/^mcp__fix__weird_name_with_spaces_/)
  })

  it('leaves out disabled servers, disabled tools and servers that will not start (the run goes on)', async () => {
    bed = makeMcpBed({ connectTimeoutMs: 5000 })
    const on = bed.config.save(stdioServer('on'))
    bed.config.save(stdioServer('off', { enabled: false }))
    bed.config.save({ name: 'broken', transport: 'stdio', command: 'definitely-not-installed-xyz', args: [] })
    bed.config.setToolEnabled(on.id, 'wipe', false)
    const bindings = await bed.manager.discoverRunTools(new AbortController().signal)
    const servers = new Set(bindings.map((b) => b.serverName))
    expect([...servers]).toEqual(['on'])
    expect(bindings.some((b) => b.tool.name === 'wipe')).toBe(false)
    expect(bindings.some((b) => b.tool.name === 'echo')).toBe(true)
    expect(bed.manager.state(bed.config.list().find((c) => c.name === 'broken')!.id).diagnostics.status).toBe('error')
    expect(bed.manager.state(bed.config.list().find((c) => c.name === 'off')!.id).diagnostics.status).toBe('disabled')
  })

  it('gives the model a JSON Schema as the provider layer needs it (object, properties, no $schema)', async () => {
    const bindings = await setup()
    const echo = bindings.find((b) => b.tool.name === 'echo')!
    const { providerInputSchema } = await import('../mcp/tool-adapter')
    const schema = providerInputSchema(echo.tool.inputSchema as Record<string, unknown>)
    expect(schema).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
    expect('$schema' in schema).toBe(false)
    expect(providerInputSchema({ type: 'object' })).toEqual({ type: 'object', properties: {} })
  })
})

describe('mode gating - effectiveTools', () => {
  it('Plan and read-only ceilings get no MCP tool; Build with a build agent does', () => {
    const agent = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!
    expect(effectiveTools(agent('implementer'), 'build')).toContain('mcp.call')
    expect(effectiveTools(agent('implementer'), 'plan')).not.toContain('mcp.call')
    expect(effectiveTools(agent('planner'), 'build')).not.toContain('mcp.call')
    expect(effectiveTools(agent('reviewer'), 'plan')).not.toContain('mcp.call')
  })

  it('a call to an MCP tool outside the run\'s allowed tools is refused and audited as mode-blocked; the server is never contacted', async () => {
    await setup(['fix'], { allowedTools: ['filesystem.read'] })
    const result = await h!.call('mcp__fix__noisy', {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/not available in the current mode/)
    expect(h!.prompts).toHaveLength(0)
    expect(lastRow()).toMatchObject({ toolId: 'mcp.call', status: 'denied', decisionSource: 'mode-blocked' })
    const stderr = bed.manager.state(bed.config.list()[0]!.id).diagnostics.stderrTail
    expect(stderr.join('\n')).not.toContain('starting noisy work')
  })

  it('a name no discovered tool has is "no such tool", not a lookup of something else', async () => {
    await setup()
    const result = await h!.call('mcp__fix__does_not_exist', {})
    expect(result.text).toMatch(/There is no tool named/)
    expect(h!.prompts).toHaveLength(0)
  })
})

describe('the permission path', () => {
  it('asks before the first call, with the mcp preview; allow once runs it and the audit row says who allowed it', async () => {
    await setup()
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__echo', { text: 'hello' })
    expect(result).toEqual({ text: 'echo: hello', isError: false })

    expect(h!.prompts).toHaveLength(1)
    const request = h!.prompts[0]!
    expect(request).toMatchObject({ toolId: 'mcp.call', risk: 'execution' })
    expect(request.allowedDecisions).toEqual(['allow_once', 'allow_session', 'allow_workspace', 'deny'])
    expect(request.grantScopeNote).toBe('this exact tool (fix/echo)')
    expect(request.preview).toMatchObject({
      kind: 'mcp',
      server: 'fix',
      tool: 'echo',
      description: 'Returns the text it was given.',
      argumentsTruncated: false,
      hints: { readOnly: true, destructive: null, openWorld: null },
    })
    expect(JSON.parse((request.preview as { arguments: string }).arguments)).toEqual({ text: 'hello' })

    expect(lastRow()).toMatchObject({
      toolId: 'mcp.call',
      risk: 'execution',
      label: 'mcp fix/echo',
      status: 'ok',
      decisionSource: 'prompt-once',
    })
    expect(JSON.parse(lastRow().input)).toEqual({ text: 'hello' })
    expect(lastRow().detail).toBe('echo: hello')
  })

  it('readOnlyHint never lowers the risk: a tool that calls itself read-only still asks', async () => {
    await setup()
    h!.answers.push('deny')
    const result = await h!.call('mcp__fix__liar', {})
    expect(h!.prompts).toHaveLength(1)
    expect(h!.prompts[0]?.risk).toBe('execution')
    expect(h!.prompts[0]?.preview).toMatchObject({ hints: { readOnly: true, openWorld: true } })
    expect(result.isError).toBe(true)
  })

  it('a tool with no hints at all is execution, and asks', async () => {
    await setup()
    h!.answers.push('allow_once')
    await h!.call('mcp__fix__cwd', {})
    expect(h!.prompts[0]).toMatchObject({ risk: 'execution' })
    expect(h!.prompts[0]?.preview).toMatchObject({ hints: { readOnly: null, destructive: null, openWorld: null } })
  })

  it('deny: the model is told, the server is never called, the audit row records the denial', async () => {
    await setup()
    h!.answers.push('deny')
    const result = await h!.call('mcp__fix__noisy', {})
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/DENIED/)
    expect(lastRow()).toMatchObject({ status: 'denied', decisionSource: 'prompt-deny' })
    await new Promise((r) => setTimeout(r, 200))
    expect(bed.manager.state(bed.config.list()[0]!.id).diagnostics.stderrTail.join('\n')).not.toContain('starting noisy work')
  })

  it('a session grant covers that exact server/tool only', async () => {
    await setup(['fix', 'second'])
    h!.answers.push('allow_session')
    await h!.call('mcp__fix__echo', { text: 'a' })
    expect(h!.prompts).toHaveLength(1)

    await h!.call('mcp__fix__echo', { text: 'b' }) // same server + tool: covered
    expect(h!.prompts).toHaveLength(1)
    expect(lastRow().decisionSource).toBe('session-grant')

    h!.answers.push('allow_once')
    await h!.call('mcp__fix__add', { a: 1, b: 2 }) // same server, other tool: asks
    expect(h!.prompts).toHaveLength(2)
    h!.answers.push('allow_once')
    await h!.call('mcp__second__echo', { text: 'c' }) // other server, same tool name: asks
    expect(h!.prompts).toHaveLength(3)
    expect(h!.prompts[2]?.preview).toMatchObject({ kind: 'mcp', server: 'second', tool: 'echo' })
  })

  it('a workspace grant is stored keyed by server/tool, listed, and revocable', async () => {
    await setup()
    h!.answers.push('allow_workspace')
    await h!.call('mcp__fix__echo', { text: 'a' })
    const grants = h!.engine.listGrants(h!.workspaceId)
    expect(grants).toHaveLength(1)
    expect(grants[0]).toMatchObject({ toolId: 'mcp.call', risk: 'execution', command: 'fix/echo', scope: 'workspace' })

    await h!.call('mcp__fix__echo', { text: 'b' })
    expect(h!.prompts).toHaveLength(1)
    expect(lastRow().decisionSource).toBe('workspace-grant')

    h!.engine.revokeGrant(grants[0]!.id)
    h!.answers.push('deny')
    await h!.call('mcp__fix__echo', { text: 'c' })
    expect(h!.prompts).toHaveLength(2)
  })

  it('destructiveHint raises the risk: asks every time, allow once or deny only, any other answer or stored grant is refused', async () => {
    await setup()
    h!.answers.push('allow_once')
    const first = await h!.call('mcp__fix__wipe', { target: 'tmp' })
    expect(first.text).toBe('wiped tmp')
    const request = h!.prompts[0]!
    expect(request.risk).toBe('destructive')
    expect(request.allowedDecisions).toEqual(['allow_once', 'deny'])
    expect(request.grantScopeNote).toBeNull()
    expect(request.preview).toMatchObject({ kind: 'mcp', hints: { destructive: true, readOnly: false, openWorld: false } })
    expect(lastRow()).toMatchObject({ risk: 'destructive', decisionSource: 'prompt-once' })

    // A forged "allow for the session" answer is refused while the prompt stays open.
    h!.autoAnswer = false
    const pending = h!.call('mcp__fix__wipe', { target: 'again' })
    await new Promise((r) => setTimeout(r, 100))
    const open = h!.engine.pendingRequests()[0]!
    expect(h!.engine.respond({ requestId: open.requestId, decision: 'allow_session' })).toMatchObject({ ok: false })
    expect(h!.engine.respond({ requestId: open.requestId, decision: 'allow_workspace' })).toMatchObject({ ok: false })
    expect(h!.engine.respond({ requestId: open.requestId, decision: 'allow_once' })).toEqual({ ok: true, reason: null })
    expect((await pending).isError).toBe(false)
    expect(h!.prompts).toHaveLength(2)

    // A workspace grant row planted by hand does not satisfy a destructive call either.
    h!.db.prepare("INSERT INTO permission_grants (id, workspace_id, tool_id, risk, command, created_at) VALUES ('forged', ?, 'mcp.call', 'destructive', 'fix/wipe', 1)").run(h!.workspaceId)
    h!.autoAnswer = true
    h!.answers.push('deny')
    await h!.call('mcp__fix__wipe', { target: 'third' })
    expect(h!.prompts).toHaveLength(3)
  })
})

describe('arguments', () => {
  it('are validated as an object with the schema\'s required properties and primitive types before anything is asked', async () => {
    await setup()
    const missing = await h!.call('mcp__fix__echo', {})
    expect(missing.isError).toBe(true)
    expect(missing.text).toMatch(/missing required argument "text"/)
    const wrongType = await h!.call('mcp__fix__echo', { text: 42 })
    expect(wrongType.text).toMatch(/argument "text" must be string/)
    const notObject = await h!.call('mcp__fix__echo', ['text'])
    expect(notObject.isError).toBe(true)
    expect(h!.prompts).toHaveLength(0)
    expect(rows().map((r) => [r.status, r.decisionSource])).toEqual([
      ['error', 'not-asked'],
      ['error', 'not-asked'],
      ['error', 'not-asked'],
    ])
  })

  it('the preview shows the arguments as pretty JSON, redacted, and truncated at 20 000 characters', async () => {
    await setup()
    h!.answers.push('deny', 'deny')
    await h!.call('mcp__fix__echo', { text: 'my key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ok' })
    const small = (h!.prompts[0]!.preview as { arguments: string }).arguments
    expect(small).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(small).toContain('[REDACTED]')
    expect(small.startsWith('{\n  "text":')).toBe(true)

    await h!.call('mcp__fix__echo', { text: 'z'.repeat(50_000) })
    const preview = h!.prompts[1]!.preview as { arguments: string; argumentsTruncated: boolean }
    expect(preview.argumentsTruncated).toBe(true)
    expect(preview.arguments.length).toBeLessThan(20_200)
    expect(preview.arguments).toContain('more characters not shown')
  })

  it('what the server says about a tool cannot disguise the prompt: control and bidi characters are stripped', async () => {
    bed = makeMcpBed()
    const binding: McpToolBinding = {
      wireName: 'mcp__evil__t',
      serverId: 'x',
      serverName: 'evil',
      tool: { name: 't', description: 'safe‮ looking\u0000 text​', inputSchema: { type: 'object', properties: {} } },
    }
    h = makeHarness({ extraTools: [createMcpToolDefinition(binding, bed.manager)] })
    h.answers.push('deny')
    await h.call('mcp__evil__t', {})
    expect((h.prompts[0]!.preview as { description: string }).description).toBe('safe looking text')
  })

  it('a tool NAME with bidi / control characters is displayed cleaned, but the grant key stays the exact name', async () => {
    bed = makeMcpBed()
    const binding: McpToolBinding = {
      wireName: 'mcp__evil__t',
      serverId: 'x',
      serverName: 'evil',
      tool: { name: 'read‮_only', description: 'd', inputSchema: { type: 'object', properties: {} } },
    }
    h = makeHarness({ extraTools: [createMcpToolDefinition(binding, bed.manager)] })
    h.answers.push('allow_workspace')
    await h.call('mcp__evil__t', {}).catch(() => undefined)
    expect(h.prompts[0]!.preview).toMatchObject({ server: 'evil', tool: 'read_only' })
    expect(h.prompts[0]!.grantScopeNote).toBe('this exact tool (evil/read_only)')
    expect(h.repo.listToolRuns(h.runId)[0]?.label).toBe('mcp evil/read_only')
    expect(h.engine.listGrants(h.workspaceId)[0]?.command).toBe('evil/read‮_only')
  })
})

describe('results', () => {
  it('a tool error from the server is an error result for the model and an error row in the audit log', async () => {
    await setup()
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__fail', { reason: 'disk on fire' })
    expect(result).toEqual({ text: 'boom: disk on fire', isError: true })
    expect(lastRow()).toMatchObject({ status: 'error', decisionSource: 'prompt-once', summary: 'tool error' })
  })

  it('structuredContent is shown as pretty JSON when the server said nothing in prose', async () => {
    await setup()
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__add', { a: 2, b: 40 })
    expect(JSON.parse(result.text)).toEqual({ sum: 42 })
  })

  it('images, audio and binary resources are replaced by a placeholder; text, links and embedded text come through', async () => {
    await setup()
    h!.answers.push('allow_once')
    const { text } = await h!.call('mcp__fix__mixed', {})
    const lines = text.split('\n')
    expect(lines[0]).toBe('first block')
    expect(lines[1]).toMatch(/^\[image omitted: image\/png, 10 bytes\]$/)
    expect(lines[2]).toMatch(/^\[audio omitted: audio\/wav, 10 bytes\]$/)
    expect(lines[3]).toBe('embedded text resource')
    expect(lines[4]).toMatch(/^\[binary resource omitted: blob:\/\/inline, application\/octet-stream, 10 bytes\]$/)
    expect(lines[5]).toBe('notes://readme')
    expect(text).not.toContain('iVBOR')
  })

  it('output is capped at the shared limit, in the model\'s result and in the audit detail', async () => {
    await setup()
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__big', { chars: 200_000 })
    expect(result.text.length).toBeLessThan(TOOL_OUTPUT_CHAR_CAP + 200)
    expect(result.text).toContain('[output truncated: 170,000 more characters]')
    expect(lastRow().detail!.length).toBeLessThan(TOOL_OUTPUT_CHAR_CAP + 200)
  })

  it('secrets in a result are redacted before the model, the audit log or the stream sees them', async () => {
    await setup(['fix'], { secrets: ['exact-known-secret-value'] })
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__secret_echo', {})
    expect(result.text).toContain('the token is [REDACTED] ok')
    expect(result.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(lastRow().detail).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(JSON.stringify(h!.events)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('hostile text in a result is data: returned as the result, executes nothing, asks for nothing extra', async () => {
    await setup()
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__hostile', {})
    expect(result.isError).toBe(false)
    expect(result.text).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(h!.prompts).toHaveLength(1)
    expect(rows()).toHaveLength(1)
  })
})

describe('cancel and timeout', () => {
  it('cancelling the run while a call is in flight stops it, tells the server, and audits it as cancelled', async () => {
    await setup()
    h!.answers.push('allow_once')
    const pending = h!.call('mcp__fix__slow', { ms: 30_000 })
    for (let i = 0; i < 100 && rows().at(-1)?.status !== 'running'; i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(lastRow().status).toBe('running')
    h!.controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(lastRow().status).toBe('cancelled')
    const id = bed.config.list()[0]!.id
    for (let i = 0; i < 60 && !bed.manager.state(id).diagnostics.stderrTail.includes('fixture: slow was cancelled'); i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(bed.manager.state(id).diagnostics.stderrTail).toContain('fixture: slow was cancelled')
  })

  it('cancelling while the permission prompt is open never calls the server', async () => {
    await setup()
    h!.autoAnswer = false
    const pending = h!.call('mcp__fix__noisy', {})
    await new Promise((r) => setTimeout(r, 100))
    expect(h!.engine.pendingRequests()).toHaveLength(1)
    h!.controller.abort()
    h!.engine.cancelRun(h!.runId)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(lastRow().status).toBe('cancelled')
  })

  it('a call that outlasts the command timeout fails with a clear message', async () => {
    await setup(['fix'], { commandTimeoutSeconds: 1 })
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__slow', { ms: 30_000 })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/did not answer within 1 s/)
    expect(lastRow().status).toBe('error')
  })

  it('a tool switched off after discovery cannot be called', async () => {
    await setup()
    bed.config.setToolEnabled(bed.config.list()[0]!.id, 'echo', false)
    h!.answers.push('allow_once')
    const result = await h!.call('mcp__fix__echo', { text: 'x' })
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/switched off/)
  })

  it('a server that crashed between calls is reconnected for the next call', async () => {
    await setup()
    h!.answers.push('allow_once', 'allow_once', 'allow_once')
    await h!.call('mcp__fix__crash', {})
    for (let i = 0; i < 100 && bed.manager.state(bed.config.list()[0]!.id).diagnostics.status === 'connected'; i += 1) await new Promise((r) => setTimeout(r, 50))
    const result = await h!.call('mcp__fix__echo', { text: 'back' })
    expect(result).toEqual({ text: 'echo: back', isError: false })
  })
})
