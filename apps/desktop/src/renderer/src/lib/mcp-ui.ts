import {
  MCP_NAME_PATTERN,
  mcpConfigProblems,
  type McpDiagnostics,
  type McpServerConfig,
  type McpStatus,
  type McpToolHints,
  type McpTransport,
  type SaveMcpServerInput,
} from '@ai-workspace/shared'

/**
 * View-model helpers for Settings -> MCP: the add / edit form's draft (and its conversion to what the main process
 * validates again), status text, hint badges and error cleanup. No React in here.
 */

export interface DraftEntry {
  key: string
  value: string
  secret: boolean
  /** A secret that is already stored: an empty value means "keep it". */
  existing: boolean
}

export interface McpDraft {
  id?: string
  name: string
  transport: McpTransport
  command: string
  /** One argument per line. */
  argsText: string
  cwd: string
  env: DraftEntry[]
  url: string
  headers: DraftEntry[]
  enabled: boolean
}

export function emptyDraft(transport: McpTransport = 'stdio'): McpDraft {
  return { name: '', transport, command: '', argsText: '', cwd: '', env: [], url: '', headers: [], enabled: true }
}

const toDraftEntries = (entries: McpServerConfig['env']): DraftEntry[] =>
  entries.map((e) => ({ key: e.key, value: e.secret ? '' : (e.value ?? ''), secret: e.secret, existing: e.secret }))

export function draftFromConfig(config: McpServerConfig): McpDraft {
  return {
    id: config.id,
    name: config.name,
    transport: config.transport,
    command: config.command,
    argsText: config.args.join('\n'),
    cwd: config.cwd ?? '',
    env: toDraftEntries(config.env),
    url: config.url,
    headers: toDraftEntries(config.headers),
    enabled: config.enabled,
  }
}

export function parseArgs(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
}

const toInputEntries = (entries: DraftEntry[]): SaveMcpServerInput['env'] =>
  entries
    .filter((e) => e.key.trim() !== '')
    .map((e) => ({ key: e.key.trim(), value: e.secret && e.existing && e.value === '' ? null : e.value, secret: e.secret }))

export function draftToInput(draft: McpDraft): SaveMcpServerInput {
  const stdio = draft.transport === 'stdio'
  return {
    ...(draft.id !== undefined ? { id: draft.id } : {}),
    name: draft.name.trim(),
    transport: draft.transport,
    command: stdio ? draft.command.trim() : '',
    args: stdio ? parseArgs(draft.argsText) : [],
    cwd: stdio && draft.cwd.trim() !== '' ? draft.cwd.trim() : null,
    env: stdio ? toInputEntries(draft.env) : [],
    url: stdio ? '' : draft.url.trim(),
    headers: stdio ? [] : toInputEntries(draft.headers),
    enabled: draft.enabled,
  }
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/

/** Everything wrong with the form right now (the main process checks again; this only saves a round trip). */
export function draftProblems(draft: McpDraft): string[] {
  const problems: string[] = []
  if (!MCP_NAME_PATTERN.test(draft.name.trim())) problems.push('Name: 1 to 32 characters, lowercase letters, digits and hyphens.')
  const input = draftToInput(draft)
  problems.push(
    ...mcpConfigProblems({
      transport: input.transport,
      command: input.command ?? '',
      args: input.args ?? [],
      cwd: input.cwd ?? null,
      env: input.env ?? [],
      url: input.url ?? '',
      headers: input.headers ?? [],
    }),
  )
  if (draft.transport === 'stdio' && draft.cwd.trim() !== '' && !ABSOLUTE.test(draft.cwd.trim())) problems.push('The working directory must be an absolute path.')
  for (const entry of draft.transport === 'stdio' ? draft.env : draft.headers) {
    if (entry.key.trim() !== '' && entry.secret && !entry.existing && entry.value === '') problems.push(`Enter a value for the secret "${entry.key.trim()}".`)
  }
  return problems
}

/** `node server.js --root C:/x` or the URL: the muted one-liner in the server list. */
export function serverSummary(config: Pick<McpServerConfig, 'transport' | 'command' | 'args' | 'url'>): string {
  return config.transport === 'stdio' ? [config.command, ...config.args].join(' ') : config.url
}

export const STATUS_TEXT: Record<McpStatus, string> = {
  disabled: 'disabled',
  disconnected: 'not connected',
  connecting: 'connecting',
  connected: 'connected',
  error: 'error',
}

export function hintBadges(hints: McpToolHints): { label: string; tone: 'plain' | 'danger' }[] {
  const out: { label: string; tone: 'plain' | 'danger' }[] = []
  if (hints.readOnly === true) out.push({ label: 'says read-only', tone: 'plain' })
  if (hints.destructive === true) out.push({ label: 'says destructive', tone: 'danger' })
  if (hints.openWorld === true) out.push({ label: 'says open-world', tone: 'plain' })
  return out
}

/** Electron prefixes IPC errors with "Error invoking remote method 'x': Error:". The person only needs the rest. */
export function cleanIpcError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}

/** Short "connected 3 min ago"-style fact for the diagnostics panel. */
export function connectedSince(diagnostics: Pick<McpDiagnostics, 'connectedAt'>, now = Date.now()): string {
  if (diagnostics.connectedAt === null) return '–'
  const seconds = Math.max(0, Math.round((now - diagnostics.connectedAt) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  return `${Math.floor(seconds / 3600)} h ago`
}
