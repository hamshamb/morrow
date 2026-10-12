import { realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { SENSITIVE_DENY_PATTERNS } from '@ai-workspace/shared'

/**
 * Path safety for the code workspace (ADR-035). The renderer never sends an
 * absolute path: it names a workspace and a path relative to that
 * workspace's root, and the main process resolves it here. A path is
 * rejected when it is absolute (POSIX, drive-letter or UNC), contains a
 * `..` segment or a NUL / `:` (NTFS alternate data streams), has a
 * Windows-ignored trailing dot/space, or - after resolving symlinks and
 * Windows 8.3 short names with the OS's own `realpath` - lands outside the
 * workspace root. Secrets and `.git/` internals (SENSITIVE_DENY_PATTERNS)
 * are refused on both the requested and the resolved path.
 *
 * Residual risk: a symlink swapped in between this check and the following
 * read/write (TOCTOU). Closing it needs openat-style APIs Node doesn't
 * expose; it requires an attacker with write access to the repo already,
 * who could edit the files directly. Documented in ARCHITECTURE.md.
 */

export type PathSafetyCode = 'invalid' | 'absolute' | 'traversal' | 'escape' | 'denied'

export class PathSafetyError extends Error {
  constructor(
    readonly code: PathSafetyCode,
    message: string,
  ) {
    super(message)
    this.name = 'PathSafetyError'
  }
}

let sensitiveFilter: Ignore | null = null
function sensitive(): Ignore {
  if (!sensitiveFilter) sensitiveFilter = ignore().add([...SENSITIVE_DENY_PATTERNS])
  return sensitiveFilter
}

/** True for `.env*`, keys, credentials and anything inside `.git/` (any depth). */
export function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized === '' || normalized === '.') return false
  // The `ignore` package throws on paths that escape / are absolute; those are
  // rejected earlier by normalizeRelativePath, so treat a throw as sensitive.
  try {
    return sensitive().ignores(normalized) || sensitive().ignores(`${normalized}/`)
  } catch {
    return true
  }
}

/**
 * Validates and normalizes a renderer-supplied relative path to POSIX form
 * ('' for the root when `allowRoot`). Throws PathSafetyError.
 */
export function normalizeRelativePath(input: unknown, options: { allowRoot?: boolean | undefined } = {}): string {
  if (typeof input !== 'string') throw new PathSafetyError('invalid', 'Path must be a string')
  if (input.includes('\0')) throw new PathSafetyError('invalid', 'Path contains a NUL byte')
  if (input.startsWith('/') || input.startsWith('\\') || /^[a-zA-Z]:/.test(input) || isAbsolute(input)) {
    throw new PathSafetyError('absolute', 'Absolute paths are not allowed')
  }
  if (input.includes(':')) throw new PathSafetyError('invalid', 'Path contains ":"')

  const segments: string[] = []
  for (const segment of input.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') throw new PathSafetyError('traversal', 'Path traversal ("..") is not allowed')
    // Windows silently strips trailing dots/spaces ("foo." is "foo") - that would
    // let ".git." slip past the deny-list. Refuse them everywhere.
    if (/[. ]$/.test(segment)) {
      throw new PathSafetyError('invalid', 'Path segments may not end with "." or a space')
    }
    segments.push(segment)
  }
  if (segments.length === 0) {
    if (options.allowRoot) return ''
    throw new PathSafetyError('invalid', 'Path is empty')
  }
  return segments.join('/')
}

export function isInside(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal)
  if (rel === '') return true
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

export interface ResolvedPath {
  /** Normalized, POSIX, relative to the root ('' = the root itself). */
  relativePath: string
  /** Real (symlink-resolved) absolute path to operate on. */
  absolutePath: string
  /** Real absolute path of the workspace root. */
  rootReal: string
  /** Whether the target existed when resolved. */
  exists: boolean
}

function errCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined
}

/**
 * Resolves `relativePath` against `rootPath` and verifies containment after
 * symlink resolution. For a path that doesn't exist yet (a file about to be
 * created) the deepest existing ancestor is resolved instead, so a symlinked
 * directory can't smuggle a new file out of the root.
 */
export async function resolveInRoot(
  rootPath: string,
  input: unknown,
  options: { allowRoot?: boolean | undefined; allowSensitive?: boolean | undefined } = {},
): Promise<ResolvedPath> {
  const relativePath = normalizeRelativePath(input, { allowRoot: options.allowRoot })
  if (!options.allowSensitive && isSensitivePath(relativePath)) {
    throw new PathSafetyError('denied', `Access to "${relativePath}" is blocked (secrets and .git internals)`)
  }

  const rootReal = await realpath(rootPath)
  const segments = relativePath === '' ? [] : relativePath.split('/')
  const candidate = join(rootReal, ...segments)
  if (!isInside(rootReal, candidate)) throw new PathSafetyError('escape', 'Path resolves outside the workspace')

  let absolutePath: string
  let exists = true
  try {
    absolutePath = await realpath(candidate)
  } catch (err) {
    const code = errCode(err)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    exists = false
    // Walk up to the deepest ancestor that exists, resolve it, re-append the rest.
    let ancestor = candidate
    const rest: string[] = []
    let resolved: string | null = null
    while (resolved === null) {
      const parent = join(ancestor, '..')
      if (parent === ancestor) throw new PathSafetyError('escape', 'Path has no existing ancestor')
      rest.unshift(ancestor.slice(parent.length).replace(/^[\\/]+/, ''))
      ancestor = parent
      try {
        resolved = join(await realpath(ancestor), ...rest)
      } catch (inner) {
        const innerCode = errCode(inner)
        if (innerCode !== 'ENOENT' && innerCode !== 'ENOTDIR') throw inner
      }
    }
    absolutePath = resolved
  }

  if (!isInside(rootReal, absolutePath)) {
    throw new PathSafetyError('escape', 'Path resolves outside the workspace (symlink or junction)')
  }
  // Re-check the deny-list on the *resolved* location: a symlink or an 8.3 short
  // name (GIT~1) must not reach a secret the requested spelling hid.
  if (!options.allowSensitive) {
    const resolvedRel = toPosix(relative(rootReal, absolutePath))
    if (isSensitivePath(resolvedRel)) {
      throw new PathSafetyError('denied', `Access to "${resolvedRel}" is blocked (secrets and .git internals)`)
    }
  }
  return { relativePath, absolutePath, rootReal, exists }
}
