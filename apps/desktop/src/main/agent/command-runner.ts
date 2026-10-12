import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

/**
 * Runs ONE command non-interactively for `terminal.execute` (ADR-042/043). It is
 * never a PTY session: stdin is closed, the shell is started with no profile,
 * the output is capped (the tail is kept), there is a timeout, and the whole
 * process tree is killed on timeout or cancel.
 */

export interface AgentShell {
  file: string
  /** Builds the argument array for one command string. */
  args(command: string): string[]
  /** Shown in the prompt: "PowerShell 7", "bash". */
  title: string
  kind: 'powershell' | 'cmd' | 'posix'
  /** Windows cmd needs its command line passed through untouched. */
  verbatim?: boolean
}

export interface ShellDetectInput {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists?: (path: string) => boolean
}

function findOnPath(name: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean): string | null {
  const pathValue = env['PATH'] ?? env['Path'] ?? ''
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, name)
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * PowerShell on Windows drops a native program's exit code to 0/1 under `-Command`
 * (`node -e "process.exit(3)"` exits 1), which would make "exit 0" claims in the run report
 * unreliable. The wrapper restores the real code: it exits with `$LASTEXITCODE` when the last
 * native command failed, and with 1 when a cmdlet failed. It also forces UTF-8 output.
 */
const POWERSHELL_PREAMBLE = '$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ProgressPreference = "SilentlyContinue"\n'
const POWERSHELL_EPILOGUE = '\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } } elseif ($LASTEXITCODE) { exit $LASTEXITCODE }'

export function wrapPowerShell(command: string): string {
  return `${POWERSHELL_PREAMBLE}${command}${POWERSHELL_EPILOGUE}`
}

/** The shell used for agent commands: no profile, non-interactive (ADR-042). */
export function detectAgentShell({ platform, env, exists = existsSync }: ShellDetectInput): AgentShell {
  if (platform === 'win32') {
    const ps = (file: string, title: string): AgentShell => ({
      file,
      title,
      kind: 'powershell',
      args: (command) => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapPowerShell(command)],
    })
    const pwsh = findOnPath('pwsh.exe', env, exists)
    if (pwsh) return ps(pwsh, 'PowerShell 7')
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
    const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(winPs)) return ps(winPs, 'PowerShell')
    return {
      file: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe',
      title: 'cmd',
      kind: 'cmd',
      verbatim: true,
      args: (command) => ['/d', '/s', '/c', `"${command}"`],
    }
  }
  const bash = ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash'].find((p) => exists(p))
  if (bash) return { file: bash, title: 'bash', kind: 'posix', args: (command) => ['--noprofile', '--norc', '-c', command] }
  return { file: '/bin/sh', title: 'sh', kind: 'posix', args: (command) => ['-c', command] }
}

const SECRET_NAME = /(?:^|_)(?:API_?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PRIVATE_?KEY|ACCESS_?KEY(?:_?ID)?|SESSION_?KEY)(?:$|_)/i
const PROVIDER_ENV = /^(?:ANTHROPIC|OPENAI|GOOGLE_GENERATIVE_AI|GEMINI|XAI|MISTRAL|GROQ|DEEPSEEK|CEREBRAS|TOGETHER(?:AI)?|PERPLEXITY|OPENROUTER|COHERE|AZURE_OPENAI|HF|HUGGINGFACE)[A-Z_]*(?:KEY|TOKEN)$/i

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

/** Removes terminal colour/cursor escape sequences: the model and the activity rows want text, not "ESC[32m". */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

export interface AgentEnv {
  env: Record<string, string>
  /** Names that were removed because they look like credentials - shown in the audit log, never their values. */
  removed: string[]
}

/**
 * The environment a command runs in: the app's own, minus Electron/Node switches and anything that looks
 * like a credential (by name, or by value when it equals a known secret such as a decrypted provider key).
 * The app itself keeps provider keys encrypted in the OS keychain and never in `process.env`, so normally
 * nothing provider-related is here at all; this removes the user's own tokens (GITHUB_TOKEN, AWS_*, ...)
 * so a prompt-injected command cannot simply echo them.
 */
