import { basename } from 'node:path/posix'

/**
 * Conservative risk classifier for `terminal.execute` commands (ADR-042).
 *
 * THIS IS A SPEED BUMP, NOT A SANDBOX. It reads the command text with a small
 * shell-ish tokenizer and recognises well-known destructive, network and
 * "can't tell what this runs" shapes. It does not execute, resolve aliases or
 * variables, follow scripts, or understand every shell. The real control is
 * that no command runs without the user seeing the exact text and approving
 * it (and `destructive` ones can only be allowed once, never granted).
 * What it deliberately cannot see is listed in docs/DECISIONS.md ADR-042:
 * a script/Makefile/npm script that deletes things, `node -e` code built at
 * runtime, anything reached through an alias or a function, data piped into a
 * non-shell program that then deletes, and any obfuscation that needs the
 * shell to evaluate (e.g. `eval "$(...)"` is flagged, but `$'\x72\x6d' file` is
 * seen only as a computed command name).
 *
 * Unknown commands are `execution`: ask unless the user granted that exact command.
 */

export type CommandRisk = 'execution' | 'network' | 'destructive'

export interface CommandAssessment {
  risk: CommandRisk
  /** Can only ever be allowed once - never remembered for a session or workspace. */
  noGrant: boolean
  /** Why, in words the prompt can show (empty for a plain `execution`). */
  reasons: string[]
}

interface Finding {
  risk: CommandRisk
  reason: string
  noGrant?: boolean
}

// ---------------------------------------------------------------- tokenizer

interface Word {
  /** Text with quotes removed and PowerShell/posix escapes collapsed enough for matching. */
  text: string
  /** The original spelling (for redirect targets and error text). */
  raw: string
  /** Part of the word was quoted. */
  quoted: boolean
  /** Contains `$var`, `${...}`, `%VAR%`, a command substitution, or a backtick - resolved only by the shell. */
  dynamic: boolean
}

interface Redirect {
  op: string
  target: Word | null
}

interface Segment {
  words: Word[]
  redirects: Redirect[]
  /** Its stdin comes from the previous segment (`a | b`). */
  piped: boolean
}

interface Parsed {
  segments: Segment[]
  /** Inner commands of `$( ... )` / backticks, analysed as commands of their own. */
  nested: string[]
}

const MAX_DEPTH = 4
const MAX_COMMAND_CHARS = 20_000

