import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENTS, PermissionRequestSchema, TOOL_IDS, effectiveTools } from '../agent'
import { MCP_NAME_PATTERN, SaveMcpServerInputSchema, mcpConfigProblems, mcpToolKey, mcpUrlProblem, mcpWireName } from '../mcp'

const WIRE = /^[A-Za-z0-9_-]{1,64}$/

describe('mcpWireName', () => {
  it('is mcp__<server>__<tool> for ordinary names', () => {
    expect(mcpWireName('files', 'read_file')).toBe('mcp__files__read_file')
    expect(mcpWireName('my-server', 'list-things')).toBe('mcp__my-server__list-things')
  })

  it('replaces characters providers reject, and marks the change with a hash so it cannot collide', () => {
    const dotted = mcpWireName('files', 'read.file')
    const spaced = mcpWireName('files', 'read file')
    const plain = mcpWireName('files', 'read_file')
    expect(dotted).toMatch(WIRE)
    expect(spaced).toMatch(WIRE)
    expect(new Set([dotted, spaced, plain]).size).toBe(3)
  })

  it('is at most 64 characters, deterministic, and distinct for long names that share a prefix', () => {
    const a = mcpWireName('srv', `${'x'.repeat(80)}_a`)
    const b = mcpWireName('srv', `${'x'.repeat(80)}_b`)
    expect(a.length).toBeLessThanOrEqual(64)
    expect(b.length).toBeLessThanOrEqual(64)
    expect(a).not.toBe(b)
    expect(a).toBe(mcpWireName('srv', `${'x'.repeat(80)}_a`))
    expect(a).toMatch(WIRE)
  })

  it('never hands out a name that is already taken', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 5; i += 1) {
      const name = mcpWireName('s', 'same', taken)
      expect(taken.has(name)).toBe(false)
      taken.add(name)
    }
    expect(taken.size).toBe(5)
    for (const name of taken) expect(name).toMatch(WIRE)
  })

  it('handles non-ASCII tool names', () => {
    const name = mcpWireName('s', '検索 tool')
    expect(name).toMatch(WIRE)
    expect(name).not.toBe(mcpWireName('s', '検索  tool'))
  })

  it('the grant key is server/tool', () => {
    expect(mcpToolKey('files', 'read_file')).toBe('files/read_file')
  })
})

describe('server names', () => {
  it.each(['a', 'files', 'my-server-2', '0abc', 'a'.repeat(32)])('accepts %s', (name) => {
    expect(MCP_NAME_PATTERN.test(name)).toBe(true)
  })
  it.each(['', '-a', 'A', 'has_underscore', 'has space', 'a'.repeat(33), 'dot.ted', 'a__b/c'])('rejects %j', (name) => {
    expect(MCP_NAME_PATTERN.test(name)).toBe(false)
  })
})

describe('mcpUrlProblem', () => {
  it.each(['https://mcp.example.com/mcp', 'https://example.com:8443/x?y=1', 'http://localhost:3000/mcp', 'http://127.0.0.1:8080/', 'http://[::1]:9000/mcp', 'http://tools.localhost/mcp'])('accepts %s', (url) => {
    expect(mcpUrlProblem(url)).toBeNull()
  })
  it.each([
    ['', /Enter/],
    ['not a url', /valid URL/],
    ['http://example.com/mcp', /localhost/],
    ['http://192.168.1.5/mcp', /localhost/],
    ['ftp://example.com', /https/],
    ['file:///etc/passwd', /https/],
    ['javascript:alert(1)', /https/],
    ['https://user:pass@example.com/mcp', /user name or password/],
    ['http://localhost.evil.com/mcp', /localhost/],
  ])('rejects %j', (url, message) => {
    expect(mcpUrlProblem(url)).toMatch(message)
  })
})

