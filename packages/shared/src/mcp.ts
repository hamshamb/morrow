import { z } from 'zod'

/**
 * Phase 7 - MCP (Model Context Protocol) client (ADR-047 ... ADR-051).
 *
 * An MCP server is a program (or a remote endpoint) the USER chose to add. It is untrusted: its tools,
 * descriptions, annotations and results are data from a third party. Configuration, connections, secrets and
 * every enforcement decision live in the main process; the renderer only displays and asks.
 */

// ---------------------------------------------------------------- configuration

/** Used inside tool wire names (`mcp__<name>__<tool>`), so it is deliberately narrow. */
export const MCP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
export const McpServerNameSchema = z
  .string()
  .regex(MCP_NAME_PATTERN, 'Use 1 to 32 characters: lowercase letters, digits and hyphens, starting with a letter or digit.')

export const MCP_TRANSPORTS = ['stdio', 'http'] as const
export const McpTransportSchema = z.enum(MCP_TRANSPORTS)
export type McpTransport = z.infer<typeof McpTransportSchema>

export const MCP_LIMITS = {
  maxArgs: 100,
  maxArgLength: 4000,
  maxCommandLength: 1000,
  maxEntries: 50,
  maxValueLength: 8000,
  maxUrlLength: 2000,
  maxServers: 50,
  /** Tools offered to the model from all servers together, per run. */
  maxToolsPerRun: 100,
  stderrLines: 200,
  connectTimeoutMs: 20_000,
} as const

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * One environment variable (stdio) or HTTP header (http). A secret's value is NEVER sent to the renderer: it
 * reads back as `value: null` ("set"). When saving, `value: null` on a secret means "keep the stored value".
 */
export const McpEntrySchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(MCP_LIMITS.maxValueLength).nullable(),
  secret: z.boolean(),
})
export type McpEntry = z.infer<typeof McpEntrySchema>

export const McpServerConfigSchema = z.object({
  id: z.string(),
  name: McpServerNameSchema,
  transport: McpTransportSchema,
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string().nullable(),
  env: z.array(McpEntrySchema),
  url: z.string(),
  headers: z.array(McpEntrySchema),
  enabled: z.boolean(),
  /** Tool names (as the server calls them) the user switched off. They are never offered to a model. */
  disabledTools: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** What the add / edit form sends. `id` present = edit that server. */
export const SaveMcpServerInputSchema = z.object({
  id: z.string().min(1).max(100).optional(),
  name: McpServerNameSchema,
  transport: McpTransportSchema,
  command: z.string().max(MCP_LIMITS.maxCommandLength).default(''),
  args: z.array(z.string().max(MCP_LIMITS.maxArgLength)).max(MCP_LIMITS.maxArgs).default([]),
  cwd: z.string().max(2000).nullable().default(null),
  env: z.array(McpEntrySchema).max(MCP_LIMITS.maxEntries).default([]),
  url: z.string().max(MCP_LIMITS.maxUrlLength).default(''),
  headers: z.array(McpEntrySchema).max(MCP_LIMITS.maxEntries).default([]),
  enabled: z.boolean().default(true),
})
export type SaveMcpServerInput = z.input<typeof SaveMcpServerInputSchema>
export type ParsedSaveMcpServerInput = z.output<typeof SaveMcpServerInputSchema>

export const McpSetEnabledInputSchema = z.object({ id: z.string().min(1).max(100), enabled: z.boolean() })
export type McpSetEnabledInput = z.infer<typeof McpSetEnabledInputSchema>

export const McpSetToolEnabledInputSchema = z.object({
  id: z.string().min(1).max(100),
  tool: z.string().min(1).max(300),
  enabled: z.boolean(),
})
export type McpSetToolEnabledInput = z.infer<typeof McpSetToolEnabledInputSchema>

export const McpReadResourcesInputSchema = z.object({
  id: z.string().min(1).max(100),
  uris: z.array(z.string().min(1).max(4000)).min(1).max(20),
})
export type McpReadResourcesInput = z.infer<typeof McpReadResourcesInputSchema>

// ---------------------------------------------------------------- validation (pure; the main process runs it on every save)

/** `http:` is allowed only for this machine; everything else must be `https:`. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host.endsWith('.localhost')
}

interface ParsedUrl {
  protocol: string
  hostname: string
  username: string
  password: string
}

/** `URL` exists in Node, Electron and the browser, but this package has neither the DOM nor the Node typings. */
function parseUrl(text: string): ParsedUrl | null {
  const Ctor = (globalThis as { URL?: new (input: string) => ParsedUrl }).URL
  if (!Ctor) return null
  try {
    return new Ctor(text)
  } catch {
    return null
  }
}

/** Why a server URL is not acceptable, or null. */
export function mcpUrlProblem(raw: string): string | null {
  const text = raw.trim()
  if (text === '') return 'Enter the server URL.'
  const url = parseUrl(text)
  if (!url) return 'That is not a valid URL.'
  if (url.username !== '' || url.password !== '') return 'Do not put a user name or password in the URL; add an Authorization header instead.'
  if (url.protocol === 'https:') return null
  if (url.protocol === 'http:') return isLocalHost(url.hostname) ? null : 'Plain http is only allowed for localhost, 127.0.0.1 and [::1]. Use https for a remote server.'
  return 'Only https URLs (or http for localhost) are supported.'
}

function entryProblems(entries: readonly McpEntry[], kind: 'env' | 'headers'): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const key = entry.key.trim()
    if (kind === 'env' ? !ENV_KEY.test(key) : !HEADER_NAME.test(key)) {
      problems.push(kind === 'env' ? `"${key}" is not a valid environment variable name.` : `"${key}" is not a valid header name.`)
      continue
    }
    const folded = key.toLowerCase()
    if (seen.has(folded)) problems.push(`"${key}" is listed twice.`)
    seen.add(folded)
    if (entry.value !== null && /[\u0000\r\n]/.test(entry.value)) problems.push(`The value of "${key}" contains a control character.`)
    if (entry.value === null && !entry.secret) problems.push(`"${key}" needs a value.`)
  }
  return problems
}

