import { z } from 'zod'
import { TOOL_OUTPUT_CHAR_CAP, mcpToolKey, type PermissionPreview } from '@ai-workspace/shared'
import type { AgentToolSpec } from '@ai-workspace/providers'
import { ToolError, type ToolDefinition } from '../agent/tools/types'
import { toolHints } from './tool-info'
import { capToolText, formatCallToolResult } from './result-format'
import type { McpToolBinding, McpToolCaller } from './types'

/**
 * MCP tools as members of THE tool layer (ADR-048): each enabled server tool becomes a `ToolDefinition` with the id
 * `mcp.call`, so it goes through the same validate -> assess -> prepare -> permission -> run -> audit -> redact path as
 * `filesystem.patch` or `terminal.execute`. Nothing in this file decides whether a call may run; it only describes it.
 */

const DESCRIPTION_MODEL_CHARS = 2000
const DESCRIPTION_PROMPT_CHARS = 500
export const PREVIEW_ARGS_CHARS = 20_000

/** Control, zero-width and bidi-override characters: text from a server must not be able to disguise itself in the prompt. */
const UNSAFE_DISPLAY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g

export function cleanDisplayText(text: string): string {
  return text.replace(UNSAFE_DISPLAY, '')
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

// ---------------------------------------------------------------- the JSON Schema the model is given

/** `inputSchema` in the form every provider accepts: an object schema, no `$schema`, `properties` present. */
export function providerInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...schema }
  delete copy['$schema']
  copy['type'] = 'object'
  if (typeof copy['properties'] !== 'object' || copy['properties'] === null) copy['properties'] = {}
  return copy
}

// ---------------------------------------------------------------- a basic check (the server validates fully)

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'null':
      return value === null
    default:
      return true
  }
}

/**
 * A deliberately small look at the arguments: required properties are present and top-level properties have the
 * declared primitive type / enum. Anything else (formats, nested shapes, patterns) is the server's job, and its
 * error comes back to the model as a tool error. Returns the first problem, or null.
 */
export function basicSchemaProblem(schema: unknown, value: Record<string, unknown>): string | null {
  if (typeof schema !== 'object' || schema === null) return null
  const s = schema as { required?: unknown; properties?: unknown; additionalProperties?: unknown }
  if (Array.isArray(s.required)) {
    for (const name of s.required) {
      if (typeof name === 'string' && !(name in value)) return `missing required argument "${name}"`
    }
  }
  const properties = typeof s.properties === 'object' && s.properties !== null ? (s.properties as Record<string, unknown>) : {}
  for (const [name, given] of Object.entries(value)) {
    const declared = properties[name]
    if (declared === undefined) {
      if (s.additionalProperties === false) return `unexpected argument "${name}"`
      continue
    }
    if (typeof declared !== 'object' || declared === null) continue
    const spec = declared as { type?: unknown; enum?: unknown }
    const types = typeof spec.type === 'string' ? [spec.type] : Array.isArray(spec.type) ? spec.type.filter((t): t is string => typeof t === 'string') : []
    if (types.length > 0 && !types.some((t) => typeMatches(t, given))) return `argument "${name}" must be ${types.join(' or ')}`
    if (Array.isArray(spec.enum) && !spec.enum.some((allowed) => JSON.stringify(allowed) === JSON.stringify(given))) return `argument "${name}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}`
  }
  return null
}

export function mcpArgumentsSchema(schema: unknown): z.ZodType<Record<string, unknown>> {
  return z.record(z.string(), z.unknown(), { error: 'the arguments must be a JSON object' }).superRefine((value, ctx) => {
    const problem = basicSchemaProblem(schema, value)
    if (problem) ctx.addIssue({ code: 'custom', message: problem })
  })
}

// ---------------------------------------------------------------- the definition