describe('mcpConfigProblems', () => {
  const stdio = { transport: 'stdio' as const, command: 'node', args: ['server.js'], cwd: null, env: [], url: '', headers: [] }
  const http = { transport: 'http' as const, command: '', args: [], cwd: null, env: [], url: 'https://example.com/mcp', headers: [] }

  it('accepts a plain stdio and http server', () => {
    expect(mcpConfigProblems(stdio)).toEqual([])
    expect(mcpConfigProblems(http)).toEqual([])
  })

  it('requires a non-empty single-line command, and does not look at the url for stdio', () => {
    expect(mcpConfigProblems({ ...stdio, command: '   ' })).toEqual(['Enter the command to run.'])
    expect(mcpConfigProblems({ ...stdio, command: 'node\nrm -rf /' })[0]).toMatch(/single line/)
    expect(mcpConfigProblems({ ...stdio, url: 'not-a-url' })).toEqual([])
  })

  it('treats a command with spaces and shell syntax as one program name (there is no shell)', () => {
    // The point of argv: this is accepted as text and later fails to spawn; it is never interpreted.
    expect(mcpConfigProblems({ ...stdio, command: 'node && calc.exe' })).toEqual([])
  })

  it('validates env names, duplicates and secret entries without a value', () => {
    expect(mcpConfigProblems({ ...stdio, env: [{ key: '1BAD', value: 'x', secret: false }] })[0]).toMatch(/not a valid environment/)
    expect(
      mcpConfigProblems({ ...stdio, env: [{ key: 'A', value: 'x', secret: false }, { key: 'a', value: 'y', secret: false }] })[0],
    ).toMatch(/twice/)
    expect(mcpConfigProblems({ ...stdio, env: [{ key: 'A', value: null, secret: false }] })[0]).toMatch(/needs a value/)
    expect(mcpConfigProblems({ ...stdio, env: [{ key: 'TOKEN', value: null, secret: true }] })).toEqual([])
  })

  it('validates headers and the url for http', () => {
    expect(mcpConfigProblems({ ...http, url: 'http://example.com' })[0]).toMatch(/localhost/)
    expect(mcpConfigProblems({ ...http, headers: [{ key: 'Bad Header', value: 'x', secret: false }] })[0]).toMatch(/not a valid header/)
    expect(mcpConfigProblems({ ...http, headers: [{ key: 'X-A', value: 'a\r\nInjected: 1', secret: false }] })[0]).toMatch(/control character/)
    expect(mcpConfigProblems({ ...http, headers: [{ key: 'Authorization', value: null, secret: true }] })).toEqual([])
  })
})

describe('SaveMcpServerInputSchema', () => {
  it('fills defaults and rejects a bad name or transport', () => {
    const parsed = SaveMcpServerInputSchema.parse({ name: 'files', transport: 'stdio', command: 'node' })
    expect(parsed).toMatchObject({ args: [], cwd: null, env: [], headers: [], enabled: true, url: '' })
    expect(SaveMcpServerInputSchema.safeParse({ name: 'Bad Name', transport: 'stdio' }).success).toBe(false)
    expect(SaveMcpServerInputSchema.safeParse({ name: 'ok', transport: 'carrier-pigeon' }).success).toBe(false)
  })
  it('bounds the number of arguments', () => {
    expect(SaveMcpServerInputSchema.safeParse({ name: 'ok', transport: 'stdio', command: 'x', args: Array.from({ length: 101 }, () => 'a') }).success).toBe(false)
  })
})

describe('mcp.call in the tool layer', () => {
  const agent = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!

  it('is a tool id with a distinct wire name that no server tool can equal', () => {
    expect(TOOL_IDS).toContain('mcp.call')
    expect(mcpWireName('a', 'b')).not.toBe('mcp_call')
  })

  it('MCP tools are Build only, and only for agents whose ceiling is not read-only', () => {
    expect(effectiveTools(agent('implementer'), 'build')).toContain('mcp.call')
    expect(effectiveTools(agent('general'), 'build')).toContain('mcp.call')
    expect(effectiveTools(agent('implementer'), 'plan')).not.toContain('mcp.call')
    expect(effectiveTools(agent('general'), 'plan')).not.toContain('mcp.call')
    for (const id of ['planner', 'repo-analyst', 'reviewer']) {
      expect(effectiveTools(agent(id), 'build')).not.toContain('mcp.call')
      expect(effectiveTools(agent(id), 'plan')).not.toContain('mcp.call')
    }
  })

  it('an agent that does not list mcp.call never gets it, whatever the mode', () => {
    const custom = { allowedTools: ['filesystem.read' as const], permissionCeiling: 'build' as const }
    expect(effectiveTools(custom, 'build')).not.toContain('mcp.call')
  })

  it('a permission request can carry the mcp preview', () => {
    const request = {
      requestId: 'r',
      runId: 'run',
      toolRunId: 't',
      conversationId: 'c',
      workspaceId: 'w',
      toolId: 'mcp.call',
      risk: 'execution',
      allowedDecisions: ['allow_once', 'deny'],
      grantScopeNote: null,
      preview: { kind: 'mcp', server: 'files', tool: 'read', description: 'd', arguments: '{}', argumentsTruncated: false, hints: { readOnly: true, destructive: null, openWorld: null } },
      createdAt: 1,
    }
    expect(PermissionRequestSchema.safeParse(request).success).toBe(true)
  })
})
