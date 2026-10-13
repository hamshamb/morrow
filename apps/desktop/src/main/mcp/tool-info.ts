import type { McpToolHints } from '@ai-workspace/shared'
import type { McpRawTool } from './types'

/** The hints a server attached to a tool. They are claims by an untrusted party: displayed, and only ever used to ask MORE loudly. */
export function toolHints(tool: McpRawTool): McpToolHints {
  const a = tool.annotations
  const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
  return { readOnly: flag(a?.readOnlyHint), destructive: flag(a?.destructiveHint), idempotent: flag(a?.idempotentHint), openWorld: flag(a?.openWorldHint) }
}

/** A tool can be offered to a model only if its arguments are an object schema. */
export function hasObjectInputSchema(tool: McpRawTool): boolean {
  return (tool.inputSchema as { type?: unknown } | undefined)?.type === 'object'
}
