import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalEvent } from '@ai-workspace/shared'
import { buildTerminalEnv, detectShell } from '../code/shell-detect'
import { loadNativeSpawn } from '../code/pty-native'
import { TerminalManager, type PtyProcessLike, type PtySpawn } from '../code/terminal-manager'

describe('detectShell', () => {
  const exists = (present: string[]) => (p: string) => present.includes(p)

  it('Windows: prefers pwsh on PATH, then Windows PowerShell, then cmd', () => {
    const env = { PATH: 'C:\\tools;C:\\Program Files\\PowerShell\\7', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }
    const pwshPath = join('C:\\Program Files\\PowerShell\\7', 'pwsh.exe')
    const winPs = join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

    expect(detectShell({ platform: 'win32', env, exists: exists([pwshPath, winPs]) })).toEqual({ file: pwshPath, args: ['-NoLogo'], title: 'PowerShell 7' })
    expect(detectShell({ platform: 'win32', env, exists: exists([winPs]) })).toEqual({ file: winPs, args: ['-NoLogo'], title: 'PowerShell' })
    expect(detectShell({ platform: 'win32', env, exists: exists([]) })).toEqual({ file: 'C:\\Windows\\System32\\cmd.exe', args: [], title: 'cmd' })
  })

  it('macOS / Linux: $SHELL when it exists, else bash, else sh; login shell on macOS only', () => {
    expect(detectShell({ platform: 'linux', env: { SHELL: '/usr/bin/zsh' }, exists: exists(['/usr/bin/zsh']) })).toEqual({ file: '/usr/bin/zsh', args: [], title: 'zsh' })
    expect(detectShell({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exists: exists(['/bin/zsh']) })).toEqual({ file: '/bin/zsh', args: ['-l'], title: 'zsh' })
    expect(detectShell({ platform: 'linux', env: { SHELL: '/gone/fish' }, exists: exists(['/bin/bash']) }).file).toBe('/bin/bash')
    expect(detectShell({ platform: 'linux', env: {}, exists: exists([]) }).file).toBe('/bin/sh')
  })
})