/** Every reason a server definition cannot be saved (empty = fine). Pure: the form and the main process share it. */
export function mcpConfigProblems(input: Pick<ParsedSaveMcpServerInput, 'transport' | 'command' | 'args' | 'cwd' | 'env' | 'url' | 'headers'>): string[] {
  const problems: string[] = []
  if (input.transport === 'stdio') {
    const command = input.command.trim()
    if (command === '') problems.push('Enter the command to run.')
    else if (/[\u0000\r\n]/.test(command)) problems.push('The command must be a single line.')
    for (const arg of input.args) if (arg.includes('\u0000')) problems.push('An argument contains a NUL character.')
    if (input.cwd !== null && (input.cwd.trim() === '' || input.cwd.includes('\u0000'))) problems.push('The working directory is not valid.')
    problems.push(...entryProblems(input.env, 'env'))
  } else {
    const problem = mcpUrlProblem(input.url)
    if (problem) problems.push(problem)
    problems.push(...entryProblems(input.headers, 'headers'))
  }
  return problems
}

// ---------------------------------------------------------------- runtime state and diagnostics

export const MCP_STATUSES = ['disabled', 'disconnected', 'connecting', 'connected', 'error'] as const
export const McpStatusSchema = z.enum(MCP_STATUSES)
export type McpStatus = z.infer<typeof McpStatusSchema>

export const McpDiagnosticsSchema = z.object({
  serverId: z.string(),
  status: McpStatusSchema,
  /** Never contains a secret: redacted before it is stored. */
  lastError: z.string().nullable(),
  serverInfo: z.object({ name: z.string(), version: z.string(), title: z.string().nullable() }).nullable(),
  protocolVersion: z.string().nullable(),
  /** `stdio`, `streamable-http`, or `sse` when the server only spoke the older HTTP+SSE transport. */
  transportUsed: z.enum(['stdio', 'streamable-http', 'sse']).nullable(),
  toolCount: z.number(),
  resourceCount: z.number(),
  connectedAt: z.number().nullable(),
  /** The last stderr lines of a stdio server (redacted). */
  stderrTail: z.array(z.string()),
  pid: z.number().nullable(),
})
export type McpDiagnostics = z.infer<typeof McpDiagnosticsSchema>

/** A server as the Settings screen shows it: the saved definition plus how it is doing right now. */
export const McpServerStateSchema = z.object({ config: McpServerConfigSchema, diagnostics: McpDiagnosticsSchema })
export type McpServerState = z.infer<typeof McpServerStateSchema>

/** Hints from the server. They are untrusted: they can raise how loudly we ask, never lower it. */
export const McpToolHintsSchema = z.object({
  readOnly: z.boolean().nullable(),
  destructive: z.boolean().nullable(),
  idempotent: z.boolean().nullable(),
  openWorld: z.boolean().nullable(),
})
export type McpToolHints = z.infer<typeof McpToolHintsSchema>

export const McpToolInfoSchema = z.object({
  name: z.string(),
  title: z.string().nullable(),
  description: z.string(),
  hints: McpToolHintsSchema,
  enabled: z.boolean(),
  /** The function name a model sees; null for a tool that cannot be offered (e.g. a schema that is not an object). */
  wireName: z.string().nullable(),
})
export type McpToolInfo = z.infer<typeof McpToolInfoSchema>

export const McpResourceInfoSchema = z.object({
  uri: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
})
export type McpResourceInfo = z.infer<typeof McpResourceInfoSchema>

export type McpEvent = { type: 'status'; diagnostics: McpDiagnostics } | { type: 'removed'; serverId: string }

// ---------------------------------------------------------------- tool names

/** Hash only for disambiguation, not security (djb2 over UTF-16 code units, base36). */
export function shortHash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36).padStart(7, '0')
}

const WIRE_MAX = 64

function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]/g, '_')
}

/**
 * `mcp__<server>__<tool>`, characters outside `[A-Za-z0-9_-]` replaced by `_`, at most 64 characters (what
 * Anthropic and OpenAI accept). A name that had to be changed or shortened gets a short hash of the ORIGINAL
 * pair so two different tools can never share a wire name. `taken` is the set of names already handed out in this run.
 */
export function mcpWireName(server: string, tool: string, taken: ReadonlySet<string> = new Set()): string {
  const prefix = `mcp__${sanitize(server)}__`
  const clean = sanitize(tool)
  let candidate = `${prefix}${clean}`
  const exact = candidate === `mcp__${server}__${tool}`
  if (candidate.length > WIRE_MAX || !exact || taken.has(candidate)) {
    const suffix = `_${shortHash(`${server}\u0000${tool}`)}`
    candidate = `${(prefix + clean).slice(0, WIRE_MAX - suffix.length)}${suffix}`
  }
  for (let n = 2; taken.has(candidate); n += 1) {
    const extra = `_${n}`
    candidate = `${candidate.slice(0, WIRE_MAX - extra.length)}${extra}`
  }
  return candidate
}

/** The grant key / label part for one MCP tool: `server/tool`. */
export function mcpToolKey(server: string, tool: string): string {
  return `${server}/${tool}`
}
