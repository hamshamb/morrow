import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { MCP_LIMITS, type McpDiagnostics, type McpResourceInfo, type McpStatus } from '@ai-workspace/shared'
import { killPidTree } from '../agent/command-runner'
import { buildMcpStdioEnv } from './stdio-env'
import type { McpCallOptions, McpLaunch, McpRawCallResult, McpRawResource, McpRawTool } from './types'

const MAX_TOOL_PAGES = 20
const MAX_TOOLS = 500
const MAX_RESOURCE_PAGES = 20
const MAX_RESOURCES = 1000
const MAX_STDERR_LINE = 2000
const MAX_ERROR_CHARS = 600

export interface McpConnectionOptions {
  clientVersion: string
  /** Removes secrets from anything stored or shown. Receives the launch's exact secret values as well. */
  redact: (text: string, secrets: readonly string[]) => string
  connectTimeoutMs?: number
  /** Something visible changed (status, counts, error). Not called for every stderr line. */
  onChange: () => void
  /** Test seam; the real process environment by default. */
  baseEnv?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** One server's live connection: connect lazily, stay up, say plainly what is wrong, and never leave a child behind. */
export class McpConnection {
  private client: Client | null = null
  private connecting: Promise<void> | null = null
  private closing = false
  private status: McpStatus = 'disconnected'
  private lastError: string | null = null
  private serverInfo: McpDiagnostics['serverInfo'] = null
  private protocolVersion: string | null = null
  private transportUsed: McpDiagnostics['transportUsed'] = null
  private connectedAt: number | null = null
  private pid: number | null = null
  private tools: McpRawTool[] | null = null
  private resources: McpRawResource[] | null = null
  private readonly stderr: string[] = []
  private stderrPartial = ''
  private generation = 0

  constructor(private launch: McpLaunch, private readonly options: McpConnectionOptions) {}

  get serverId(): string {
    return this.launch.id
  }

  /** The live process id of a stdio server (for the quit-time tree kill). */
  get livePid(): number | null {
    return this.pid
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.client !== null
  }

  diagnostics(): McpDiagnostics {
    return {
      serverId: this.launch.id,
      status: this.status,
      lastError: this.lastError,
      serverInfo: this.serverInfo,
      protocolVersion: this.protocolVersion,
      transportUsed: this.transportUsed,
      toolCount: this.tools?.length ?? 0,
      resourceCount: this.resources?.length ?? 0,
      connectedAt: this.connectedAt,
      stderrTail: [...this.stderr],
      pid: this.pid,
    }
  }

  /** The launch definition changed (the user edited the server): used by the next connect. */
  updateLaunch(launch: McpLaunch): void {
    this.launch = launch
  }

  // ------------------------------------------------------------ connect