/** Finds the matching `)` for a `$(` whose content starts at `start`. Returns the index of the `)` or -1. */
function matchParen(text: string, start: number): number {
  let depth = 1
  let quote: string | null = null
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] as string
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function parseCommand(command: string): Parsed {
  const text = command.length > MAX_COMMAND_CHARS ? command.slice(0, MAX_COMMAND_CHARS) : command
  const segments: Segment[] = []
  const nested: string[] = []

  let words: Word[] = []
  let redirects: Redirect[] = []
  let piped = false
  let pendingRedirect: Redirect | null = null

  let cur = ''
  let raw = ''
  let quoted = false
  let dynamic = false
  let inWord = false

  const pushWord = (): void => {
    if (!inWord) return
    const word: Word = { text: cur, raw, quoted, dynamic }
    if (pendingRedirect) {
      pendingRedirect.target = word
      pendingRedirect = null
    } else {
      words.push(word)
    }
    cur = ''
    raw = ''
    quoted = false
    dynamic = false
    inWord = false
  }
  const pushSegment = (nextPiped: boolean): void => {
    pushWord()
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, piped })
    words = []
    redirects = []
    piped = nextPiped
    pendingRedirect = null
  }

  let i = 0
  while (i < text.length) {
    const ch = text[i] as string
    const next = text[i + 1]

    // --- quotes
    if (ch === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end
      cur += text.slice(i + 1, stop)
      raw += text.slice(i, stop + 1)
      quoted = true
      inWord = true
      i = stop + 1
      continue
    }
    if (ch === '"') {
      let j = i + 1
      let inner = ''
      while (j < text.length && text[j] !== '"') {
        const c = text[j] as string
        if ((c === '\\' || c === '`') && j + 1 < text.length) {
          // \" and `" are escaped quotes; keep other escapes verbatim.
          if (text[j + 1] === '"') {
            inner += '"'
            j += 2
            continue
          }
          if (c === '`') dynamic = true
        }
        if (c === '$' && text[j + 1] === '(') {
          const close = matchParen(text, j + 2)
          if (close !== -1) {
            nested.push(text.slice(j + 2, close))
            inner += text.slice(j, close + 1)
            dynamic = true
            j = close + 1
            continue
          }
        }
        if (c === '$' && /[A-Za-z_{]/.test(text[j + 1] ?? '')) dynamic = true
        inner += c
        j += 1
      }
      cur += inner
      raw += text.slice(i, Math.min(j + 1, text.length))
      quoted = true
      inWord = true
      i = j + 1
      continue
    }

    // --- command substitution outside quotes
    if (ch === '$' && next === '(') {
      const close = matchParen(text, i + 2)
      if (close !== -1) {
        nested.push(text.slice(i + 2, close))
        cur += text.slice(i, close + 1)
        raw += text.slice(i, close + 1)
        dynamic = true
        inWord = true
        i = close + 1
        continue
      }
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1)
      if (end !== -1 && end > i + 1 && /\s|[|;&$]/.test(text.slice(i + 1, end))) {
        // bash backtick substitution (`cmd args`)
        nested.push(text.slice(i + 1, end))
        cur += text.slice(i, end + 1)
        raw += text.slice(i, end + 1)
        dynamic = true
        inWord = true
        i = end + 1
        continue
      }
      // PowerShell escape character (`r`m): drop it, but remember the word was disguised.
      dynamic = true
      raw += ch
      inWord = true
      i += 1
      continue
    }
    // `$var`, `${var}`, and bash ANSI-C quoting `$'\x72\x6d'` (decoded only by the shell).
    if (ch === '$' && (next === '{' || next === "'" || /[A-Za-z_?@*#!]/.test(next ?? ''))) dynamic = true
    if (ch === '%' && /^%[A-Za-z_][A-Za-z0-9_]*%/.test(text.slice(i))) dynamic = true

    // --- separators
    if (ch === '\n' || ch === ';') {
      pushSegment(false)
      i += 1
      continue
    }
    if (ch === '&' && next === '&') {
      pushSegment(false)
      i += 2
      continue
    }
    if (ch === '|' && next === '|') {
      pushSegment(false)
      i += 2
      continue
    }
    if (ch === '|') {
      pushSegment(true)
      i += next === '&' ? 2 : 1
      continue
    }
    if (ch === '&') {
      // `&>` / `>&` redirections are handled below; a lone & is a background operator, or PowerShell's call operator.
      if (next === '>') {
        pushWord()
        redirects.push({ op: '&>', target: null })
        pendingRedirect = redirects[redirects.length - 1] as Redirect
        i += text[i + 2] === '>' ? 3 : 2
        continue
      }
      if (!inWord && words.length === 0) {
        i += 1 // call operator at the start of a command: `& "C:\x.exe" args`
        continue
      }
      pushSegment(false)
      i += 1
      continue
    }
    if ((ch === '(' || ch === ')') && !inWord) {
      pushSegment(false)
      i += 1
      continue
    }
    if (ch === '{' && !inWord && (next === undefined || /\s/.test(next))) {
      pushSegment(false)
      i += 1
      continue
    }
    if (ch === '}' && !inWord) {
      pushSegment(false)
      i += 1
      continue
    }

    // --- redirections
    if (ch === '>' || ch === '<') {
      // A leading fd number (`2>`) belongs to the operator, not to a word.
      if (inWord && /^\d+$/.test(raw) && !quoted) {
        cur = ''
        raw = ''
        inWord = false
      } else {
        pushWord()
      }
      let op = ch
      let j = i + 1
      if (text[j] === ch) {
        op += ch
        j += 1
      }
      if (ch === '>' && text[j] === '&') {
        // `2>&1` / `>&2`: stream duplication, not a file.
        const dup = /^&(\d+|-)/.exec(text.slice(j))
        if (dup) {
          i = j + dup[0].length
          continue
        }
        j += 1
      }
      const redirect: Redirect = { op, target: null }
      redirects.push(redirect)
      pendingRedirect = redirect
      i = j
      continue
    }

    // --- whitespace ends a word
    if (/\s/.test(ch)) {
      pushWord()
      i += 1
      continue
    }

    // --- ordinary character (backslash escapes the next char in posix shells; kept literal for Windows paths)
    if (ch === '\\' && next !== undefined && /[ "'$`;&|<>()]/.test(next)) {
      cur += next
      raw += ch + next
      inWord = true
      i += 2
      continue
    }
    cur += ch
    raw += ch
    inWord = true
    i += 1
  }
  pushSegment(false)
  return { segments, nested }
}

// ---------------------------------------------------------------- program tables

const WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'timeout', 'call', 'start', 'setsid', 'chroot', 'caffeinate'])
const ELEVATORS = new Set(['sudo', 'doas', 'su', 'runas', 'pkexec'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash', 'busybox'])
const POWERSHELLS = new Set(['powershell', 'pwsh'])
const INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'py', 'ruby', 'perl', 'php', 'lua', 'tsx', 'ts-node'])
const EVALUATORS = new Set(['eval', 'iex', 'invoke-expression', 'source'])

const DELETERS = new Set(['rm', 'rmdir', 'rd', 'del', 'erase', 'unlink', 'shred', 'remove-item', 'ri', 'rimraf', 'del-cli', 'trash', 'srm', 'clear-content', 'clc', 'remove-itemproperty', 'clear-recyclebin', 'rmtree'])
const DISK_TOOLS = new Set(['mkfs', 'mke2fs', 'format', 'format-volume', 'diskpart', 'fdisk', 'sfdisk', 'parted', 'wipefs', 'dd', 'clear-disk', 'remove-partition', 'initialize-disk', 'cipher', 'badblocks', 'blkdiscard'])
const PROCESS_KILLERS = new Set(['kill', 'killall', 'pkill', 'taskkill', 'stop-process', 'spps', 'stop-service', 'sc', 'wmic'])
const SYSTEM_CONTROL = new Set(['shutdown', 'reboot', 'halt', 'poweroff', 'restart-computer', 'stop-computer', 'init', 'systemctl', 'service', 'reg', 'regedit', 'netsh', 'set-executionpolicy', 'bcdedit', 'schtasks', 'crontab', 'launchctl'])
const PERMISSION_TOOLS = new Set(['chmod', 'chown', 'chgrp', 'icacls', 'takeown', 'attrib', 'setfacl', 'set-acl'])
const NETWORK_TOOLS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod', 'ssh', 'scp', 'sftp', 'ftp', 'telnet', 'nc', 'ncat', 'netcat', 'socat', 'rsync', 'start-bitstransfer', 'bitsadmin', 'certutil', 'aria2c', 'http', 'https', 'xh', 'test-netconnection', 'tnc'])
const WRITERS = new Set(['cp', 'copy', 'mv', 'move', 'tee', 'out-file', 'set-content', 'add-content', 'new-item', 'ni', 'mkdir', 'md', 'touch', 'ln', 'install', 'rename-item', 'ren', 'rename', 'move-item', 'mi', 'copy-item', 'cpi', 'xcopy', 'robocopy', 'sc-content', 'tar', 'unzip', 'expand-archive', 'compress-archive', 'curl', 'wget'])
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlcmd', 'mongo', 'mongosh', 'redis-cli', 'cockroach', 'duckdb', 'usql', 'invoke-sqlcmd', 'clickhouse-client', 'cqlsh'])
/** Programs whose arguments are text, never commands or SQL to be scanned. */
const INERT_ARG_PROGRAMS = new Set(['echo', 'printf', 'write-output', 'write-host', 'write-error', 'write-warning', 'write-verbose', 'out-host', 'say'])

const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'npx', 'pnpx', 'bunx', 'pip', 'pip3', 'pipx', 'uv', 'poetry', 'cargo', 'go', 'gem', 'bundle', 'composer', 'dotnet', 'nuget', 'apt', 'apt-get', 'brew', 'choco', 'winget', 'scoop', 'yum', 'dnf', 'pacman', 'apk', 'conda', 'mamba'])

