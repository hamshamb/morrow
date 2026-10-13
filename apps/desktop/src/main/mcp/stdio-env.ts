/**
 * The environment of an MCP stdio server (ADR-050).
 *
 * The terminal tool's environment is "the app's, minus credentials" (a deny-list). A third-party program the user
 * installed deserves less: this is an ALLOW-list. It starts from the variables the MCP SDK itself inherits by default
 * (PATH, HOME/USERPROFILE, ...) plus a few a Windows or POSIX program needs to find its tools, and nothing else - so
 * `GITHUB_TOKEN`, `AWS_*`, `OPENAI_API_KEY` and the rest of the user's shell never reach a server unless the user
 * puts them in the server's own configuration. The configured variables (plain and decrypted secret) are added last
 * and win.
 */

const COMMON = ['PATH', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']
const WINDOWS = [
  'APPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'USERNAME',
  'USERPROFILE',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'PROGRAMDATA',
  'COMMONPROGRAMFILES',
  'ALLUSERSPROFILE',
  'PATHEXT',
  'COMSPEC',
  'WINDIR',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'COMPUTERNAME',
  'USERDOMAIN',
]
const POSIX = ['HOME', 'LOGNAME', 'SHELL', 'USER', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR']

export function inheritedEnvNames(platform: NodeJS.Platform): string[] {
  return [...COMMON, ...(platform === 'win32' ? WINDOWS : POSIX)]
}

export function buildMcpStdioEnv(base: NodeJS.ProcessEnv, platform: NodeJS.Platform, configured: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of inheritedEnvNames(platform)) {
    const value = base[name]
    if (value === undefined) continue
    // The SDK's own rule: a value starting with "()" is an exported shell function, which is code, not data.
    if (value.startsWith('()')) continue
    env[name] = value
  }
  for (const [key, value] of Object.entries(configured)) env[key] = value
  return env
}