describe('buildTerminalEnv', () => {
  it('drops Electron/Node switches and sets terminal capabilities', () => {
    const env = buildTerminalEnv({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', ELECTRON_RENDERER_URL: 'http://x', NODE_OPTIONS: '--inspect', HOME: '/h' })
    expect(env['PATH']).toBe('/bin')
    expect(env['HOME']).toBe('/h')
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined()
    expect(env['ELECTRON_RENDERER_URL']).toBeUndefined()
    expect(env['NODE_OPTIONS']).toBeUndefined()
    expect(env['TERM']).toBe('xterm-256color')
    expect(env['COLORTERM']).toBe('truecolor')
  })
})

/** A scriptable stand-in for a PTY. */
class FakePty implements PtyProcessLike {
  static nextPid = 1000
  pid = FakePty.nextPid++
  written: string[] = []
  resizes: [number, number][] = []
  killed = 0
  private dataListeners: ((d: string) => void)[] = []
  private exitListeners: ((e: { exitCode: number; signal?: number | undefined }) => void)[] = []
  onData(l: (d: string) => void) {
    this.dataListeners.push(l)
  }
  onExit(l: (e: { exitCode: number; signal?: number | undefined }) => void) {
    this.exitListeners.push(l)
  }
  write(d: string) {
    this.written.push(d)
  }
  resize(c: number, r: number) {
    this.resizes.push([c, r])
  }
  kill() {
    this.killed += 1
    this.emitExit(137)
  }
  emitData(d: string) {
    for (const l of this.dataListeners) l(d)
  }
  emitExit(code: number) {
    for (const l of this.exitListeners) l({ exitCode: code })
  }
}

describe('TerminalManager lifecycle (fake PTY)', () => {
  let ptys: FakePty[]
  let spawnCalls: { file: string; args: string[]; cwd: string; cols: number; rows: number }[]
  let events: TerminalEvent[]
  let manager: TerminalManager

  beforeEach(() => {
    vi.useFakeTimers()
    FakePty.nextPid = 1000
    ptys = []
    spawnCalls = []
    events = []
    const spawn: PtySpawn = (file, args, options) => {
      spawnCalls.push({ file, args, cwd: options.cwd, cols: options.cols, rows: options.rows })
      const p = new FakePty()
      ptys.push(p)
      return p
    }
    manager = new TerminalManager({
      loadSpawn: () => Promise.resolve(spawn),
      detectShell: () => ({ file: '/bin/fakesh', args: ['-x'], title: 'fakesh' }),
      buildEnv: () => ({ TERM: 'xterm-256color' }),
      resolveRoot: (id) => (id === 'ws' ? '/work/repo' : null),
      emit: (e) => events.push(e),
      maxTerminals: 3,
      bufferChars: 20,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('spawns the detected shell in the workspace root with the requested size', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 100, rows: 30 })
    expect(spawnCalls).toEqual([{ file: '/bin/fakesh', args: ['-x'], cwd: '/work/repo', cols: 100, rows: 30 }])
    expect(info).toMatchObject({ workspaceId: 'ws', title: 'fakesh', cwd: '/work/repo', status: 'running', pid: 1000, exitCode: null })
    expect(manager.list('ws')).toEqual([info])
    expect(manager.list('other')).toEqual([])
  })

  it('refuses a workspace with no folder, and more than the maximum number of terminals', async () => {
    await expect(manager.create({ workspaceId: 'nope', cols: 80, rows: 24 })).rejects.toThrow(/no folder/)
    for (let i = 0; i < 3; i += 1) await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    await expect(manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })).rejects.toThrow(/At most 3/)
  })

  it('turns a spawn failure into a readable error and registers nothing', async () => {
    const failing = new TerminalManager({
      loadSpawn: () =>
        Promise.resolve(() => {
          throw new Error('ENOENT: no such shell')
        }),
      detectShell: () => ({ file: 'nope', args: [], title: 'nope' }),
      buildEnv: () => ({}),
      resolveRoot: () => '/x',
      emit: () => undefined,
    })
    await expect(failing.create({ workspaceId: 'ws', cols: 80, rows: 24 })).rejects.toThrow(/Could not start nope: ENOENT/)
    expect(failing.size).toBe(0)
  })

  it('coalesces output into one event per flush window and forwards input and resizes', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    const pty = ptys[0] as FakePty
    pty.emitData('he')
    pty.emitData('llo')
    expect(events).toEqual([])
    vi.advanceTimersByTime(10)
    expect(events).toEqual([{ type: 'data', id: info.id, data: 'hello' }])

    manager.write(info.id, 'ls\r')
    manager.resize(info.id, 120, 40)
    expect(pty.written).toEqual(['ls\r'])
    expect(pty.resizes).toEqual([[120, 40]])
    expect(() => manager.write(info.id, 'x'.repeat(70_000))).toThrow(/too large/)
  })

  it('keeps a bounded scrollback for repainting after a renderer reload', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    ;(ptys[0] as FakePty).emitData('0123456789'.repeat(5))
    expect(manager.getBuffer(info.id)).toBe('01234567890123456789')
    expect(manager.getBuffer('unknown')).toBe('')
  })

  it('records the exit status when the process ends and ignores later input', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    const pty = ptys[0] as FakePty
    pty.emitData('bye')
    pty.emitExit(3)
    expect(events).toEqual([
      { type: 'data', id: info.id, data: 'bye' },
      { type: 'exit', id: info.id, exitCode: 3, signal: null },
    ])
    expect(manager.list('ws')[0]).toMatchObject({ status: 'exited', exitCode: 3, pid: null })
    manager.write(info.id, 'ignored')
    manager.resize(info.id, 10, 10)
    expect(pty.written).toEqual([])
    expect(pty.resizes).toEqual([])
  })

  it('kill stops a running process, forgets the terminal and is idempotent', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    const pty = ptys[0] as FakePty
    manager.kill(info.id)
    expect(pty.killed).toBe(1)
    expect(manager.list('ws')).toEqual([])
    manager.kill(info.id)
    expect(pty.killed).toBe(1)
    expect(events.filter((e) => e.type === 'exit')).toEqual([]) // forgotten terminals stay silent
  })

  it('killing an already-exited terminal just removes it (no second kill)', async () => {
    const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    const pty = ptys[0] as FakePty
    pty.emitExit(0)
    manager.kill(info.id)
    expect(pty.killed).toBe(0)
    expect(manager.size).toBe(0)
  })

  it('killAll leaves no terminal running (app quit)', async () => {
    for (let i = 0; i < 3; i += 1) await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
    ;(ptys[1] as FakePty).emitExit(0) // one already exited on its own
    manager.killAll()
    expect(manager.size).toBe(0)
    expect(ptys.map((p) => p.killed)).toEqual([1, 0, 1])
  })

  it('never starts a terminal on its own', () => {
    expect(spawnCalls).toEqual([])
    expect(manager.size).toBe(0)
  })
})