export function createMcpToolDefinition(binding: McpToolBinding, caller: McpToolCaller): ToolDefinition<Record<string, unknown>> {
  const { serverName, tool } = binding
  // The grant key is the exact pair; what is DISPLAYED has control / bidi characters stripped (a tool name is server-chosen text).
  const key = mcpToolKey(serverName, tool.name)
  const shownKey = mcpToolKey(serverName, cleanDisplayText(tool.name))
  const hints = toolHints(tool)
  const description = cleanDisplayText(typeof tool.description === 'string' ? tool.description : '')

  return {
    id: 'mcp.call',
    wireName: binding.wireName,
    description: `[MCP server "${serverName}"] ${truncate(description || tool.title || tool.name, DESCRIPTION_MODEL_CHARS)}`,
    inputSchema: mcpArgumentsSchema(tool.inputSchema),
    // Servers are untrusted programs: `execution` is the floor. A server's own hints can only raise it (see `assess`).
    risk: 'execution',
    label: () => `mcp ${shownKey}`,
    assess: () => {
      const destructive = hints.destructive === true
      return {
        risk: destructive ? 'destructive' : 'execution',
        // `readOnlyHint: true` is ignored on purpose: a server cannot talk its way down to "no prompt".
        noGrant: destructive,
        command: key,
        grantScopeNote: `this exact tool (${shownKey})`,
      }
    },
    prepare: (input, ctx) => {
      const pretty = ctx.redact(JSON.stringify(input, null, 2))
      const truncated = pretty.length > PREVIEW_ARGS_CHARS
      const preview: PermissionPreview = {
        kind: 'mcp',
        server: serverName,
        tool: cleanDisplayText(tool.name),
        description: truncate(description || (tool.title ?? ''), DESCRIPTION_PROMPT_CHARS),
        arguments: truncated ? `${pretty.slice(0, PREVIEW_ARGS_CHARS)}\n… (${pretty.length - PREVIEW_ARGS_CHARS} more characters not shown)` : pretty,
        argumentsTruncated: truncated,
        hints: { readOnly: hints.readOnly, destructive: hints.destructive, openWorld: hints.openWorld },
      }
      return Promise.resolve({ preview, state: null })
    },
    run: async (input, ctx) => {
      const timeoutMs = ctx.services.limits().commandTimeoutSeconds * 1000
      let result
      try {
        result = await caller.callTool(binding.serverId, tool.name, input, { signal: ctx.signal, timeoutMs })
      } catch (err) {
        if (ctx.signal.aborted) return { text: 'The run was cancelled.', summary: 'cancelled', cancelled: true, isError: true }
        const message = err instanceof Error ? err.message : String(err)
        const timedOut = /timed out|timeout/i.test(message)
        throw new ToolError(
          ctx.redact(timedOut ? `The MCP tool ${shownKey} did not answer within ${Math.round(timeoutMs / 1000)} s.` : `The MCP tool ${shownKey} failed: ${message}`).slice(0, 1000),
        )
      }
      const formatted = formatCallToolResult(result)
      const capped = capToolText(ctx.redact(formatted.text), TOOL_OUTPUT_CHAR_CAP)
      return {
        text: capped.text,
        summary: formatted.isError ? 'tool error' : `${formatted.text.length.toLocaleString('en-US')} chars`,
        detail: capped.text,
        isError: formatted.isError,
        failed: formatted.isError,
      }
    },
  }
}

/** The function the provider adapter calls for one MCP tool (name, JSON Schema and `execute` through the executor). */
export function mcpToolSpec(def: ToolDefinition<Record<string, unknown>>, binding: McpToolBinding, execute: (wireName: string, input: unknown) => ReturnType<AgentToolSpec['execute']>): AgentToolSpec {
  return {
    name: binding.wireName,
    description: def.description,
    inputJsonSchema: providerInputSchema(binding.tool.inputSchema as Record<string, unknown>),
    validate: (value) => {
      const parsed = def.inputSchema.safeParse(value)
      return parsed.success
        ? { success: true as const, value: parsed.data }
        : { success: false as const, error: new Error(parsed.error.issues.map((i) => `${i.path.length > 0 ? `${i.path.join('.')}: ` : ''}${i.message}`).join('; ')) }
    },
    execute: (input) => execute(binding.wireName, input),
  }
}
