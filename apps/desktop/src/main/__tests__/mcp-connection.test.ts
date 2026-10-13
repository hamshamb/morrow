import { homedir, tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import type { McpEvent } from '@ai-workspace/shared'
import { processAlive } from '../mcp/connection'
import { readResourceAttachments } from '../mcp/resource-attachments'
import { FIXTURE_STDIO, makeMcpBed, startHttpFixture, startLegacySseFixture, stdioServer, type HttpFixture, type McpTestBed } from './mcp-utils'
import { FIXTURE_SERVER_NAME, FIXTURE_SERVER_VERSION } from './fixtures/mcp-fixture-server.mjs'

/**
 * The connection layer through the REAL MCP SDK over REAL transports: a child process speaking JSON-RPC on stdio, and
 * an in-process streamable-HTTP server. Nothing about the protocol is mocked.
 */

let bed: McpTestBed
let http: HttpFixture | null = null
afterEach(async () => {
  await bed?.cleanup()
  await http?.close()
  http = null
})

const controller = (): AbortSignal => new AbortController().signal
const callOpts = (timeoutMs = 20_000) => ({ signal: controller(), timeoutMs })
const text = (result: { content?: unknown }): string => JSON.stringify(result.content)

describe('stdio: connect, diagnostics, tools, resources', () => {
  it('connects lazily: nothing is spawned until test/use, then diagnostics describe the handshake', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    expect(bed.manager.state(saved.id).diagnostics).toMatchObject({ status: 'disconnected', pid: null, toolCount: 0 })

    const diagnostics = await bed.manager.test(saved.id)
    expect(diagnostics).toMatchObject({
      status: 'connected',
      lastError: null,
      serverInfo: { name: FIXTURE_SERVER_NAME, version: FIXTURE_SERVER_VERSION, title: 'Fixture server' },
      transportUsed: 'stdio',
    })
    expect(diagnostics.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(diagnostics.toolCount).toBeGreaterThanOrEqual(14)
    expect(diagnostics.resourceCount).toBe(4)
    expect(diagnostics.connectedAt).toBeGreaterThan(0)
    expect(diagnostics.pid).toBeGreaterThan(0)
    expect(diagnostics.stderrTail).toContain('fixture: ready')
    const kinds = bed.events.map((e) => (e as McpEvent).type)
    expect(kinds).toContain('status')
  })

  it('lists tools with hints and wire names, and the enable switch', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    await bed.manager.test(saved.id)
    const tools = await bed.manager.tools(saved.id)
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    expect(byName['echo']).toMatchObject({ enabled: true, wireName: 'mcp__fix__echo', hints: { readOnly: true, destructive: null } })
    expect(byName['wipe']?.hints).toMatchObject({ destructive: true, readOnly: false, openWorld: false })
    // A name providers reject is sanitised and disambiguated, never dropped.
    expect(byName['weird.name with spaces']?.wireName).toMatch(/^mcp__fix__weird_name_with_spaces_[0-9a-z]+$/)
    expect(new Set(tools.map((t) => t.wireName)).size).toBe(tools.length)
    const after = await bed.manager.setToolEnabled(saved.id, 'wipe', false)
    expect(after.find((t) => t.name === 'wipe')?.enabled).toBe(false)
  })

  it('calls a tool; structuredContent and isError come back as the server sent them', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    const echo = await bed.manager.callTool(saved.id, 'echo', { text: 'hi' }, callOpts())
    expect(text(echo)).toContain('echo: hi')
    const add = await bed.manager.callTool(saved.id, 'add', { a: 2, b: 3 }, callOpts())
    expect(add.structuredContent).toEqual({ sum: 5 })
    const fail = await bed.manager.callTool(saved.id, 'fail', { reason: 'x' }, callOpts())
    expect(fail.isError).toBe(true)
  })

  it('lists and reads resources (text and binary)', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    const resources = await bed.manager.resources(saved.id)
    expect(resources.map((r) => r.uri).sort()).toEqual(['blob://logo', 'file:///project/docs/todo.txt', 'notes://huge', 'notes://readme'])
    expect(resources.find((r) => r.uri === 'notes://readme')).toMatchObject({ name: 'readme', title: 'Readme', mimeType: 'text/markdown' })
    const read = await bed.manager.readResource(saved.id, 'notes://readme')
    expect(read.contents[0]?.text).toContain('Fixture readme')
    const blob = await bed.manager.readResource(saved.id, 'blob://logo')
    expect(blob.contents[0]?.blob).toBeTruthy()
  })

  it('resources become attachments through the real server: text kept, binary and oversized refused with a reason, unlisted URIs never requested', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    const result = await readResourceAttachments(bed.manager, saved.id, ['notes://readme', 'file:///project/docs/todo.txt', 'blob://logo', 'notes://huge', 'notes://secret-not-listed'], (t) => t)
    expect(result.attachments.map((a) => [a.filename, a.mimeType])).toEqual([
      ['readme.md', 'text/markdown'],
      ['todo.txt', 'text/plain'],
    ])
    expect(result.attachments[0]?.content).toContain('Hello from the MCP fixture.')
    const reasons = Object.fromEntries(result.rejected.map((r) => [r.filename, r.reason]))
    expect(reasons['logo.txt']).toMatch(/^binary content \(application\/octet-stream, 10 bytes\)/)
    expect(reasons['huge.txt']).toMatch(/^too large \(\d+ kB, max 512 kB\)$/)
    expect(reasons['notes://secret-not-listed']).toBe('the server does not list this resource')
  })

  it('a disabled server is never connected and its tools are not listed', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix', { enabled: false }))
    expect((await bed.manager.test(saved.id)).status).toBe('disabled')
    expect(await bed.manager.tools(saved.id)).toEqual([])
    await expect(bed.manager.callTool(saved.id, 'echo', { text: 'x' }, callOpts())).rejects.toThrow(/disabled/)
    expect(bed.manager.state(saved.id).diagnostics.pid).toBeNull()
  })
})

