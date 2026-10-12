import { randomUUID } from 'node:crypto'
import { MAX_TERMINALS, type CreateTerminalInput, type TerminalEvent, type TerminalInfo } from '@ai-workspace/shared'
import type { ShellSpec } from './shell-detect'

/** The slice of a PTY process the manager needs (node-pty's IPty satisfies it). */
export interface PtyProcessLike {
  readonly pid: number
  onData(listener: (data: string) => void): unknown
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyProcessLike

export interface TerminalManagerOptions {
  /** Loads the native PTY lazily; rejects with a readable error if it can't load. */
  loadSpawn: () => Promise<PtySpawn>
  detectShell: () => ShellSpec
  buildEnv: () => Record<string, string>
  resolveRoot: (workspaceId: string) => string | null
  emit: (event: TerminalEvent) => void
  /** Max scrollback kept per terminal for repainting after a renderer reload. */
  bufferChars?: number
  /** Output is coalesced for this long before being emitted. */
  flushMs?: number
  maxTerminals?: number
}

interface Entry {
  info: TerminalInfo
  pty: PtyProcessLike
  buffer: string
  pending: string
  flushTimer: ReturnType<typeof setTimeout> | null
  removed: boolean
}

const MAX_WRITE_CHARS = 64 * 1024

/**
 * Owns every PTY (ADR-037). Terminals are created ONLY by an explicit
 * `create` call that originates from a user action in the UI - nothing here
 * runs a command by itself and nothing accepts commands from a model. Each
 * shell starts in its workspace root. All of them are killed by `killAll()`
 * on app quit, so no orphan shells survive the app.
 */
export class TerminalManager {
  private readonly entries = new Map<string, Entry>()
  private readonly bufferChars: number
  private readonly flushMs: number
  private readonly maxTerminals: number

  constructor(private readonly options: TerminalManagerOptions) {
    this.bufferChars = options.bufferChars ?? 200_000
    this.flushMs = options.flushMs ?? 8
    this.maxTerminals = options.maxTerminals ?? MAX_TERMINALS
  }

  async create(input: CreateTerminalInput): Promise<TerminalInfo> {
    const cwd = this.options.resolveRoot(input.workspaceId)
    if (!cwd) throw new Error('This workspace has no folder yet')
    if (this.entries.size >= this.maxTerminals) throw new Error(`At most ${this.maxTerminals} terminals can be open`)

    const spawn = await this.options.loadSpawn()
    if (this.entries.size >= this.maxTerminals) throw new Error(`At most ${this.maxTerminals} terminals can be open`)
    const shell = this.options.detectShell()
    let pty: PtyProcessLike
    try {
      pty = spawn(shell.file, shell.args, {
        name: 'xterm-256color',
        cols: input.cols,
        rows: input.rows,
        cwd,
        env: this.options.buildEnv(),
      })
    } catch (err) {
      throw new Error(`Could not start ${shell.title}: ${err instanceof Error ? err.message : String(err)}`)
    }

    const info: TerminalInfo = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      title: shell.title,
      shell: shell.file,
      cwd,
      pid: pty.pid > 0 ? pty.pid : null,
      status: 'running',
      exitCode: null,
      createdAt: Date.now(),
    }
    const entry: Entry = { info, pty, buffer: '', pending: '', flushTimer: null, removed: false }
    this.entries.set(info.id, entry)

    pty.onData((data) => {
      if (entry.removed) return
      entry.buffer += data
      if (entry.buffer.length > this.bufferChars) entry.buffer = entry.buffer.slice(-this.bufferChars)
      entry.pending += data
      if (entry.flushTimer === null) entry.flushTimer = setTimeout(() => this.flush(entry), this.flushMs)
    })
    pty.onExit((event) => {
      this.flush(entry)
      if (entry.info.status === 'exited') return
      entry.info = { ...entry.info, status: 'exited', exitCode: event.exitCode, pid: null }
      if (!entry.removed) {
        this.options.emit({ type: 'exit', id: info.id, exitCode: event.exitCode, signal: event.signal ?? null })
      }
    })
    return info
  }

  private flush(entry: Entry): void {
    if (entry.flushTimer !== null) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.pending === '' || entry.removed) {
      entry.pending = ''
      return
    }
    const data = entry.pending
    entry.pending = ''
    this.options.emit({ type: 'data', id: entry.info.id, data })
  }

  list(workspaceId: string): TerminalInfo[] {
    return [...this.entries.values()].filter((e) => e.info.workspaceId === workspaceId).map((e) => this.snapshot(e))
  }

  /** On Windows ConPTY reports its pid only once the console is up, so read it lazily. */
  private snapshot(entry: Entry): TerminalInfo {
    if (entry.info.status === 'running' && entry.info.pid === null && entry.pty.pid > 0) {
      entry.info = { ...entry.info, pid: entry.pty.pid }
    }
    return entry.info
  }

  getBuffer(id: string): string {
    return this.entries.get(id)?.buffer ?? ''
  }

  write(id: string, data: string): void {
    const entry = this.entries.get(id)
    if (!entry || entry.info.status !== 'running') return
    if (data.length > MAX_WRITE_CHARS) throw new Error('Input too large')
    entry.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id)
    if (!entry || entry.info.status !== 'running') return
    try {
      entry.pty.resize(cols, rows)
    } catch {
      // The process may have just exited; the exit event is on its way.
    }
  }

  /** Kills the process (if still running) and forgets the terminal. Idempotent. */
  kill(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.removed = true
    if (entry.flushTimer !== null) clearTimeout(entry.flushTimer)
    entry.flushTimer = null
    this.entries.delete(id)
    if (entry.info.status === 'running') {
      try {
        entry.pty.kill()
      } catch {
        // Already gone.
      }
    }
  }

  /** App quit: no shell outlives the app. */
  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }

  get size(): number {
    return this.entries.size
  }
}
