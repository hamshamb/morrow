import {
  MCP_LIMITS,
  mcpWireName,
  type McpDiagnostics,
  type McpEvent,
  type McpResourceInfo,
  type McpServerConfig,
  type McpServerState,
  type McpToolInfo,
} from '@ai-workspace/shared'
import { McpConnection } from './connection'
import type { McpConfigService } from './config-service'
import { hasObjectInputSchema, toolHints } from './tool-info'
import type { McpCallOptions, McpRawCallResult, McpRawTool, McpToolBinding, McpToolProvider } from './types'

export interface McpManagerOptions {
  config: McpConfigService
  clientVersion: string
  redact: (text: string, secrets: readonly string[]) => string
  emit?: (event: McpEvent) => void
  connectTimeoutMs?: number
  baseEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/**
 * Owns the live connections: one per ENABLED server, opened lazily (a test / refresh in Settings, or the start of a
 * Build run), reopened on next use after a crash, closed when the server is edited, disabled or removed, and killed
 * when the app quits (ADR-051). The only code that decides whether a server is spawned.
 */
export class McpManager implements McpToolProvider {
  private readonly connections = new Map<string, McpConnection>()

  constructor(private readonly options: McpManagerOptions) {}

  // ------------------------------------------------------------ state

  private connectionFor(config: McpServerConfig): McpConnection {
    let connection = this.connections.get(config.id)
    if (!connection) {
      connection = new McpConnection(this.options.config.resolveLaunch(config.id), {
        clientVersion: this.options.clientVersion,
        redact: this.options.redact,
        onChange: () => this.emitStatus(config.id),
        ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
        ...(this.options.baseEnv ? { baseEnv: this.options.baseEnv } : {}),
        ...(this.options.platform ? { platform: this.options.platform } : {}),
      })
      this.connections.set(config.id, connection)
    }
    return connection
  }

  private emitStatus(id: string): void {
    const config = this.options.config.get(id)
    if (!config) return
    this.options.emit?.({ type: 'status', diagnostics: this.diagnostics(config) })
  }

  diagnostics(config: McpServerConfig): McpDiagnostics {
    const live = this.connections.get(config.id)
    if (!config.enabled) {
      const base = live?.diagnostics()
      return { ...(base ?? emptyDiagnostics(config.id)), status: 'disabled' }
    }
    return live ? live.diagnostics() : emptyDiagnostics(config.id)
  }

  states(): McpServerState[] {
    return this.options.config.list().map((config) => ({ config, diagnostics: this.diagnostics(config) }))
  }

  state(id: string): McpServerState {
    const config = this.requireConfig(id)
    return { config, diagnostics: this.diagnostics(config) }
  }

  private requireConfig(id: string): McpServerConfig {
    const config = this.options.config.get(id)
    if (!config) throw new Error('That MCP server no longer exists.')
    return config
  }

  // ------------------------------------------------------------ lifecycle

  /** The server's definition changed or it was removed: drop the connection so the next use starts from the new one. */
  async invalidate(id: string): Promise<void> {
    const live = this.connections.get(id)
    if (!live) return
    this.connections.delete(id)
    await live.close()
  }

  /** Connects (or reconnects), lists tools and resources and returns the diagnostics. Never throws for a server fault. */
  async test(id: string): Promise<McpDiagnostics> {
    const config = this.requireConfig(id)
    if (!config.enabled) return this.diagnostics(config)
    const connection = this.connectionFor(config)
    try {
      // A connection that thinks it is fine may be stale; ping by listing again.
      await connection.connect()
      await connection.refreshTools().catch(() => undefined)
      await connection.refreshResources().catch(() => undefined)
    } catch {
      /* the connection recorded why in its diagnostics */
    }
    return connection.diagnostics()
  }

  private async liveConnection(id: string): Promise<McpConnection> {
    const config = this.requireConfig(id)
    if (!config.enabled) throw new Error(`The MCP server "${config.name}" is disabled.`)
    const connection = this.connectionFor(config)
    await connection.connect()
    return connection
  }

