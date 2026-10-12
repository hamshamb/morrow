import { toolWireName, type ToolId } from '@ai-workspace/shared'
import { FS_TOOLS } from './fs-tools'
import { GIT_TOOLS } from './git-tools'
import { terminalExecute } from './terminal-tool'
import type { ToolDefinition } from './types'

/**
 * The one tool registry (ADR-040). Every provider calls THESE tools through the
 * single adapter in packages/providers; there is no provider-specific tool code.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOL_DEFINITIONS: ToolDefinition<any>[] = [...FS_TOOLS, ...GIT_TOOLS, terminalExecute]

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byId = new Map<ToolId, ToolDefinition<any>>(ALL_TOOL_DEFINITIONS.map((t) => [t.id, t]))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const byWireName = new Map<string, ToolDefinition<any>>(ALL_TOOL_DEFINITIONS.map((t) => [toolWireName(t.id), t]))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getToolById(id: ToolId): ToolDefinition<any> | undefined {
  return byId.get(id)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getToolByWireName(name: string): ToolDefinition<any> | undefined {
  return byWireName.get(name)
}