describe('stdio: environment and working directory', () => {
  it('passes the configured and secret variables, and nothing else from the parent environment', async () => {
    process.env['MORROW_TEST_PARENT_SECRET'] = 'parent-only-value-9999'
    process.env['GITHUB_TOKEN'] = 'ghp_parent_token_that_must_not_leak_1234567890'
    try {
      bed = makeMcpBed()
      const saved = bed.config.save(
        stdioServer('fix', {
          env: [
            { key: 'PLAIN_SETTING', value: 'visible', secret: false },
            { key: 'MY_API_KEY', value: 'sk-secret-from-config-0000', secret: true },
          ],
        }),
      )
      const read = async (name: string): Promise<string> => text(await bed.manager.callTool(saved.id, 'env', { name }, callOpts()))
      expect(await read('PLAIN_SETTING')).toContain('PLAIN_SETTING=visible')
      expect(await read('MY_API_KEY')).toContain('MY_API_KEY=sk-secret-from-config-0000')
      expect(await read('MORROW_TEST_PARENT_SECRET')).toContain('(unset)')
      expect(await read('GITHUB_TOKEN')).toContain('(unset)')
      // PATH is inherited (the program has to find its tools).
      expect(await read('PATH')).not.toContain('(unset)')
    } finally {
      delete process.env['MORROW_TEST_PARENT_SECRET']
      delete process.env['GITHUB_TOKEN']
    }
  })

  it('starts in the user home by default, never the app directory, and honours an explicit cwd', async () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('home'))
    const home = JSON.parse(text(await bed.manager.callTool(a.id, 'cwd', {}, callOpts()))) as { text: string }[]
    expect(home[0]?.text.toLowerCase()).toBe(homedir().toLowerCase())
    const b = bed.config.save(stdioServer('tmp', { cwd: tmpdir() }))
    const tmp = JSON.parse(text(await bed.manager.callTool(b.id, 'cwd', {}, callOpts()))) as { text: string }[]
    expect(tmp[0]?.text.toLowerCase().replace(/\\/g, '/')).toContain(tmpdir().toLowerCase().replace(/\\/g, '/').replace(/\/$/, ''))
  })

  it('a working directory that does not exist is a clear error, not a spawn in the wrong place', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('gone', { cwd: tmpdir() + '/definitely-not-a-real-dir-xyz' }))
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.lastError).toMatch(/working directory does not exist/)
  })
})