export function buildAgentEnv(base: NodeJS.ProcessEnv, knownSecrets: readonly string[] = []): AgentEnv {
  const env: Record<string, string> = {}
  const removed: string[] = []
  const secrets = knownSecrets.filter((s) => s.length >= 8)
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS' || key.startsWith('ELECTRON_')) continue
    // Colour is requested by the parent (a test runner, a CI shell) and would put escape codes in the output.
    if (key === 'FORCE_COLOR' || key === 'CLICOLOR_FORCE') continue
    if (SECRET_NAME.test(key) || PROVIDER_ENV.test(key) || secrets.some((s) => value.includes(s))) {
      removed.push(key)
      continue
    }
    env[key] = value
  }
  env['NO_COLOR'] = '1'
  env['TERM'] = 'dumb'
  env['GIT_TERMINAL_PROMPT'] = '0'
  env['GIT_EDITOR'] = 'true'
  env['GIT_PAGER'] = 'cat'
  env['PAGER'] = 'cat'
  return { env, removed }
}

export interface RunCommandOptions {
  command: string
  cwd: string
  timeoutMs: number
  signal?: AbortSignal | undefined
  env: Record<string, string>
  shell: AgentShell
  /** Largest tail of output kept, in bytes. */
  outputCapBytes: number
  /** Called with decoded text as it arrives (for the live Output view). */
  onOutput?: ((chunk: string) => void) | undefined
}

export interface RunCommandResult {
  /** null when the process never started or was killed by a signal. */
  exitCode: number | null
  timedOut: boolean
  cancelled: boolean
  durationMs: number
  /** The tail of combined stdout + stderr (arrival order). */
  output: string
  /** Output exceeded the cap: the beginning was dropped. */
  truncated: boolean
  totalBytes: number
  spawnError: string | null
}

/** Commands that are running right now, so a quitting app can kill them before it exits. */
const runningCommands = new Set<ChildProcess>()

/**
 * Kills every running command's whole process tree and WAITS for it. Used when the app quits: an asynchronous
 * `taskkill` started on the way out can be cut short by the exit itself, which would leave the command running.
 */
export function killAllCommandsSync(): void {
  for (const child of [...runningCommands]) killProcessTree(child, { sync: true })
}

/** Kills a process and everything it started. */
export function killProcessTree(child: ChildProcess, options: { sync?: boolean } = {}): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    if (options.sync) {
      try {
        execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 8000 })
      } catch {
        /* already gone, or taskkill refused: nothing more to do */
      }
      return
    }
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined)
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

const KILL_GRACE_MS = 4000

export function runCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const cap = Math.max(1024, options.outputCapBytes)
    let kept: Buffer[] = []
    let keptBytes = 0
    let totalBytes = 0
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    let graceTimer: NodeJS.Timeout | undefined
    let onAbort: (() => void) | undefined
    let child: ChildProcess | null = null
    const decoder = new StringDecoder('utf8')

    const finish = (exitCode: number | null, spawnError: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      if (onAbort) options.signal?.removeEventListener('abort', onAbort)
      if (child) runningCommands.delete(child)
      let output = stripAnsi(Buffer.concat(kept).toString('utf8'))
      if (truncated) output = output.replace(/^\uFFFD+/, '')
      resolve({
        exitCode,
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
        output,
        truncated,
        totalBytes,
        spawnError,
      })
    }

    const push = (chunk: Buffer): void => {
      totalBytes += chunk.length
      kept.push(chunk)
      keptBytes += chunk.length
      if (keptBytes > cap * 2) {
        // Keep only the newest `cap` bytes.
        const all = Buffer.concat(kept)
        kept = [all.subarray(all.length - cap)]
        keptBytes = cap
        truncated = true
      }
      if (options.onOutput) {
        const text = stripAnsi(decoder.write(chunk))
        if (text) options.onOutput(text)
      }
    }

    if (options.signal?.aborted) {
      cancelled = true
      finish(null, null)
      return
    }

    try {
      child = spawn(options.shell.file, options.shell.args(options.command), {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
        windowsVerbatimArguments: options.shell.verbatim === true,
      })
    } catch (err) {
      finish(null, err instanceof Error ? err.message : String(err))
      return
    }

    runningCommands.add(child)
    const proc = child
    proc.stdout?.on('data', push)
    proc.stderr?.on('data', push)
    proc.on('error', (err) => finish(null, err.message))
    proc.on('close', (code) => finish(code, null))

    const stop = (): void => {
      killProcessTree(proc)
      // If the tree refuses to die (or a grandchild holds the pipes open), do not hang the run.
      graceTimer = setTimeout(() => finish(null, null), KILL_GRACE_MS)
    }
    timer = setTimeout(() => {
      timedOut = true
      stop()
    }, options.timeoutMs)
    onAbort = (): void => {
      cancelled = true
      stop()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}
