import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface ShellSpec {
  /** Executable to spawn. */
  file: string
  args: string[]
  /** Short human name for the terminal tab: "PowerShell", "bash"... */
  title: string
}

export interface ShellDetectEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** Injected for tests. */
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
 * Picks the user's shell without running anything (ADR-037).
 *  - Windows: PowerShell 7 (`pwsh`) when installed, else Windows PowerShell,
 *    else `%ComSpec%` (cmd.exe).
 *  - macOS / Linux: `$SHELL`, else bash, else sh. macOS gets a login shell
 *    (that is what Terminal.app starts); Linux does not.
 */
export function detectShell({ platform, env, exists = existsSync }: ShellDetectEnv): ShellSpec {
  if (platform === 'win32') {
    const pwsh = findOnPath('pwsh.exe', env, exists)
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], title: 'PowerShell 7' }
    const systemRoot = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? 'C:\\Windows'
    const winPs = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (exists(winPs)) return { file: winPs, args: ['-NoLogo'], title: 'PowerShell' }
    return { file: env['ComSpec'] ?? env['COMSPEC'] ?? 'cmd.exe', args: [], title: 'cmd' }
  }

  const fromEnv = env['SHELL']
  const file = fromEnv && exists(fromEnv) ? fromEnv : ['/bin/bash', '/usr/bin/bash', '/bin/sh'].find((p) => exists(p)) ?? '/bin/sh'
  const title = file.split('/').pop() ?? 'shell'
  return { file, args: platform === 'darwin' ? ['-l'] : [], title }
}

/**
 * The environment handed to a terminal: the app's own, minus Electron/Node
 * switches that would change how child programs behave, plus the terminal
 * capability variables xterm.js supports.
 */
export function buildTerminalEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS' || key.startsWith('ELECTRON_')) continue
    env[key] = value
  }
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'ai-workspace'
  return env
}