function programName(word: Word): string[] {
  // Candidate spellings of the program name: as written, and with escapes/backticks/quotes collapsed.
  const candidates = new Set<string>()
  const add = (value: string): void => {
    const unescaped = value.replace(/`/g, '')
    for (const v of [value, unescaped, unescaped.replace(/\\/g, '')]) {
      const base = basename(v.replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1|sh)$/, '')
      if (base) candidates.add(base)
    }
  }
  add(word.text)
  add(word.raw.replace(/^['"]|['"]$/g, ''))
  return [...candidates]
}

const worst = (a: CommandRisk, b: CommandRisk): CommandRisk => {
  const order: CommandRisk[] = ['execution', 'network', 'destructive']
  return order.indexOf(a) >= order.indexOf(b) ? a : b
}

// ---------------------------------------------------------------- pattern helpers

const OUTSIDE_PATH = /^(?:[/\\~]|[a-zA-Z]:|\$\{?(?:home|userprofile|env:|pwd)|%(?:userprofile|homepath|homedrive|systemroot|windir|programfiles|appdata|temp|tmp)%)/i
const PARENT_SEGMENT = /(?:^|[/\\])\.\.(?:[/\\]|$)/

/** A path argument that points outside the workspace as far as the TEXT can tell. */
function looksOutsideWorkspace(path: string): boolean {
  const trimmed = path.trim()
  if (trimmed === '' || trimmed === '-') return false
  if (/^(?:\/dev\/(?:null|stdout|stderr|tty)|nul|\$null|con)$/i.test(trimmed)) return false
  return OUTSIDE_PATH.test(trimmed) || PARENT_SEGMENT.test(trimmed)
}

const SQL_DESTRUCTIVE = [
  /\bdrop\s+(?:table|database|schema|view|index|user|role|column)\b/i,
  /\btruncate\s+(?:table\s+)?[\w"`[\].]+/i,
  /\bflush(?:all|db)\b/i,
]

function sqlFinding(text: string): Finding | null {
  for (const pattern of SQL_DESTRUCTIVE) {
    if (pattern.test(text)) return { risk: 'destructive', reason: 'runs destructive SQL (DROP / TRUNCATE / FLUSH)' }
  }
  const del = /\bdelete\s+from\s+[\w"`[\].]+/i.exec(text)
  if (del) {
    const rest = text.slice(del.index + del[0].length)
    // `DELETE FROM t WHERE ...` is a targeted delete; without WHERE it empties the table.
    if (!/\bwhere\b/i.test(rest)) return { risk: 'destructive', reason: 'runs DELETE FROM without a WHERE clause' }
  }
  return null
}

const SCRIPT_DELETE =
  /\b(?:rmsync|rmdirsync|unlinksync|fs\.rm\b|fs\.unlink|fs\.rmdir|fs\.promises\.(?:rm|unlink|rmdir)|rimraf|shutil\.rmtree|os\.remove|os\.unlink|os\.rmdir|pathlib.*\.unlink|file\.delete|fileutils\.(?:rm|remove)|unlink\s*\(|remove-item|rmtree)\b|\brm\s+-[a-z]*r|\[(?:system\.)?io\.(?:file|directory)\]::delete/i

// ---------------------------------------------------------------- analysis

function gitFindings(words: Word[]): Finding[] {
  // Skip global options to find the subcommand.
  let i = 0
  while (i < words.length) {
    const w = (words[i] as Word).text
    if (w === '-C' || w === '-c' || w === '--git-dir' || w === '--work-tree' || w === '--namespace' || w === '--exec-path') i += 2
    else if (w.startsWith('-')) i += 1
    else break
  }
  const sub = (words[i]?.text ?? '').toLowerCase()
  const args = words.slice(i + 1).map((w) => w.text)
  const has = (...flags: string[]): boolean => args.some((a) => flags.includes(a))
  const short = (letter: string): boolean => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
  const out: Finding[] = []
  const destructive = (reason: string, noGrant = true): void => void out.push({ risk: 'destructive', reason, noGrant })

  switch (sub) {
    case 'reset':
      destructive('git reset can discard commits and uncommitted work')
      break
    case 'clean':
      destructive('git clean deletes untracked files')
      break
    case 'checkout':
    case 'switch':
      destructive('git checkout/switch can overwrite or discard uncommitted work')
      break
    case 'restore':
      if (!has('--staged') || has('--worktree') || short('W')) destructive('git restore discards uncommitted changes')
      else out.push({ risk: 'execution', reason: 'unstages changes', noGrant: false })
      break
    case 'rm':
      destructive('git rm deletes files from the working tree')
      break
    case 'rebase':
    case 'filter-branch':
    case 'filter-repo':
    case 'replace':
      destructive(`git ${sub} rewrites history`)
      break
    case 'push': {
      const force = has('--force', '--force-with-lease', '--mirror', '--delete', '--prune') || short('f') || short('d') || args.some((a) => a.startsWith('+') || a.startsWith(':') || a.startsWith('--force-with-lease='))
      if (force) destructive('git push with force/delete can overwrite or remove remote history')
      else out.push({ risk: 'network', reason: 'pushes to a remote', noGrant: true })
      break
    }
    case 'branch':
      if (has('-D', '--delete', '-d', '-M', '--move') || short('D')) destructive('deletes or force-renames a branch')
      break
    case 'tag':
      if (has('-d', '--delete', '-f', '--force')) destructive('deletes or moves a tag')
      else out.push({ risk: 'execution', reason: 'creates a tag', noGrant: true })
      break
    case 'stash':
      if (args.some((a) => a === 'drop' || a === 'clear')) destructive('drops stashed work')
      else out.push({ risk: 'execution', reason: 'moves uncommitted work into the stash', noGrant: true })
      break
    case 'gc':
    case 'prune':
    case 'reflog':
      if (has('--prune=now', '--prune=all', '--expire=now', '--expire=all', 'expire', 'delete', '--aggressive') || args.some((a) => a.startsWith('--prune'))) destructive('prunes unreachable objects')
      break
    case 'update-ref':
      if (has('-d')) destructive('deletes a ref')
      break
    case 'worktree':
      if (args.includes('remove') || args.includes('prune')) destructive('removes a worktree')
      break
    case 'commit':
      out.push({ risk: 'execution', reason: 'creates a commit (always confirmed)', noGrant: true })
      if (has('--amend')) destructive('amends the previous commit', true)
      break
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'am':
    case 'apply':
    case 'pull':
      out.push({ risk: sub === 'pull' ? 'network' : 'execution', reason: `git ${sub} changes the working tree (always confirmed)`, noGrant: true })
      break
    case 'fetch':
    case 'clone':
    case 'ls-remote':
    case 'submodule':
    case 'remote':
    case 'lfs':
      out.push({ risk: 'network', reason: `git ${sub} talks to a remote`, noGrant: false })
      break
    default:
      break
  }
  return out
}

function packageFindings(name: string, words: Word[]): Finding[] {
  const args = words.map((w) => w.text.toLowerCase()).filter((a) => !a.startsWith('-'))
  const sub = args[0] ?? ''
  const out: Finding[] = []
  const network = (reason: string): void => void out.push({ risk: 'network', reason })
  if (name === 'npx' || name === 'pnpx' || name === 'bunx') {
    network('npx downloads and runs a package from the network')
    return out
  }
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    if (['publish', 'unpublish', 'deprecate'].includes(sub)) out.push({ risk: 'destructive', reason: `${name} ${sub} publishes to or changes the registry`, noGrant: true })
    else if (['install', 'i', 'add', 'ci', 'update', 'up', 'upgrade', 'dlx', 'create', 'audit', 'outdated', 'view', 'info', 'search', 'login', 'adduser'].includes(sub)) {
      network(`${name} ${sub} uses the network and may run install scripts`)
    }
    return out
  }
  if (['pip', 'pip3', 'pipx', 'uv', 'poetry', 'conda', 'mamba'].includes(name)) {
    if (['install', 'download', 'add', 'sync', 'update', 'upgrade', 'lock'].includes(sub)) network(`${name} ${sub} downloads packages`)
    return out
  }
  if (name === 'cargo' && ['install', 'add', 'update', 'fetch', 'publish', 'search', 'login'].includes(sub)) network(`cargo ${sub} uses the network`)
  if (name === 'go' && ['get', 'install', 'mod', 'work'].includes(sub)) network(`go ${sub} may download modules`)
  if (['gem', 'bundle', 'composer', 'nuget', 'dotnet'].includes(name) && ['install', 'update', 'add', 'restore', 'push'].includes(sub)) network(`${name} ${sub} uses the network`)
  if (['apt', 'apt-get', 'brew', 'choco', 'winget', 'scoop', 'yum', 'dnf', 'pacman', 'apk'].includes(name)) {
    if (['remove', 'uninstall', 'purge', 'autoremove', '-r', '-rns'].includes(sub)) out.push({ risk: 'destructive', reason: `${name} ${sub} removes software`, noGrant: true })
    else network(`${name} installs or updates system software`)
  }
  return out
}

function analyzeWords(words: Word[], piped: boolean, depth: number): Finding[] {
  const findings: Finding[] = []
  const add = (f: Finding): void => void findings.push(f)

  let i = 0
  // Leading `NAME=value` environment assignments.
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test((words[i] as Word).raw) && !(words[i] as Word).quoted) i += 1
  // Wrappers that run the next word as a command.
  while (i < words.length) {
    const word = words[i] as Word
    const names = programName(word)
    if (names.some((n) => ELEVATORS.has(n))) {
      add({ risk: 'destructive', reason: 'runs with elevated privileges', noGrant: true })
      i += 1
      continue
    }
    if (word.raw === '&' || word.raw === '.') {
      i += 1
      continue
    }
    if (names.some((n) => WRAPPERS.has(n))) {
      i += 1
      // Skip the wrapper's own options / assignments / numeric durations.
      while (i < words.length) {
        const arg = (words[i] as Word).text
        if (arg.startsWith('-') || arg.startsWith('/') && names.includes('start') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg) || (names.includes('timeout') && /^\d+[smhd]?$/.test(arg))) i += 1
        else break
      }
      continue
    }
    break
  }
  if (i >= words.length) return findings

  const program = words[i] as Word
  const rest = words.slice(i + 1)
  const names = programName(program)
  const restText = rest.map((w) => w.text).join(' ')
  const is = (set: Set<string>): boolean => names.some((n) => set.has(n))
  const primary = names[0] ?? ''

  if (program.dynamic && !program.quoted) {
    add({ risk: 'destructive', reason: 'the command name is computed at run time (variable or substitution) and cannot be checked', noGrant: true })
  } else if (program.dynamic) {
    add({ risk: 'destructive', reason: 'the command name is built from escapes or variables and cannot be checked', noGrant: true })
  }

  // --- opaque code execution
  if (is(EVALUATORS)) {
    add({ risk: 'destructive', reason: `${primary} runs text as code that cannot be checked`, noGrant: true })
    // `source ./env.sh` is common but runs arbitrary script text: same bucket.
  }

  // --- deleters
  if (is(DELETERS)) {
    add({ risk: 'destructive', reason: `deletes files (${primary})`, noGrant: true })
  }
  if (names.some((n) => /^mkfs(?:\.\w+)?$/.test(n)) || is(DISK_TOOLS)) {
    add({ risk: 'destructive', reason: `can erase or reformat disks/data (${primary})`, noGrant: true })
  }
  if (names.some((n) => n === 'truncate')) add({ risk: 'destructive', reason: 'truncates files', noGrant: true })
  if (is(PROCESS_KILLERS)) add({ risk: 'destructive', reason: `stops processes or services (${primary})`, noGrant: true })
  if (is(SYSTEM_CONTROL)) add({ risk: 'destructive', reason: `changes system state (${primary})`, noGrant: true })
  if (is(PERMISSION_TOOLS) && (/(?:^|\s)-[a-zA-Z]*r|\s\/t\b|\/s\b|--recursive|-recurse/i.test(restText) || rest.some((w) => looksOutsideWorkspace(w.text)))) {
    add({ risk: 'destructive', reason: `changes permissions or ownership recursively or outside the workspace (${primary})`, noGrant: true })
  }

  // --- shells and interpreters: look inside -c / -Command payloads
  if (is(SHELLS)) {
    const flagIndex = rest.findIndex((w) => /^-[a-z]*c[a-z]*$/i.test(w.text) && !w.text.startsWith('--'))
    const payload = flagIndex >= 0 ? rest[flagIndex + 1] : undefined
    if (payload) {
      if (depth < MAX_DEPTH) for (const f of analyzeCommandText(payload.text, depth + 1)) add(f)
    } else if (piped && rest.length === 0) {
      add({ risk: 'destructive', reason: 'pipes data into a shell, which then runs it', noGrant: true })
    }
  }
  if (is(POWERSHELLS)) {
    const idx = rest.findIndex((w) => /^-(?:c|command|commandwithargs)$/i.test(w.text))
    const enc = rest.findIndex((w) => /^-(?:e|ec|enc|encodedcommand)$/i.test(w.text))
    if (enc >= 0) {
      add({ risk: 'destructive', reason: 'runs an encoded PowerShell command that cannot be read', noGrant: true })
    } else if (idx >= 0) {
      const payload = rest.slice(idx + 1).map((w) => w.text).join(' ')
      if (depth < MAX_DEPTH) for (const f of analyzeCommandText(payload, depth + 1)) add(f)
    } else if (piped && rest.every((w) => w.text.startsWith('-'))) {
      add({ risk: 'destructive', reason: 'pipes data into PowerShell, which then runs it', noGrant: true })
    }
  }
  if (primary === 'cmd') {
    const idx = rest.findIndex((w) => /^\/[ck]$/i.test(w.text))
    if (idx >= 0 && depth < MAX_DEPTH) {
      const payload = rest.slice(idx + 1).map((w) => w.text).join(' ')
      for (const f of analyzeCommandText(payload, depth + 1)) add(f)
    }
  }
  if (is(INTERPRETERS)) {
    const evalIdx = rest.findIndex((w) => /^(?:-e|-c|-p|--eval|--print|-r|eval)$/i.test(w.text))
    if (evalIdx >= 0) {
      const code = rest.slice(evalIdx + 1).map((w) => w.text).join(' ')
      if (SCRIPT_DELETE.test(code)) add({ risk: 'destructive', reason: 'inline script deletes files', noGrant: true })
      const sql = sqlFinding(code)
      if (sql) add({ ...sql, noGrant: true })
    }
  }

  // --- xargs / find forward to another command
  if (primary === 'xargs') {
    let j = 0
    while (j < rest.length) {
      const t = (rest[j] as Word).text
      if (['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-i'].includes(t)) j += 2
      else if (t.startsWith('-')) j += 1
      else break
    }
    const inner = rest.slice(j)
    if (inner.length > 0 && depth < MAX_DEPTH) for (const f of analyzeWords(inner, true, depth + 1)) add(f)
    else if (inner.length === 0) add({ risk: 'execution', reason: 'xargs with no explicit command', noGrant: false })
  }
  if (primary === 'find') {
    if (rest.some((w) => w.text === '-delete')) add({ risk: 'destructive', reason: 'find -delete deletes files', noGrant: true })
    for (let j = 0; j < rest.length; j += 1) {
      if (['-exec', '-execdir', '-ok', '-okdir'].includes((rest[j] as Word).text.toLowerCase())) {
        const inner: Word[] = []
        for (let k = j + 1; k < rest.length; k += 1) {
          const t = (rest[k] as Word).text
          if (t === ';' || t === '+' || t === '\\;') break
          inner.push(rest[k] as Word)
        }
        if (inner.length > 0 && depth < MAX_DEPTH) for (const f of analyzeWords(inner, false, depth + 1)) add(f)
      }
    }
  }

  // --- git, package managers, containers, infrastructure
  if (primary === 'git') for (const f of gitFindings(rest)) add(f)
  if (PACKAGE_MANAGERS.has(primary)) for (const f of packageFindings(primary, rest)) add(f)
  if (primary === 'docker' || primary === 'podman') {
    const sub = rest.map((w) => w.text).filter((a) => !a.startsWith('-'))
    const first = sub[0] ?? ''
    if (['rm', 'rmi', 'prune', 'kill', 'stop'].includes(first) || sub.slice(0, 2).join(' ').match(/^(?:system|volume|image|container|network|builder) (?:prune|rm)$/)) add({ risk: 'destructive', reason: `${primary} ${first} removes containers, images or volumes`, noGrant: true })
    else if (['pull', 'push', 'login', 'build', 'compose', 'run'].includes(first)) add({ risk: 'network', reason: `${primary} ${first} uses the network` })
  }
  if ((primary === 'kubectl' || primary === 'helm' || primary === 'oc') && /\b(?:delete|uninstall|drain|replace --force)\b/.test(restText)) add({ risk: 'destructive', reason: `${primary} deletes cluster resources`, noGrant: true })
  if ((primary === 'terraform' || primary === 'tofu' || primary === 'pulumi') && /\b(?:destroy|apply|up)\b/.test(restText)) add({ risk: 'destructive', reason: `${primary} changes real infrastructure`, noGrant: true })

  // --- network tools
  if (is(NETWORK_TOOLS) && !names.includes('install') && !names.includes('tar')) {
    add({ risk: 'network', reason: `uses the network (${primary})`, noGrant: false })
  }
  if (primary === 'robocopy' && /\/(?:mir|purge)\b/i.test(restText)) add({ risk: 'destructive', reason: 'robocopy /MIR or /PURGE deletes files at the destination', noGrant: true })
  if (primary === 'rsync' && rest.some((w) => w.text.startsWith('--delete'))) add({ risk: 'destructive', reason: 'rsync --delete removes files at the destination', noGrant: true })

  // --- writers pointing outside the workspace; forced moves
  if (is(WRITERS)) {
    const targets = rest.filter((w) => !w.text.startsWith('-') && !w.text.startsWith('/') || looksOutsideWorkspace(w.text))
    if (targets.some((w) => looksOutsideWorkspace(w.text))) {
      add({ risk: 'destructive', reason: `writes outside the workspace (${primary})`, noGrant: true })
    }
    if (['mv', 'move', 'move-item', 'mi', 'rename-item'].includes(primary) && rest.some((w) => /^-(?:f|force|fo)$/i.test(w.text))) {
      add({ risk: 'destructive', reason: 'forced move/rename can overwrite files', noGrant: true })
    }
  }
  // PowerShell cmdlets with explicit path parameters.
  if (/^(?:out-file|set-content|add-content|tee-object|export-csv|export-clixml|new-item|copy-item|move-item)$/.test(primary)) {
    const pathArgs = rest.filter((w, idx) => idx > 0 && /^-(?:path|filepath|literalpath|destination)$/i.test((rest[idx - 1] as Word).text))
    if (pathArgs.some((w) => looksOutsideWorkspace(w.text))) add({ risk: 'destructive', reason: `writes outside the workspace (${primary})`, noGrant: true })
  }

  // --- destructive SQL anywhere in the arguments of a program that is not just printing text
  // Only database clients are scanned: `grep "DROP TABLE" migrations/` and `git commit -m "drop table"` are text, not SQL.
  if (!INERT_ARG_PROGRAMS.has(primary) && (DB_CLIENTS.has(primary) || /sql/.test(primary))) {
    const sql = sqlFinding(restText)
    if (sql) add({ ...sql, noGrant: true })
  }

  // --- .NET / PowerShell static deletes written inline
  if (/\[(?:system\.)?io\.(?:file|directory)\]::(?:delete|move|replace)/i.test(`${program.text} ${restText}`)) {
    add({ risk: 'destructive', reason: 'calls a .NET file delete/move directly', noGrant: true })
  }

  return findings
}