describe('stdio: stderr and failures', () => {
  it('captures stderr into a bounded tail and redacts secret-looking text', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix', { env: [{ key: 'MY_SECRET', value: 'configured-secret-value', secret: true }] }))
    await bed.manager.callTool(saved.id, 'noisy', {}, callOpts())
    await new Promise((r) => setTimeout(r, 200))
    const tail = bed.manager.state(saved.id).diagnostics.stderrTail
    expect(tail).toContain('fixture: starting noisy work')
    const keyLine = tail.find((line) => line.includes('using key'))
    expect(keyLine).toBeDefined()
    expect(keyLine).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789')
    expect(keyLine).toContain('[REDACTED]')
  })

  it('redacts the exact configured secret if the server prints it', async () => {
    bed = makeMcpBed()
    // The fixture prints the variable it is asked for on stderr via the env tool? It does not - so use a program that does.
    const saved = bed.config.save({
      name: 'printer',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', "console.error('token is ' + process.env.MY_TOKEN); setTimeout(() => process.exit(1), 50)"],
      env: [{ key: 'MY_TOKEN', value: 'plain-looking-but-secret', secret: true }],
    })
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.stderrTail.join('\n')).toContain('token is [REDACTED]')
    expect(JSON.stringify(d)).not.toContain('plain-looking-but-secret')
  })

  it('keeps only the last 200 stderr lines', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save({
      name: 'chatty',
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', "for (let i = 0; i < 500; i++) console.error('line ' + i); setTimeout(() => process.exit(1), 100)"],
    })
    const d = await bed.manager.test(saved.id)
    expect(d.stderrTail.length).toBe(200)
    expect(d.stderrTail.at(-1)).toBe('line 499')
    expect(d.stderrTail[0]).toBe('line 300')
  })

  it('a program that does not exist reports so, in words', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save({ name: 'nope', transport: 'stdio', command: 'definitely-not-installed-xyz', args: [] })
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.lastError).toMatch(/was not found/)
    expect(d.pid).toBeNull()
  })

  it('a server that exits during startup is an error with its stderr available', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('quitter', { env: [{ key: 'FIXTURE_EXIT_AT_START', value: '1', secret: false }] }))
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.lastError).toMatch(/ended before it finished starting/)
    expect(d.stderrTail.join('\n')).toContain('refusing to start')
  })

  it('a server that never answers the handshake times out, is reported, and its process is killed', async () => {
    bed = makeMcpBed({ connectTimeoutMs: 1500 })
    const saved = bed.config.save(stdioServer('hang', { env: [{ key: 'FIXTURE_HANG_AT_START', value: '1', secret: false }] }))
    const started = Date.now()
    const d = await bed.manager.test(saved.id)
    expect(Date.now() - started).toBeLessThan(12_000)
    expect(d.status).toBe('error')
    expect(d.lastError).toMatch(/Timed out/)
    expect(d.stderrTail.join('\n')).toContain('hanging before the handshake')
  })
})

describe('lifecycle: crash, reconnect, close', () => {
  it('reconnects on next use after the server process dies', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    expect(text(await bed.manager.callTool(saved.id, 'echo', { text: 'one' }, callOpts()))).toContain('echo: one')
    const firstPid = bed.manager.state(saved.id).diagnostics.pid as number
    await bed.manager.callTool(saved.id, 'crash', {}, callOpts())
    // The process exits shortly after answering.
    for (let i = 0; i < 100 && bed.manager.state(saved.id).diagnostics.status === 'connected'; i += 1) await new Promise((r) => setTimeout(r, 50))
    const down = bed.manager.state(saved.id).diagnostics
    expect(down.status).toBe('error')
    expect(down.lastError).toMatch(/closed unexpectedly/)
    expect(processAlive(firstPid)).toBe(false)

    expect(text(await bed.manager.callTool(saved.id, 'echo', { text: 'two' }, callOpts()))).toContain('echo: two')
    const up = bed.manager.state(saved.id).diagnostics
    expect(up.status).toBe('connected')
    expect(up.pid).not.toBe(firstPid)
    expect(up.lastError).toBeNull()
  })

  it('a tool list change notification refreshes that server\'s tools', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    const before = await bed.manager.tools(saved.id)
    expect(before.some((t) => t.name === 'extra')).toBe(false)
    await bed.manager.callTool(saved.id, 'grow', {}, callOpts())
    for (let i = 0; i < 60 && !(await bed.manager.tools(saved.id)).some((t) => t.name === 'extra'); i += 1) await new Promise((r) => setTimeout(r, 100))
    const after = await bed.manager.tools(saved.id)
    expect(after.some((t) => t.name === 'extra')).toBe(true)
    expect(after.length).toBe(before.length + 1)
  })

  it('invalidate (an edit) and closeAll end the child process', async () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('a'))
    const b = bed.config.save(stdioServer('b'))
    await bed.manager.test(a.id)
    await bed.manager.test(b.id)
    const pidA = bed.manager.state(a.id).diagnostics.pid as number
    const pidB = bed.manager.state(b.id).diagnostics.pid as number
    expect(processAlive(pidA) && processAlive(pidB)).toBe(true)
    await bed.manager.invalidate(a.id)
    expect(processAlive(pidA)).toBe(false)
    expect(bed.manager.state(a.id).diagnostics.status).toBe('disconnected')
    await bed.manager.closeAll()
    expect(processAlive(pidB)).toBe(false)
  })

  it('killAllSync (app quit) kills every server process at once', async () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('a'))
    await bed.manager.test(a.id)
    const pid = bed.manager.state(a.id).diagnostics.pid as number
    bed.manager.killAllSync()
    for (let i = 0; i < 40 && processAlive(pid); i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(processAlive(pid)).toBe(false)
  })

  it('cancelling a call sends the cancellation to the server', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    await bed.manager.test(saved.id)
    const abort = new AbortController()
    const pending = bed.manager.callTool(saved.id, 'slow', { ms: 30_000 }, { signal: abort.signal, timeoutMs: 60_000 })
    await new Promise((r) => setTimeout(r, 300))
    abort.abort()
    await expect(pending).rejects.toThrow()
    for (let i = 0; i < 60 && !bed.manager.state(saved.id).diagnostics.stderrTail.includes('fixture: slow was cancelled'); i += 1) await new Promise((r) => setTimeout(r, 50))
    expect(bed.manager.state(saved.id).diagnostics.stderrTail).toContain('fixture: slow was cancelled')
  })

  it('a call that exceeds its timeout rejects', async () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('fix'))
    await expect(bed.manager.callTool(saved.id, 'slow', { ms: 30_000 }, { signal: controller(), timeoutMs: 500 })).rejects.toThrow(/timed out/i)
  })
})

