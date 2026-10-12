import { mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAgentEnv, detectAgentShell, killAllCommandsSync, runCommand, stripAnsi, wrapPowerShell, type RunCommandOptions } from '../agent/command-runner'

const shell = detectAgentShell({ platform: process.platform, env: process.env })
let dir: string

beforeAll(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-runner-')))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function run(command: string, extra: Partial<RunCommandOptions> = {}) {
  return runCommand({
    command,
    cwd: dir,
    timeoutMs: 30_000,
    env: buildAgentEnv(process.env).env,
    shell,
    outputCapBytes: 64 * 1024,
    ...extra,
  })
}

describe('detectAgentShell', () => {
  it('Windows: PowerShell 7 with no profile and non-interactive, falling back to Windows PowerShell then cmd', () => {
    const base = { platform: 'win32' as const, env: { PATH: 'C:\\pwsh', SystemRoot: 'C:\\Windows' } }
    const pwsh = detectAgentShell({ ...base, exists: (p) => p.endsWith('pwsh.exe') })
    expect(pwsh).toMatchObject({ kind: 'powershell', title: 'PowerShell 7' })
    const args = pwsh.args('echo hi')
    expect(args.slice(0, 5)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
    expect(args[5]).toBe('-Command')
    expect(args[6]).toContain('echo hi')

    const winPs = detectAgentShell({ ...base, exists: (p) => p.endsWith('powershell.exe') })
    expect(winPs).toMatchObject({ kind: 'powershell', title: 'PowerShell' })
    const cmd = detectAgentShell({ ...base, exists: () => false })
    expect(cmd).toMatchObject({ kind: 'cmd' })
    expect(cmd.args('dir')).toEqual(['/d', '/s', '/c', '"dir"'])
  })

  it('POSIX: bash with no profile or rc, never a login shell, else sh', () => {
    const bash = detectAgentShell({ platform: 'linux', env: {}, exists: (p) => p === '/bin/bash' })
    expect(bash).toMatchObject({ file: '/bin/bash', kind: 'posix' })
    expect(bash.args('ls')).toEqual(['--noprofile', '--norc', '-c', 'ls'])
    const sh = detectAgentShell({ platform: 'linux', env: {}, exists: () => false })
    expect(sh.file).toBe('/bin/sh')
    expect(sh.args('ls')).toEqual(['-c', 'ls'])
  })

  it('wraps PowerShell commands so the real exit code survives', () => {
    const wrapped = wrapPowerShell('pnpm test')
    expect(wrapped).toContain('pnpm test')
    expect(wrapped).toContain('$LASTEXITCODE')
    // The user's command stays on its own line so a trailing comment cannot swallow the epilogue.
    expect(wrapped.split('\n').some((l) => l === 'pnpm test')).toBe(true)
  })
})

describe('buildAgentEnv - the child never inherits secrets', () => {
  it('drops credential-looking variables by name and known secret values, plus Electron switches', () => {
    const { env, removed } = buildAgentEnv(
      {
        PATH: '/bin',
        HOME: '/home/x',
        GITHUB_TOKEN: 'ghp_x',
        AWS_SECRET_ACCESS_KEY: 'abc',
        NPM_TOKEN: 't',
        OPENAI_API_KEY: 'sk-live',
        ANTHROPIC_API_KEY: 'sk-ant-live',
        DB_PASSWORD: 'pw',
        INNOCENT_NAME: 'contains the-decrypted-provider-key inside',
        ELECTRON_RUN_AS_NODE: '1',
        ELECTRON_RENDERER_URL: 'http://x',
        NODE_OPTIONS: '--inspect',
        TERMINAL_COLUMNS: '80',
        MAX_TOKENS_PER_MINUTE: '5',
      },
      ['the-decrypted-provider-key'],
    )
    expect(Object.keys(env)).toEqual(expect.arrayContaining(['PATH', 'HOME', 'TERMINAL_COLUMNS']))
    for (const gone of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DB_PASSWORD', 'INNOCENT_NAME', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(gone)
    }
    expect(removed).toEqual(expect.arrayContaining(['GITHUB_TOKEN', 'OPENAI_API_KEY', 'INNOCENT_NAME']))
    // The audit log gets names only, never values.
    expect(JSON.stringify(removed)).not.toContain('ghp_x')
    expect(env['NO_COLOR']).toBe('1')
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0')
  })

  it("the app's own process environment holds no provider key shapes (providers live in safeStorage)", () => {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      expect(`${key}=${value}`).not.toMatch(/sk-ant-[A-Za-z0-9_-]{16,}|\bsk-[A-Za-z0-9]{32,}/)
    }
  })
})