function redirectFindings(segment: Segment): Finding[] {
  const out: Finding[] = []
  for (const redirect of segment.redirects) {
    if (redirect.op.startsWith('<') || !redirect.target) continue
    const target = redirect.target
    const text = target.text
    if (/^(?:\$null|nul|\/dev\/null|\/dev\/stdout|\/dev\/stderr)$/i.test(text)) continue
    if (target.dynamic) {
      out.push({ risk: 'destructive', reason: `redirects output (${redirect.op}) to a path computed at run time`, noGrant: true })
    } else if (looksOutsideWorkspace(text)) {
      out.push({ risk: 'destructive', reason: `redirects output (${redirect.op}) to ${text}, outside the workspace`, noGrant: true })
    }
  }
  return out
}

function analyzeCommandText(command: string, depth: number): Finding[] {
  const parsed = parseCommand(command)
  const findings: Finding[] = []
  for (const segment of parsed.segments) {
    for (const f of analyzeWords(segment.words, segment.piped, depth)) findings.push(f)
    for (const f of redirectFindings(segment)) findings.push(f)
  }
  if (depth < MAX_DEPTH) {
    for (const inner of parsed.nested) for (const f of analyzeCommandText(inner, depth + 1)) findings.push(f)
  }
  return findings
}

export function assessCommand(command: string): CommandAssessment {
  const findings = analyzeCommandText(command, 0)
  let risk: CommandRisk = 'execution'
  let noGrant = false
  const reasons: string[] = []
  for (const f of findings) {
    risk = worst(risk, f.risk)
    if (f.noGrant) noGrant = true
    if (!reasons.includes(f.reason)) reasons.push(f.reason)
  }
  if (risk === 'destructive') noGrant = true
  return { risk, noGrant, reasons }
}

