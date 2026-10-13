import type { CallToolResult, Resource, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { McpTransport } from '@ai-workspace/shared'

export type McpRawTool = Tool
export type McpRawResource = Resource
export type McpRawCallResult = CallToolResult

/**
 * A server definition with every secret decrypted - MAIN PROCESS ONLY. It is built per connection attempt, handed
 * to the transport and never stored, logged or sent to the renderer.
 */
export interface McpLaunch {
  id: string
  name: string
  transport: McpTransport
  command: string
  args: string[]
  cwd: string | null
  /** The configured variables (plain + decrypted secret). The base environment is added by `buildMcpStdioEnv`. */
  env: Record<string, string>
  url: string
  headers: Record<string, string>
  /** Every decrypted secret value, so stderr and error text can be redacted by exact value. */
  secretValues: string[]
}

/** One MCP tool as offered to a run: the model sees `wireName`; the server knows `tool.name`. */
export interface McpToolBinding {
  wireName: string
  serverId: string
  serverName: string
  tool: McpRawTool
}

export interface McpCallOptions {
  signal: AbortSignal
  timeoutMs: number
}

/** What the tool layer needs from the connection manager. */
export interface McpToolCaller {
  callTool(serverId: string, toolName: string, args: Record<string, unknown>, options: McpCallOptions): Promise<McpRawCallResult>
}

/** What the agent service needs: the tools of every enabled server, discovered at run start. */
export interface McpToolProvider extends McpToolCaller {
  discoverRunTools(signal: AbortSignal): Promise<McpToolBinding[]>
}