describe('real PTY smoke test (native @lydell/node-pty)', () => {
  let dir: string
  beforeEach(() => {
    dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-pty-')))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('starts the detected shell in the workspace folder, runs `echo`, reports output, and kills the process', async () => {
    const output: string[] = []
    const exits: TerminalEvent[] = []
    const manager = new TerminalManager({
      loadSpawn: loadNativeSpawn,
      detectShell: () => detectShell({ platform: process.platform, env: process.env }),
      buildEnv: () => buildTerminalEnv(process.env),
      resolveRoot: () => dir,
      emit: (e) => {
        if (e.type === 'data') output.push(e.data)
        else exits.push(e)
      },
    })
    try {
      const info = await manager.create({ workspaceId: 'ws', cols: 100, rows: 30 })
      expect(info.status).toBe('running')

      manager.write(info.id, 'echo hello-from-pty-smoke\r')
      const deadline = Date.now() + 20_000
      // The prompt line also contains the typed command; the *output* is the second occurrence.
      const seen = () => output.join('').split('hello-from-pty-smoke').length - 1
      while (seen() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(seen(), `terminal output so far: ${JSON.stringify(output.join(''))}`).toBeGreaterThanOrEqual(2)

      const pid = manager.list('ws')[0]?.pid ?? 0
      expect(pid).toBeGreaterThan(0) // ConPTY reports it once the console is up
      manager.resize(info.id, 80, 24) // must not throw on a live PTY
      manager.kill(info.id)
      expect(manager.size).toBe(0)

      // The shell process is really gone.
      const gone = async (): Promise<boolean> => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }
      const killDeadline = Date.now() + 10_000
      while (!(await gone()) && Date.now() < killDeadline) await new Promise((r) => setTimeout(r, 100))
      expect(await gone()).toBe(true)
    } finally {
      manager.killAll()
    }
  }, 40_000)

  it('reports the exit code when the shell exits by itself', async () => {
    const exits: TerminalEvent[] = []
    const manager = new TerminalManager({
      loadSpawn: loadNativeSpawn,
      detectShell: () => detectShell({ platform: process.platform, env: process.env }),
      buildEnv: () => buildTerminalEnv(process.env),
      resolveRoot: () => dir,
      emit: (e) => {
        if (e.type === 'exit') exits.push(e)
      },
    })
    try {
      const info = await manager.create({ workspaceId: 'ws', cols: 80, rows: 24 })
      manager.write(info.id, 'exit 7\r')
      const deadline = Date.now() + 20_000
      while (exits.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      expect(exits).toHaveLength(1)
      expect(exits[0]).toMatchObject({ type: 'exit', id: info.id, exitCode: 7 })
      expect(manager.list('ws')[0]).toMatchObject({ status: 'exited', exitCode: 7 })
    } finally {
      manager.killAll()
    }
  }, 40_000)
})