// ---------------------------------------------------------------- "is this a test run?"

const TEST_RUNNERS = new Set(['vitest', 'jest', 'pytest', 'py.test', 'mocha', 'ava', 'tap', 'phpunit', 'rspec', 'playwright', 'cypress', 'karma', 'jasmine', 'nosetests', 'tox', 'nox', 'ctest', 'bats'])
const TEST_VERBS = new Set(['test', 'tests', 't', 'check', 'verify'])

function isTestWords(words: Word[]): boolean {
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test((words[i] as Word).raw)) i += 1
  const first = words[i]
  if (!first) return false
  const name = programName(first)[0] ?? ''
  const args = words.slice(i + 1).map((w) => w.text.toLowerCase())
  if (TEST_RUNNERS.has(name)) return !args.includes('--help') && !args.includes('-h')
  const nonFlags = args.filter((a) => !a.startsWith('-'))
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    if (TEST_VERBS.has(nonFlags[0] ?? '') && nonFlags[0] !== 'check' && nonFlags[0] !== 'verify') return true
    if ((nonFlags[0] === 'run' || nonFlags[0] === 'run-script') && /^test(?::|$)/.test(nonFlags[1] ?? '')) return true
    // pnpm -r test / pnpm --filter x test / yarn workspaces foreach test
    if (name === 'pnpm' && nonFlags.at(-1) === 'test') return true
    return false
  }
  if (['npx', 'pnpx', 'bunx'].includes(name)) return TEST_RUNNERS.has(nonFlags[0] ?? '')
  if (name === 'go' || name === 'cargo' || name === 'dotnet' || name === 'mvn' || name === 'gradle' || name === 'gradlew' || name === 'make' || name === 'deno' || name === 'swift' || name === 'flutter' || name === 'mix' || name === 'rake') {
    return nonFlags[0] === 'test'
  }
  if (name === 'node') return args.includes('--test')
  if (name === 'python' || name === 'python3' || name === 'py') {
    const m = args.indexOf('-m')
    return m >= 0 && ['pytest', 'unittest', 'nose', 'tox'].includes(args[m + 1] ?? '')
  }
  return false
}

/**
 * True only when it is safe to say "this command ran the tests": a single command or an `&&` chain
 * containing a test run, with no `;`, `||`, pipe, background or redirection that could mask the test's
 * exit code. (`pnpm test | tail` exits with `tail`'s status; `pnpm test; echo done` exits 0 whatever happened.)
 */
export function isTestCommand(command: string): boolean {
  const text = command.trim()
  if (text === '' || text.length > MAX_COMMAND_CHARS) return false
  // Anything that can hide the exit status: pipes, `;`, `||`, background `&`, newlines, redirections to files, substitutions.
  const stripped = text.replace(/&&/g, ' ').replace(/2>&1/g, ' ')
  if (/[;|\n`]|\$\(|(?<!&)&(?!&)|>|<|\|\|/.test(stripped.replace(/"[^"]*"|'[^']*'/g, ''))) return false
  const parts = text.split('&&')
  return parts.some((part) => isTestWords(parseCommand(part).segments[0]?.words ?? []))
}