  /** Idempotent. Concurrent callers share one attempt. After a crash this reconnects. */
  connect(): Promise<void> {
    if (this.isConnected()) return Promise.resolve()
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private redactText(text: string): string {
    return this.options.redact(text, this.launch.secretValues)
  }

  private setError(error: unknown, prefix = ''): void {
    const raw = error instanceof Error ? error.message : String(error)
    this.lastError = this.redactText(`${prefix}${raw}`).slice(0, MAX_ERROR_CHARS)
  }

  private async doConnect(): Promise<void> {
    const { launch } = this
    const generation = (this.generation += 1)
    this.closing = false
    this.status = 'connecting'
    this.lastError = null
    this.resetRuntimeState()
    this.options.onChange()
    try {
      if (launch.transport === 'stdio') {
        await this.connectWith(launch, generation, () => this.createStdio(launch))
        this.transportUsed = 'stdio'
      } else {
        try {
          await this.connectWith(launch, generation, () => this.createStreamableHttp(launch))
          this.transportUsed = 'streamable-http'
        } catch (err) {
          // The 2025 transport spec: a server that answers the first POST with 400/404/405 is an older HTTP+SSE server.
          if (!(err instanceof StreamableHTTPError) || ![400, 404, 405].includes(err.code ?? 0)) throw err
          await this.connectWith(launch, generation, () => this.createSse(launch))
          this.transportUsed = 'sse'
        }
      }
      if (generation !== this.generation) return
      this.status = 'connected'
      this.connectedAt = Date.now()
      this.options.onChange()
    } catch (err) {
      if (generation === this.generation) {
        this.status = 'error'
        this.setError(this.explain(err))
        await this.teardown()
        this.options.onChange()
      }
      throw new Error(this.lastError ?? 'Could not connect.')
    }
  }

  private resetRuntimeState(): void {
    this.serverInfo = null
    this.protocolVersion = null
    this.transportUsed = null
    this.connectedAt = null
    this.pid = null
    this.tools = null
    this.resources = null
    this.stderr.length = 0
    this.stderrPartial = ''
  }

  /** Turns an SDK / OS error into one sentence that tells the user what to check. */
  private explain(err: unknown): string {
    const code = (err as { code?: unknown } | null)?.code
    const message = err instanceof Error ? err.message : String(err)
    if (this.launch.transport === 'stdio') {
      if (code === 'ENOENT') return `Could not run "${this.launch.command}": the program was not found. Check the command and that it is on your PATH.`
      if (code === 'EACCES' || code === 'EPERM') return `Could not run "${this.launch.command}": permission denied.`
      // On Windows cross-spawn runs a missing program through cmd.exe, which starts and then complains on stderr.
      if (this.stderr.some((line) => /is not recognized as an internal or external command|command not found|No such file or directory/i.test(line))) {
        return `Could not run "${this.launch.command}": the program was not found. Check the command and that it is on your PATH.`
      }
      if (/Connection closed/i.test(message)) return `The server process ended before it finished starting (${message}). Its error output is shown below.`
    }
    if (err instanceof StreamableHTTPError && err.code === 401) return 'The server answered 401 Unauthorized. Add or fix an Authorization header (OAuth login is not supported).'
    if (err instanceof StreamableHTTPError && err.code === 403) return 'The server answered 403 Forbidden.'
    return message
  }

  private async connectWith(launch: McpLaunch, generation: number, create: () => Transport): Promise<void> {
    const timeoutMs = this.options.connectTimeoutMs ?? MCP_LIMITS.connectTimeoutMs
    const client = new Client(
      { name: 'morrow', version: this.options.clientVersion },
      {
        // No roots, sampling or elicitation: this client only consumes tools and resources (ADR-049).
        capabilities: {},
        listChanged: { tools: { autoRefresh: false, debounceMs: 100, onChanged: () => void this.refreshTools().catch(() => undefined) } },
      },
    )
    const transport = create()
    const inner = transport as Transport
    // `setProtocolVersion` is the SDK's hook for "the version the handshake settled on"; stdio has none, so add one.
    const original = inner.setProtocolVersion?.bind(inner)
    inner.setProtocolVersion = (version: string): void => {
      this.protocolVersion = version
      original?.(version)
    }
    client.onclose = () => {
      if (generation !== this.generation) return
      this.pid = null
      if (this.closing) return
      if (this.status === 'connected') {
        this.status = 'error'
        this.setError('The connection closed unexpectedly (the server process exited or the network dropped). It will reconnect the next time it is used.')
        this.options.onChange()
      }
    }
    client.onerror = (err) => {
      if (generation === this.generation) this.setError(err)
    }
    this.client = client

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for the server to answer the handshake.`)), timeoutMs)
    })
    try {
      await Promise.race([client.connect(transport, { timeout: timeoutMs }), timeout])
    } catch (err) {
      // Stop a half-started attempt (kills the child) before the caller tries anything else.
      await this.closeClient(client)
      this.client = null
      throw err
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (inner instanceof StdioClientTransport) this.pid = inner.pid

    const info = client.getServerVersion()
    this.serverInfo = info ? { name: info.name, version: info.version, title: typeof info.title === 'string' ? info.title : null } : null
    // Fill the lists now so the first look at diagnostics is complete. A server without tools / resources is fine.
    const capabilities = client.getServerCapabilities()
    if (capabilities?.tools) await this.refreshTools()
    if (capabilities?.resources) await this.refreshResources().catch((err: unknown) => this.setError(err, 'Listing resources failed: '))
  }

  private createStdio(launch: McpLaunch): Transport {
    // Never the app's own directory: a server without an explicit folder starts in the user's home.
    const cwd = launch.cwd ?? homedir()
    if (launch.cwd !== null && !(existsSync(cwd) && statSync(cwd).isDirectory())) {
      throw new Error(`The working directory does not exist: ${launch.cwd}`)
    }
    const transport = new StdioClientTransport({
      command: launch.command,
      args: launch.args,
      cwd,
      env: buildMcpStdioEnv(this.options.baseEnv ?? process.env, this.options.platform ?? process.platform, launch.env),
      stderr: 'pipe',
    })
    const decoder = new StringDecoder('utf8')
    transport.stderr?.on('data', (chunk: Buffer | string) => this.pushStderr(typeof chunk === 'string' ? chunk : decoder.write(chunk)))
    return transport
  }

  private createStreamableHttp(launch: McpLaunch): Transport {
    // The SDK types `sessionId?: string`, which does not satisfy its own Transport under exactOptionalPropertyTypes.
    return new StreamableHTTPClientTransport(new URL(launch.url), { requestInit: { headers: launch.headers } }) as unknown as Transport
  }

  private createSse(launch: McpLaunch): Transport {
    return new SSEClientTransport(new URL(launch.url), { requestInit: { headers: launch.headers } })
  }

  private pushStderr(text: string): void {
    const combined = this.stderrPartial + text
    const lines = combined.split(/\r?\n/)
    this.stderrPartial = lines.pop() ?? ''
    if (this.stderrPartial.length > MAX_STDERR_LINE) {
      lines.push(this.stderrPartial)
      this.stderrPartial = ''
    }
    for (const line of lines) {
      if (line.trim() === '') continue
      this.stderr.push(this.redactText(line.length > MAX_STDERR_LINE ? `${line.slice(0, MAX_STDERR_LINE)}…` : line))
    }
    if (this.stderr.length > MCP_LIMITS.stderrLines) this.stderr.splice(0, this.stderr.length - MCP_LIMITS.stderrLines)
  }

  // ------------------------------------------------------------ lists

  async refreshTools(): Promise<McpRawTool[]> {
    const client = this.client
    if (!client) throw new Error('Not connected.')
    const tools: McpRawTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS; page += 1) {
      const result = await client.listTools(cursor ? { cursor } : undefined)
      tools.push(...result.tools)
      cursor = result.nextCursor
      if (!cursor) break
    }
    this.tools = tools.slice(0, MAX_TOOLS)
    this.options.onChange()
    return this.tools
  }

  async refreshResources(): Promise<McpRawResource[]> {
    const client = this.client
    if (!client) throw new Error('Not connected.')
    const resources: McpRawResource[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_RESOURCE_PAGES && resources.length < MAX_RESOURCES; page += 1) {
      const result = await client.listResources(cursor ? { cursor } : undefined)
      resources.push(...result.resources)
      cursor = result.nextCursor
      if (!cursor) break
    }
    this.resources = resources.slice(0, MAX_RESOURCES)
    this.options.onChange()
    return this.resources
  }

  /** The cached tool list (refreshed on connect and on `notifications/tools/list_changed`). */
  async listTools(): Promise<McpRawTool[]> {
    await this.connect()
    if (this.tools === null) {
      if (!this.client?.getServerCapabilities()?.tools) return []
      await this.refreshTools()
    }
    return this.tools ?? []
  }

  async listResources(): Promise<McpResourceInfo[]> {
    await this.connect()
    if (this.resources === null) {
      if (!this.client?.getServerCapabilities()?.resources) return []
      await this.refreshResources()
    }
    return (this.resources ?? []).map(
      (r): McpResourceInfo => ({
        uri: r.uri,
        name: r.name,
        title: typeof r.title === 'string' ? r.title : null,
        description: typeof r.description === 'string' ? r.description : null,
        mimeType: typeof r.mimeType === 'string' ? r.mimeType : null,
        size: typeof r.size === 'number' ? r.size : null,
      }),
    )
  }

  // ------------------------------------------------------------ use

  async callTool(name: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpRawCallResult> {
    await this.connect()
    const client = this.client
    if (!client) throw new Error('Not connected.')
    const result = await client.callTool({ name, arguments: args }, undefined, { signal: options.signal, timeout: options.timeoutMs })
    return result as McpRawCallResult
  }

  async readResource(uri: string): Promise<{ contents: { uri: string; mimeType?: string | undefined; text?: string | undefined; blob?: string | undefined }[] }> {
    await this.connect()
    const client = this.client
    if (!client) throw new Error('Not connected.')
    const result = await client.readResource({ uri }, { timeout: 30_000 })
    return {
      contents: result.contents.map((c) => ({
        uri: c.uri,
        mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
        text: typeof (c as { text?: unknown }).text === 'string' ? ((c as { text: string }).text) : undefined,
        blob: typeof (c as { blob?: unknown }).blob === 'string' ? ((c as { blob: string }).blob) : undefined,
      })),
    }
  }

  // ------------------------------------------------------------ close

  private async closeClient(client: Client): Promise<void> {
    try {
      await client.close()
    } catch {
      /* closing a transport that already failed to start can throw; the child is killed below */
    }
  }

  /** Closes the client, then makes sure the child and its descendants are gone. */
  private async teardown(): Promise<void> {
    const client = this.client
    const pid = this.pid
    this.client = null
    this.pid = null
    if (client) await this.closeClient(client)
    if (pid !== null && processAlive(pid)) killPidTree(pid)
  }

  /** The user disabled / edited / removed the server, or the app is closing. */
  async close(): Promise<void> {
    this.closing = true
    this.generation += 1
    try {
      await this.connecting?.catch(() => undefined)
    } finally {
      await this.teardown()
    }
    this.status = 'disconnected'
    this.resetRuntimeState()
    this.options.onChange()
  }

  /** Quit-time: kill the process tree NOW (a synchronous call that finishes before the app exits). */
  killSync(): void {
    this.closing = true
    this.generation += 1
    const pid = this.pid
    this.pid = null
    this.client = null
    if (pid !== null) killPidTree(pid, { sync: true })
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
