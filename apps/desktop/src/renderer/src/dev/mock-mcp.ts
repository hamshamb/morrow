import type { McpDiagnostics, McpEvent, McpResourceInfo, McpServerConfig, McpServerState, McpToolInfo, RendererApi, SaveMcpServerInput } from '@ai-workspace/shared'

/**
 * Dev-only MCP surface for `pnpm dev:renderer` (a browser tab, no Electron): fixture servers and an in-memory
 * save / enable / test cycle, so Settings -> MCP can be looked at without a main process. Nothing here talks to a real
 * server - the real behaviour is exercised by the unit tests and the Playwright suite.
 */

const now = Date.now()
const CONNECTED: McpDiagnostics = {
  serverId: 'mock-files',
  status: 'connected',
  lastError: null,
  serverInfo: { name: 'mcp-fixture', version: '9.9.9', title: 'Fixture server' },
  protocolVersion: '2025-11-25',
  transportUsed: 'stdio',
  toolCount: 3,
  resourceCount: 2,
  connectedAt: now - 95_000,
  stderrTail: ['fixture: ready', 'fixture: listening on stdio'],
  pid: 4242,
}

const TOOLS: McpToolInfo[] = [
  { name: 'read_file', title: null, description: 'Read the text of a file inside the allowed folder.', hints: { readOnly: true, destructive: null, idempotent: null, openWorld: false }, enabled: true, wireName: 'mcp__files__read_file' },
  { name: 'write_file', title: null, description: 'Create or overwrite a file inside the allowed folder.', hints: { readOnly: false, destructive: null, idempotent: null, openWorld: false }, enabled: true, wireName: 'mcp__files__write_file' },
  { name: 'delete_file', title: null, description: 'Delete a file. Cannot be undone.', hints: { readOnly: false, destructive: true, idempotent: null, openWorld: false }, enabled: false, wireName: 'mcp__files__delete_file' },
]

const RESOURCES: McpResourceInfo[] = [
  { uri: 'file:///project/README.md', name: 'README', title: 'Project readme', description: null, mimeType: 'text/markdown', size: 1204 },
  { uri: 'file:///project/docs/todo.txt', name: 'todo', title: null, description: null, mimeType: 'text/plain', size: 88 },
]

export function createMockMcpApi(): Pick<RendererApi, 'mcp'> {
  const configs: McpServerConfig[] = [
    {
      id: 'mock-files',
      name: 'files',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/projects'],
      cwd: null,
      env: [{ key: 'LOG_LEVEL', value: 'info', secret: false }],
      url: '',
      headers: [],
      enabled: true,
      disabledTools: ['delete_file'],
      createdAt: now - 86_400_000,
      updatedAt: now - 86_400_000,
    },
    {
      id: 'mock-remote',
      name: 'search',
      transport: 'http',
      command: '',
      args: [],
      cwd: null,
      env: [],
      url: 'https://mcp.example.com/mcp',
      headers: [{ key: 'Authorization', value: null, secret: true }],
      enabled: true,
      disabledTools: [],
      createdAt: now - 3_600_000,
      updatedAt: now - 3_600_000,
    },
  ]
  const diagnostics = new Map<string, McpDiagnostics>([
    ['mock-files', CONNECTED],
    [
      'mock-remote',
      { ...CONNECTED, serverId: 'mock-remote', status: 'error', lastError: 'The server answered 401 Unauthorized. Add or fix an Authorization header (OAuth login is not supported).', serverInfo: null, protocolVersion: null, transportUsed: null, toolCount: 0, resourceCount: 0, connectedAt: null, stderrTail: [], pid: null },
    ],
  ])
  const listeners = new Set<(event: McpEvent) => void>()
  const state = (config: McpServerConfig): McpServerState => ({
    config,
    diagnostics: config.enabled ? (diagnostics.get(config.id) ?? { ...CONNECTED, serverId: config.id, status: 'disconnected', connectedAt: null, serverInfo: null, protocolVersion: null, transportUsed: null, toolCount: 0, resourceCount: 0, stderrTail: [], pid: null }) : { ...(diagnostics.get(config.id) ?? CONNECTED), serverId: config.id, status: 'disabled' },
  })
  const find = (id: string): McpServerConfig => {
    const config = configs.find((c) => c.id === id)
    if (!config) throw new Error('That MCP server no longer exists.')
    return config
  }
  const delay = <T,>(value: T): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(value), 60))

  return {
    mcp: {
      list: () => delay(configs.map(state)),
      save: (input: SaveMcpServerInput) => {
        const existing = input.id ? configs.find((c) => c.id === input.id) : undefined
        const entries = (list: SaveMcpServerInput['env']) => (list ?? []).map((e) => ({ key: e.key, value: e.secret ? null : (e.value ?? ''), secret: e.secret }))
        const config: McpServerConfig = {
          id: existing?.id ?? `mock-${Math.random().toString(36).slice(2, 8)}`,
          name: input.name,
          transport: input.transport,
          command: input.command ?? '',
          args: input.args ?? [],
          cwd: input.cwd ?? null,
          env: entries(input.env),
          url: input.url ?? '',
          headers: entries(input.headers),
          enabled: input.enabled ?? true,
          disabledTools: existing?.disabledTools ?? [],
          createdAt: existing?.createdAt ?? Date.now(),
          updatedAt: Date.now(),
        }
        if (existing) configs[configs.indexOf(existing)] = config
        else configs.push(config)
        diagnostics.delete(config.id)
        return delay(state(config))
      },
      delete: (id) => {
        configs.splice(0, configs.length, ...configs.filter((c) => c.id !== id))
        return delay(undefined)
      },
      setEnabled: ({ id, enabled }) => {
        find(id).enabled = enabled
        return delay(state(find(id)))
      },
      test: (id) => {
        const config = find(id)
        if (config.id !== 'mock-remote') diagnostics.set(id, { ...CONNECTED, serverId: id })
        listeners.forEach((l) => l({ type: 'status', diagnostics: diagnostics.get(id) ?? CONNECTED }))
        return delay(state(config).diagnostics)
      },
      tools: (id) => {
        const config = find(id)
        return delay(TOOLS.map((t) => ({ ...t, enabled: !config.disabledTools.includes(t.name) })))
      },
      setToolEnabled: ({ id, tool, enabled }) => {
        const config = find(id)
        config.disabledTools = enabled ? config.disabledTools.filter((t) => t !== tool) : [...config.disabledTools, tool]
        return delay(TOOLS.map((t) => ({ ...t, enabled: !config.disabledTools.includes(t.name) })))
      },
      resources: () => delay([...RESOURCES]),
      readResources: ({ uris }) =>
        delay({
          attachments: RESOURCES.filter((r) => uris.includes(r.uri)).map((r) => ({
            filename: `${r.name}.${r.mimeType === 'text/markdown' ? 'md' : 'txt'}`,
            mimeType: r.mimeType ?? 'text/plain',
            sizeBytes: 42,
            content: `Fixture content of ${r.uri}\n`,
          })),
          rejected: [],
        }),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
  }
}