  async closeAll(): Promise<void> {
    const all = [...this.connections.values()]
    this.connections.clear()
    await Promise.allSettled(all.map((c) => c.close()))
  }

  /** App quit: kill every stdio process tree now, synchronously. */
  killAllSync(): void {
    for (const connection of this.connections.values()) connection.killSync()
    this.connections.clear()
  }

  // ------------------------------------------------------------ tools and resources

  async tools(id: string): Promise<McpToolInfo[]> {
    const config = this.requireConfig(id)
    if (!config.enabled) return []
    const connection = await this.liveConnection(id)
    return this.toolInfos(config, await connection.listTools())
  }

  private toolInfos(config: McpServerConfig, raw: McpRawTool[]): McpToolInfo[] {
    const taken = new Set<string>()
    const disabled = new Set(config.disabledTools)
    return raw.map((tool): McpToolInfo => {
      const offerable = hasObjectInputSchema(tool)
      const wireName = offerable ? mcpWireName(config.name, tool.name, taken) : null
      if (wireName) taken.add(wireName)
      return {
        name: tool.name,
        title: typeof tool.title === 'string' ? tool.title : null,
        description: typeof tool.description === 'string' ? tool.description : '',
        hints: toolHints(tool),
        enabled: !disabled.has(tool.name),
        wireName,
      }
    })
  }

  async setToolEnabled(id: string, tool: string, enabled: boolean): Promise<McpToolInfo[]> {
    this.options.config.setToolEnabled(id, tool, enabled)
    return this.tools(id)
  }

  async resources(id: string): Promise<McpResourceInfo[]> {
    const config = this.requireConfig(id)
    if (!config.enabled) return []
    return (await this.liveConnection(id)).listResources()
  }

  async readResource(id: string, uri: string): Promise<Awaited<ReturnType<McpConnection['readResource']>>> {
    return (await this.liveConnection(id)).readResource(uri)
  }

  // ------------------------------------------------------------ for an agent run

  /**
   * The tools every enabled server offers right now, named for the model. Servers are connected in parallel; one that
   * will not connect is skipped (its Settings entry says why) and never stops the run. Disabled servers and tools,
   * and tools whose arguments are not an object, are not offered.
   */
  async discoverRunTools(signal: AbortSignal): Promise<McpToolBinding[]> {
    const configs = this.options.config.list().filter((c) => c.enabled)
    const perServer = await Promise.all(
      configs.map(async (config): Promise<McpToolBinding[]> => {
        if (signal.aborted) return []
        try {
          const connection = await this.liveConnection(config.id)
          const disabled = new Set(config.disabledTools)
          return (await connection.listTools())
            .filter((tool) => hasObjectInputSchema(tool) && !disabled.has(tool.name))
            .map((tool) => ({ wireName: '', serverId: config.id, serverName: config.name, tool }))
        } catch {
          return []
        }
      }),
    )
    const taken = new Set<string>()
    const bindings: McpToolBinding[] = []
    for (const binding of perServer.flat()) {
      if (bindings.length >= MCP_LIMITS.maxToolsPerRun) break
      const wireName = mcpWireName(binding.serverName, binding.tool.name, taken)
      taken.add(wireName)
      bindings.push({ ...binding, wireName })
    }
    return bindings
  }

  async callTool(serverId: string, toolName: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpRawCallResult> {
    const config = this.requireConfig(serverId)
    if (config.disabledTools.includes(toolName)) throw new Error(`The tool "${toolName}" is switched off for the MCP server "${config.name}".`)
    const connection = await this.liveConnection(serverId)
    return connection.callTool(toolName, args, options)
  }
}

function emptyDiagnostics(serverId: string): McpDiagnostics {
  return {
    serverId,
    status: 'disconnected',
    lastError: null,
    serverInfo: null,
    protocolVersion: null,
    transportUsed: null,
    toolCount: 0,
    resourceCount: 0,
    connectedAt: null,
    stderrTail: [],
    pid: null,
  }
}
