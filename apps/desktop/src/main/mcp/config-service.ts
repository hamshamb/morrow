import { isAbsolute } from 'node:path'
import { MCP_LIMITS, SaveMcpServerInputSchema, mcpConfigProblems, type McpServerConfig, type ParsedSaveMcpServerInput } from '@ai-workspace/shared'
import type { McpPlainEntry, McpServerRepository, McpServerWrite } from '@ai-workspace/storage'
import type { McpLaunch } from './types'

/** Encrypts / decrypts one string with the OS keychain (Electron safeStorage in the app, a stand-in in tests). */
export interface SecretCrypto {
  encrypt(plain: string): Buffer
  decrypt(encrypted: Buffer): string
}

/** What the encrypted blob holds. */
interface SecretBundle {
  env: Record<string, string>
  headers: Record<string, string>
}

/** A save that cannot go through. The message is meant for the person editing the form. */
export class McpConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join(' '))
    this.name = 'McpConfigError'
  }
}

function emptyBundle(): SecretBundle {
  return { env: {}, headers: {} }
}

function asStringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string') out[key] = v
  }
  return out
}

/**
 * Saving, validating and resolving MCP server definitions (ADR-047). Secrets go to disk only through `SecretCrypto`
 * and come back to a caller only through `resolveLaunch` - which is for the connection layer in this process.
 */
export class McpConfigService {
  constructor(
    private readonly repo: McpServerRepository,
    private readonly crypto: SecretCrypto,
  ) {}

  list(): McpServerConfig[] {
    return this.repo.list()
  }

  get(id: string): McpServerConfig | null {
    return this.repo.get(id)
  }

  private readBundle(id: string): SecretBundle {
    const blob = this.repo.getSecrets(id)
    if (!blob || blob.length === 0) return emptyBundle()
    try {
      const parsed: unknown = JSON.parse(this.crypto.decrypt(blob))
      const record = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
      return { env: asStringRecord(record['env']), headers: asStringRecord(record['headers']) }
    } catch {
      // An undecryptable blob (a different OS user / keychain reset) behaves as "no secrets set"; saving replaces it.
      return emptyBundle()
    }
  }

  /**
   * Validates and stores a server. A secret entry with a value replaces the stored one; a secret entry with a null value
   * keeps what is stored for that key (and is an error if nothing is). Secrets for keys that are no longer listed are dropped.
   */
  save(raw: unknown): McpServerConfig {
    const parsed = SaveMcpServerInputSchema.safeParse(raw)
    if (!parsed.success) throw new McpConfigError(parsed.error.issues.map((i) => i.message))
    const input = parsed.data
    const problems = mcpConfigProblems(input)
    if (input.transport === 'stdio' && input.cwd !== null && !isAbsolute(input.cwd.trim())) problems.push('The working directory must be an absolute path.')
    if (input.id === undefined && this.repo.list().length >= MCP_LIMITS.maxServers) problems.push(`At most ${MCP_LIMITS.maxServers} servers can be saved.`)
    if (problems.length > 0) throw new McpConfigError(problems)

    const existingId = input.id
    const existing = existingId === undefined ? null : this.repo.get(existingId)
    if (existingId !== undefined && !existing) throw new McpConfigError(['That server no longer exists.'])
    const previous = existingId !== undefined ? this.readBundle(existingId) : emptyBundle()

    const bundle = emptyBundle()
    const missing: string[] = []
    const split = (
      entries: ParsedSaveMcpServerInput['env'],
      kept: Record<string, string>,
      target: Record<string, string>,
    ): { plain: McpPlainEntry[]; secretKeys: string[] } => {
      const plain: McpPlainEntry[] = []
      const secretKeys: string[] = []
      for (const entry of entries) {
        const key = entry.key.trim()
        if (!entry.secret) {
          plain.push({ key, value: entry.value ?? '' })
          continue
        }
        const value = entry.value ?? kept[key]
        if (value === undefined) {
          missing.push(key)
          continue
        }
        target[key] = value
        secretKeys.push(key)
      }
      return { plain, secretKeys }
    }

    const stdio = input.transport === 'stdio'
    const env = stdio ? split(input.env, previous.env, bundle.env) : { plain: [], secretKeys: [] }
    const headers = stdio ? { plain: [], secretKeys: [] } : split(input.headers, previous.headers, bundle.headers)
    if (missing.length > 0) throw new McpConfigError(missing.map((key) => `Enter a value for the secret "${key}".`))

    const hasSecrets = Object.keys(bundle.env).length + Object.keys(bundle.headers).length > 0
    const write: McpServerWrite = {
      name: input.name,
      transport: input.transport,
      command: stdio ? input.command.trim() : '',
      args: stdio ? input.args : [],
      cwd: stdio && input.cwd !== null ? input.cwd.trim() : null,
      env: env.plain,
      secretEnvKeys: env.secretKeys,
      url: stdio ? '' : input.url.trim(),
      headers: headers.plain,
      secretHeaderKeys: headers.secretKeys,
      secrets: hasSecrets ? this.crypto.encrypt(JSON.stringify(bundle)) : null,
      enabled: input.enabled,
    }
    return existingId === undefined ? this.repo.create(write) : this.repo.update(existingId, write)
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig {
    return this.repo.setEnabled(id, enabled)
  }

  setToolEnabled(id: string, tool: string, enabled: boolean): McpServerConfig {
    const config = this.repo.get(id)
    if (!config) throw new Error('That server no longer exists.')
    const disabled = new Set(config.disabledTools)
    if (enabled) disabled.delete(tool)
    else disabled.add(tool)
    return this.repo.setDisabledTools(id, [...disabled])
  }

  delete(id: string): void {
    this.repo.delete(id)
  }

  /** The definition with secrets decrypted, for the connection layer. Never send the result anywhere else. */
  resolveLaunch(id: string): McpLaunch {
    const config = this.repo.get(id)
    if (!config) throw new Error('That server no longer exists.')
    const bundle = this.readBundle(id)
    const toRecord = (entries: McpServerConfig['env'], secrets: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const entry of entries) {
        if (!entry.secret && entry.value !== null) out[entry.key] = entry.value
      }
      for (const entry of entries) {
        if (entry.secret && secrets[entry.key] !== undefined) out[entry.key] = secrets[entry.key] as string
      }
      return out
    }
    const env = toRecord(config.env, bundle.env)
    const headers = toRecord(config.headers, bundle.headers)
    return {
      id: config.id,
      name: config.name,
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env,
      url: config.url,
      headers,
      secretValues: [...Object.values(bundle.env), ...Object.values(bundle.headers)].filter((v) => v.length >= 4),
    }
  }
}