describe('streamable HTTP', () => {
  it('connects over HTTP, sends the secret header, and never reports it', async () => {
    http = await startHttpFixture({ requireAuth: 'Bearer http-secret-token-0123456789' })
    bed = makeMcpBed()
    const saved = bed.config.save({
      name: 'remote',
      transport: 'http',
      url: http.url,
      headers: [{ key: 'Authorization', value: 'Bearer http-secret-token-0123456789', secret: true }],
    })
    const d = await bed.manager.test(saved.id)
    expect(d).toMatchObject({ status: 'connected', transportUsed: 'streamable-http', serverInfo: { name: FIXTURE_SERVER_NAME } })
    expect(d.toolCount).toBeGreaterThan(10)
    expect(http.seenAuth.every((h) => h === 'Bearer http-secret-token-0123456789')).toBe(true)
    expect(text(await bed.manager.callTool(saved.id, 'echo', { text: 'over http' }, callOpts()))).toContain('echo: over http')
    expect(JSON.stringify(bed.manager.states())).not.toContain('http-secret-token')
  })

  it('a 401 is explained, without echoing the header', async () => {
    http = await startHttpFixture({ requireAuth: 'Bearer right' })
    bed = makeMcpBed()
    const saved = bed.config.save({
      name: 'remote',
      transport: 'http',
      url: http.url,
      headers: [{ key: 'Authorization', value: 'Bearer wrong-value-123456', secret: true }],
    })
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.lastError).toMatch(/401|Unauthorized/)
    expect(JSON.stringify(d)).not.toContain('wrong-value-123456')
  })

  it('falls back to the older HTTP+SSE transport when the server answers the first POST with 405', async () => {
    http = await startLegacySseFixture()
    bed = makeMcpBed()
    const saved = bed.config.save({ name: 'legacy', transport: 'http', url: http.url })
    const d = await bed.manager.test(saved.id)
    expect(d).toMatchObject({ status: 'connected', transportUsed: 'sse' })
    expect(text(await bed.manager.callTool(saved.id, 'echo', { text: 'via sse' }, callOpts()))).toContain('echo: via sse')
  })

  it('an unreachable server is an error, not a hang', async () => {
    bed = makeMcpBed({ connectTimeoutMs: 3000 })
    const saved = bed.config.save({ name: 'dead', transport: 'http', url: 'http://127.0.0.1:9/mcp' })
    const d = await bed.manager.test(saved.id)
    expect(d.status).toBe('error')
    expect(d.lastError).toBeTruthy()
  })
})

describe('the fixture itself', () => {
  it('is where the tests think it is', () => {
    expect(FIXTURE_STDIO).toMatch(/mcp-echo-server\.mjs$/)
  })
})
