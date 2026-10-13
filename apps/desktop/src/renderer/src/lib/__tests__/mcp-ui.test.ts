import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from '@ai-workspace/shared'
import { mcpHintsText, promptHeading, splitLabel, toolCountText } from '../agent-ui'
import { cleanIpcError, connectedSince, draftFromConfig, draftProblems, draftToInput, emptyDraft, hintBadges, parseArgs, serverSummary } from '../mcp-ui'

const config = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'id1',
  name: 'files',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server', 'C:/my docs'],
  cwd: null,
  env: [
    { key: 'LOG', value: 'debug', secret: false },
    { key: 'TOKEN', value: null, secret: true },
  ],
  url: '',
  headers: [],
  enabled: true,
  disabledTools: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('the add / edit draft', () => {
  it('turns a saved server into a draft: one argument per line, secrets with no value but marked as stored', () => {
    const draft = draftFromConfig(config())
    expect(draft.argsText).toBe('-y\nserver\nC:/my docs')
    expect(draft.env).toEqual([
      { key: 'LOG', value: 'debug', secret: false, existing: false },
      { key: 'TOKEN', value: '', secret: true, existing: true },
    ])
  })

  it('an untouched stored secret is sent as "keep" (null); a typed one replaces it; blank keys are dropped', () => {
    const draft = draftFromConfig(config())
    expect(draftToInput(draft).env).toEqual([
      { key: 'LOG', value: 'debug', secret: false },
      { key: 'TOKEN', value: null, secret: true },
    ])
    draft.env[1]!.value = 'new-secret'
    draft.env.push({ key: '  ', value: 'x', secret: false, existing: false })
    expect(draftToInput(draft).env).toEqual([
      { key: 'LOG', value: 'debug', secret: false },
      { key: 'TOKEN', value: 'new-secret', secret: true },
    ])
  })

  it('arguments keep inner spaces, drop empty lines and carriage returns', () => {
    expect(parseArgs('a b\r\n\r\n  \nc')).toEqual(['a b', 'c'])
  })

  it('a stdio draft sends no url or headers, an http draft no command, args or env', () => {
    const stdio = draftToInput({ ...emptyDraft('stdio'), name: 'a', command: 'node', url: 'https://x', headers: [{ key: 'A', value: 'b', secret: false, existing: false }] })
    expect(stdio).toMatchObject({ transport: 'stdio', url: '', headers: [] })
    const http = draftToInput({ ...emptyDraft('http'), name: 'a', url: 'https://x.example/mcp', command: 'node', argsText: 'x', env: [{ key: 'A', value: 'b', secret: false, existing: false }] })
    expect(http).toMatchObject({ transport: 'http', command: '', args: [], env: [], cwd: null })
  })

  it('reports problems in plain words, matching what the main process will check', () => {
    expect(draftProblems(emptyDraft())).toEqual(expect.arrayContaining([expect.stringMatching(/^Name:/), 'Enter the command to run.']))
    expect(draftProblems({ ...emptyDraft(), name: 'ok', command: 'node' })).toEqual([])
    expect(draftProblems({ ...emptyDraft('http'), name: 'ok', url: 'http://example.com' })[0]).toMatch(/localhost/)
    expect(draftProblems({ ...emptyDraft('http'), name: 'ok', url: 'https://example.com', headers: [{ key: 'Authorization', value: '', secret: true, existing: false }] })).toEqual(['Enter a value for the secret "Authorization".'])
    expect(draftProblems({ ...emptyDraft(), name: 'ok', command: 'node', cwd: 'relative' })).toEqual(['The working directory must be an absolute path.'])
    expect(draftProblems({ ...emptyDraft(), name: 'ok', command: 'node', cwd: 'C:\\Users\\me' })).toEqual([])
  })
})

describe('display helpers', () => {
  it('summarises a server in one line', () => {
    expect(serverSummary(config())).toBe('npx -y server C:/my docs')
    expect(serverSummary(config({ transport: 'http', url: 'https://x.example/mcp' }))).toBe('https://x.example/mcp')
  })

  it('shows the server\'s hints as claims, danger only for destructive', () => {
    expect(hintBadges({ readOnly: true, destructive: null, idempotent: null, openWorld: true })).toEqual([
      { label: 'says read-only', tone: 'plain' },
      { label: 'says open-world', tone: 'plain' },
    ])
    expect(hintBadges({ readOnly: false, destructive: true, idempotent: null, openWorld: false })).toEqual([{ label: 'says destructive', tone: 'danger' }])
    expect(hintBadges({ readOnly: null, destructive: null, idempotent: null, openWorld: null })).toEqual([])
  })

  it('strips the IPC wrapper from an error', () => {
    expect(cleanIpcError(new Error("Error invoking remote method 'mcp:save': Error: An MCP server named \"files\" already exists."))).toBe('An MCP server named "files" already exists.')
    expect(cleanIpcError(new Error('plain'))).toBe('plain')
    expect(cleanIpcError('x')).toBe('x')
  })

  it('says when it connected', () => {
    expect(connectedSince({ connectedAt: null })).toBe('–')
    expect(connectedSince({ connectedAt: 1_000_000 - 30_000 }, 1_000_000)).toBe('30s ago')
    expect(connectedSince({ connectedAt: 1_000_000 - 180_000 }, 1_000_000)).toBe('3 min ago')
  })
})

describe('the mcp permission prompt and activity row', () => {
  it('the heading names the server and tool; other tools are unchanged', () => {
    const preview = { kind: 'mcp' as const, server: 'files', tool: 'read', description: '', arguments: '{}', argumentsTruncated: false, hints: { readOnly: null, destructive: null, openWorld: null } }
    expect(promptHeading({ toolId: 'mcp.call', risk: 'execution', preview })).toBe('AGENT REQUESTS · mcp files/read (execution)')
    expect(promptHeading({ toolId: 'mcp.call', risk: 'destructive', preview })).toBe('AGENT REQUESTS · mcp files/read (destructive)')
    expect(promptHeading({ toolId: 'terminal.execute', risk: 'execution' })).toBe('AGENT REQUESTS · run (execution)')
  })

  it('the activity row splits "mcp files/read" into a title and the server/tool', () => {
    expect(splitLabel({ toolId: 'mcp.call', label: 'mcp files/read' })).toEqual({ title: 'mcp', subtitle: 'files/read' })
  })

  it('hints text lists only the claims that are true', () => {
    expect(mcpHintsText({ readOnly: true, destructive: null, openWorld: true })).toBe('read-only, open-world')
    expect(mcpHintsText({ readOnly: false, destructive: null, openWorld: false })).toBe('no hints')
  })

  it('tool counts leave mcp.call out of the number and say "+ MCP" instead', () => {
    expect(toolCountText(['filesystem.read', 'git.status', 'mcp.call'])).toBe('2 tools + MCP')
    expect(toolCountText(['filesystem.read'])).toBe('1 tool')
    expect(toolCountText([])).toBe('0 tools')
  })
})