describe('runCommand - real shell', () => {
  it('captures output and the exit code 0', async () => {
    const result = await run('node -e "console.log(6*7)"')
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false, truncated: false, spawnError: null })
    expect(result.output.trim()).toBe('42')
  })

  it('preserves a real non-zero exit code (PowerShell would otherwise report 1)', async () => {
    const result = await run('node -e "process.exit(3)"')
    expect(result.exitCode).toBe(3)
  })

  it('reports failure of a shell-level error', async () => {
    const result = await run('definitely-not-a-real-command-xyz')
    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBeNull()
  })

  it('captures stderr in the same stream, in order', async () => {
    const result = await run('node -e "console.log(\'out-1\'); console.error(\'err-1\')"')
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('out-1')
    expect(result.output).toContain('err-1')
  })

  it('runs in the given working directory', async () => {
    const result = await run('node -e "console.log(process.cwd())"')
    expect(realpathSync.native(result.output.trim())).toBe(dir)
  })

  it('stdin is closed, so a program that waits for input sees end-of-file instead of hanging', async () => {
    const result = await run('node -e "process.stdin.on(\'end\',()=>console.log(\'saw-eof\')); process.stdin.resume()"', { timeoutMs: 20_000 })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('saw-eof')
  })

  it('keeps UTF-8 output intact', async () => {
    const result = await run('node -e "console.log(\'h\\u00e9llo \\u2713\')"')
    expect(result.output.trim()).toBe('héllo ✓')
  })

  it('removes terminal colour codes from the output even when the parent environment forces colour', async () => {
    process.env['FORCE_COLOR'] = '1'
    try {
      const { env } = buildAgentEnv(process.env)
      expect(env['FORCE_COLOR']).toBeUndefined()
      const result = await run('node -e "console.log(String.fromCharCode(27) + \'[31mred\' + String.fromCharCode(27) + \'[0m plain\')"', { env })
      expect(result.output.trim()).toBe('red plain')
      expect(result.output).not.toContain(String.fromCharCode(27))
    } finally {
      delete process.env['FORCE_COLOR']
    }
  })

  it('stripAnsi removes colour, cursor and title sequences and nothing else', () => {
    const esc = String.fromCharCode(27)
    expect(stripAnsi(`${esc}[32mok${esc}[39m ${esc}[1;4mbold${esc}[0m ${esc}]0;title\u0007done ${esc}[2K${esc}[1Gline`)).toBe('ok bold done line')
    expect(stripAnsi('plain [32m text with brackets')).toBe('plain [32m text with brackets')
  })

  it('keeps quotes and spaces in arguments', async () => {
    const result = await run('node -e "console.log(JSON.stringify([\'a b\', \'c\']))"')
    expect(result.output.trim()).toBe('["a b","c"]')
  })

  it('streams output to the live listener as it arrives', async () => {
    const chunks: string[] = []
    const result = await run('node -e "console.log(\'live-1\')"', { onOutput: (c) => chunks.push(c) })
    expect(chunks.join('')).toContain('live-1')
    expect(result.output).toContain('live-1')
  })

  it('times out and kills the command', async () => {
    const started = Date.now()
    const result = await run('node -e "setTimeout(()=>{},60000)"', { timeoutMs: 700 })
    expect(result.timedOut).toBe(true)
    expect(result.cancelled).toBe(false)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('cancel kills the command mid-run', async () => {
    const controller = new AbortController()
    const started = Date.now()
    const promise = run('node -e "console.log(\'started\'); setTimeout(()=>{},60000)"', { signal: controller.signal })
    setTimeout(() => controller.abort(), 800)
    const result = await promise
    expect(result.cancelled).toBe(true)
    expect(Date.now() - started).toBeLessThan(15_000)
  })

  it('a signal that is already aborted never starts the process', async () => {
    const marker = join(dir, 'should-not-exist.txt')
    const controller = new AbortController()
    controller.abort()
    const result = await run(`node -e "require('fs').writeFileSync(process.argv[1],'x')" "${marker.replace(/\\/g, '/')}"`, { signal: controller.signal })
    expect(result.cancelled).toBe(true)
    expect(existsSync(marker)).toBe(false)
  })

  it('cancel kills the whole process tree, not just the shell', async () => {
    const marker = join(dir, 'grandchild-wrote-this.txt').replace(/\\/g, '/')
    writeFileSync(
      join(dir, 'child.js'),
      `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500)\n`,
    )
    writeFileSync(
      join(dir, 'parent.js'),
      `require('child_process').spawn(process.execPath, ['child.js'], { stdio: 'ignore' })\nsetTimeout(() => {}, 60000)\n`,
    )
    const controller = new AbortController()
    const promise = run('node parent.js', { signal: controller.signal })
    setTimeout(() => controller.abort(), 900)
    const result = await promise
    expect(result.cancelled).toBe(true)
    await new Promise((r) => setTimeout(r, 3500))
    expect(existsSync(marker)).toBe(false)
  })

  it('killAllCommandsSync (the app is quitting) kills every running command tree before it returns', async () => {
    const marker = join(dir, 'quit-grandchild.txt').replace(/\\/g, '/')
    writeFileSync(join(dir, 'qchild.js'), `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500)\n`)
    writeFileSync(join(dir, 'qparent.js'), `require('child_process').spawn(process.execPath, ['qchild.js'], { stdio: 'ignore' })\nsetTimeout(() => {}, 60000)\n`)
    const running = run('node qparent.js')
    await new Promise((r) => setTimeout(r, 900))
    killAllCommandsSync() // synchronous: nothing may survive this call returning
    const result = await running
    expect(result.exitCode === null || result.exitCode !== 0).toBe(true)
    await new Promise((r) => setTimeout(r, 3500))
    expect(existsSync(marker)).toBe(false)
  })

  it('keeps the TAIL of very large output and says it was truncated', async () => {
    const result = await run('node -e "for (let i = 0; i < 40000; i++) console.log(\'line-\' + i + \' \' + \'x\'.repeat(40)); console.log(\'THE-END\')"', {
      outputCapBytes: 8 * 1024,
      timeoutMs: 60_000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.truncated).toBe(true)
    expect(result.totalBytes).toBeGreaterThan(1_500_000)
    expect(result.output).toContain('THE-END')
    expect(result.output).not.toContain('line-0 ')
    expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(2 * 8 * 1024)
  })

  it('reports a spawn failure instead of throwing', async () => {
    const result = await runCommand({
      command: 'x',
      cwd: dir,
      timeoutMs: 5000,
      env: {},
      shell: { file: join(dir, 'no-such-shell.exe'), args: () => [], title: 'none', kind: 'posix' },
      outputCapBytes: 1024,
    })
    expect(result.exitCode).toBeNull()
    expect(result.spawnError).toBeTruthy()
  })
})
