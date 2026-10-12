import type {
  FsEntry,
  FsReadResult,
  GitChange,
  GitChangeStatus,
  GitDiffResult,
  GitStatus,
  RendererApi,
  TerminalEvent,
  TerminalInfo,
} from '@ai-workspace/shared'

/**
 * Dev-only fixtures for the Phase 4 surface (files, git, terminal), so the
 * code view, the changes view and the terminal panel can be reviewed in a plain
 * browser tab. Nothing here ships: `mock-api.ts` is only imported behind
 * `import.meta.env.DEV`. `?repo=none` shows the "not a repository" state,
 * `?repo=missing` the "git not found" state.
 */

const params = new URLSearchParams(window.location.search)
const REPO = params.get('repo')
const ROOT = 'C:\\dev\\personal-website'
const WORKSPACE = 'ws-website'

const FILES: Record<string, string> = {
  'package.json': `{
  "name": "personal-website",
  "version": "0.4.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run"
  },
  "dependencies": {
    "next": "15.1.0",
    "react": "19.0.0",
    "react-dom": "19.0.0"
  }
}
`,
  'README.md': `# Personal website

Marketing site and blog, Next.js on Vercel.

## Develop

\`\`\`sh
npm install
npm run dev
\`\`\`

## Deploy

Pushes to \`main\` deploy automatically. See docs/deploy.md.
`,
  '.gitignore': 'node_modules/\n.next/\n.env*\ncoverage/\n',
  'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "jsx": "preserve",
    "paths": { "@/*": ["./src/*"] }
  }
}
`,
  'src/app/layout.tsx': `import type { ReactNode } from 'react'
import { Nav } from '@/components/Nav'
import './globals.css'

export const metadata = { title: 'Personal website' }

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  )
}
`,
  'src/app/page.tsx': `import { PostList } from '@/components/PostList'
import { getPosts } from '@/lib/posts'

export default async function Home() {
  const posts = await getPosts()
  return (
    <section>
      <h1>Writing</h1>
      <PostList posts={posts} />
    </section>
  )
}
`,
  'src/components/Nav.tsx': `import Link from 'next/link'

const LINKS = [
  { href: '/', label: 'home' },
  { href: '/writing', label: 'writing' },
  { href: '/about', label: 'about' },
  { href: '/contact', label: 'contact' },
]

export function Nav() {
  return (
    <nav aria-label="Primary">
      {LINKS.map((link) => (
        <Link key={link.href} href={link.href}>
          /{link.label}
        </Link>
      ))}
    </nav>
  )
}
`,
  'src/components/PostList.tsx': `import Link from 'next/link'
import type { Post } from '@/lib/posts'

interface Props {
  posts: Post[]
}

export function PostList({ posts }: Props) {
  if (posts.length === 0) return <p>No posts yet.</p>
  return (
    <ul className="post-list">
      {posts.map((post) => (
        <li key={post.slug}>
          <Link href={\`/writing/\${post.slug}\`}>{post.title}</Link>
          <time dateTime={post.date}>{post.date}</time>
        </li>
      ))}
    </ul>
  )
}
`,
  'src/lib/auth/session.ts': `import { cookies } from 'next/headers'
import { verifyToken, type TokenPayload } from './tokens'

const COOKIE = 'session'
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7

export interface Session {
  userId: string
  expiresAt: number
}

export async function readSession(): Promise<Session | null> {
  const store = await cookies()
  const raw = store.get(COOKIE)?.value
  if (!raw) return null
  const payload: TokenPayload | null = await verifyToken(raw)
  if (!payload) return null
  return { userId: payload.sub, expiresAt: payload.exp * 1000 }
}

export function isExpired(session: Session, now = Date.now()): boolean {
  return session.expiresAt <= now
}

export const SESSION_MAX_AGE = MAX_AGE_SECONDS
`,
  'src/lib/auth/refresh-middleware.ts': `import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { readSession, isExpired } from './session'

const REFRESH_WINDOW_MS = 5 * 60 * 1000

export async function refreshMiddleware(req: NextRequest) {
  const session = await readSession()
  if (!session) return NextResponse.next()

  const remaining = session.expiresAt - Date.now()
  if (isExpired(session)) {
    const res = NextResponse.redirect(new URL('/login', req.url))
    res.cookies.delete('session')
    return res
  }
  if (remaining < REFRESH_WINDOW_MS) {
    const res = NextResponse.next()
    res.headers.set('x-session-refresh', '1')
    return res
  }
  return NextResponse.next()
}
`,
  'src/lib/posts.ts': `export interface Post {
  slug: string
  title: string
  date: string
}

export async function getPosts(): Promise<Post[]> {
  return [
    { slug: 'hello-world', title: 'Hello, world', date: '2026-01-04' },
    { slug: 'notes-on-ci', title: 'Notes on CI', date: '2026-02-19' },
  ]
}
`,
  'src/styles/globals.css': `:root {
  --paper: #eeede7;
  --ink: #161616;
}

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: ui-monospace, Consolas, monospace;
}

nav a {
  margin-right: 1rem;
}
`,
  'docs/deploy.md': `# Deploying

1. Merge to \`main\`.
2. Vercel builds the preview and promotes it.
3. Check \`/api/health\`.

If a deploy fails, roll back from the Vercel dashboard.
`,
  'scripts/seed.ts': `import { getPosts } from '../src/lib/posts'

async function main() {
  const posts = await getPosts()
  console.log(\`seeded \${posts.length} posts\`)
}

void main()
`,
}

/** Files that exist but aren't text (listed, never opened as text). */
const BINARY_FILES: Record<string, number> = { 'public/logo.png': 18_432, 'public/og-image.png': 96_210 }

/** The version of each changed file at HEAD / in the index (the diff's left side). */
function without(text: string, ...fragments: string[]): string {
  return fragments.reduce((acc, f) => acc.replace(f, ''), text)
}

const HEAD: Record<string, string> = {
  'src/lib/auth/session.ts': without(
    FILES['src/lib/auth/session.ts'] as string,
    `export function isExpired(session: Session, now = Date.now()): boolean {
  return session.expiresAt <= now
}

`,
    `  const payload: TokenPayload | null = await verifyToken(raw)
  if (!payload) return null
`,
  ).replace("  return { userId: payload.sub, expiresAt: payload.exp * 1000 }", "  return { userId: raw, expiresAt: 0 }"),
  'src/components/Nav.tsx': (FILES['src/components/Nav.tsx'] as string).replace("  { href: '/about', label: 'about' },\n  { href: '/contact', label: 'contact' },\n", "  { href: '/about', label: 'about' },\n"),
  'src/lib/auth/refresh-middleware.ts': `import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { readSession } from './session'

export async function refreshMiddleware(req: NextRequest) {
  const session = await readSession()
  if (!session) return NextResponse.next()
  if (session.expiresAt < Date.now()) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  return NextResponse.next()
}
`,
  'README.md': (FILES['README.md'] as string).replace('## Deploy\n\nPushes to `main` deploy automatically. See docs/deploy.md.\n', '## Deploy\n\nPushes to `main` deploy automatically.\n'),
  'package.json': (FILES['package.json'] as string).replace('"test": "vitest run"', '"test": "jest"'),
}

type Area = 'staged' | 'unstaged' | 'untracked'
const CHANGED: { path: string; area: Area; status: GitChangeStatus }[] = [
  { path: 'src/lib/auth/session.ts', area: 'staged', status: 'modified' },
  { path: 'src/components/Nav.tsx', area: 'staged', status: 'modified' },
  { path: 'src/lib/auth/refresh-middleware.ts', area: 'unstaged', status: 'modified' },
  { path: 'README.md', area: 'unstaged', status: 'modified' },
  { path: 'package.json', area: 'unstaged', status: 'modified' },
  { path: 'src/components/PostList.tsx', area: 'untracked', status: 'untracked' },
  { path: 'docs/deploy.md', area: 'untracked', status: 'untracked' },
]

function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

/** Cheap +N -M: lines present on one side only (multiset difference). */
function countChanges(original: string, modified: string): { additions: number; deletions: number } {
  const remaining = new Map<string, number>()
  for (const l of lines(original)) remaining.set(l, (remaining.get(l) ?? 0) + 1)
  let additions = 0
  for (const l of lines(modified)) {
    const n = remaining.get(l) ?? 0
    if (n > 0) remaining.set(l, n - 1)
    else additions += 1
  }
  let deletions = 0
  for (const n of remaining.values()) deletions += n
  return { additions, deletions }
}

const state = {
  entries: CHANGED.map((c) => ({ ...c })),
  head: { sha: '8f3c2a91d4b7e0a5c6b1f2e3d4a5b6c7d8e9f0a1', shortSha: '8f3c2a9', subject: 'fix: refresh the session cookie before it expires' },
  commits: 0,
}

function changeFor(entry: { path: string; area: Area; status: GitChangeStatus }): GitChange {
  const original = entry.area === 'untracked' ? '' : (HEAD[entry.path] ?? '')
  const modified = FILES[entry.path] ?? ''
  const { additions, deletions } = countChanges(original, modified)
  return {
    path: entry.path,
    origPath: null,
    status: entry.status,
    additions,
    deletions,
    binary: false,
    protected: false,
  }
}

function buildStatus(): GitStatus {
  if (REPO === 'missing') return { state: 'git-missing' }
  if (REPO === 'none') return { state: 'not-a-repo' }
  const by = (area: Area): GitChange[] => state.entries.filter((e) => e.area === area).map(changeFor)
  return {
    state: 'ok',
    branch: { head: 'feature/code-workspace', detached: false, upstream: 'origin/feature/code-workspace', ahead: 2, behind: 0 },
    commit: state.head,
    staged: by('staged'),
    unstaged: by('unstaged'),
    untracked: by('untracked'),
    conflicted: [],
    truncated: false,
  }
}

function delay<T>(value: T, ms = 60): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function childrenOf(dir: string): FsEntry[] {
  const prefix = dir === '' ? '' : `${dir}/`
  const seen = new Map<string, FsEntry>()
  const all = [...Object.keys(FILES).map((p) => [p, FILES[p]?.length ?? 0] as const), ...Object.entries(BINARY_FILES)]
  for (const [path, size] of all) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) seen.set(rest, { name: rest, relativePath: path, kind: 'file', sizeBytes: size })
    else {
      const name = rest.slice(0, slash)
      seen.set(name, { name, relativePath: `${prefix}${name}`, kind: 'directory', sizeBytes: null })
    }
  }
  return [...seen.values()].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'directory' ? -1 : 1))
}

function hashOf(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return `mock-${(h >>> 0).toString(16)}`
}

// ---- terminals (a scripted fake shell) ----

const listeners = new Set<(event: TerminalEvent) => void>()
const terminals: (TerminalInfo & { buffer: string; line: string })[] = []
const PROMPT = `PS ${ROOT}> `
let nextTerminal = 1

function publicInfo(t: TerminalInfo & { buffer: string; line: string }): TerminalInfo {
  return { id: t.id, workspaceId: t.workspaceId, title: t.title, shell: t.shell, cwd: t.cwd, pid: t.pid, status: t.status, exitCode: t.exitCode, createdAt: t.createdAt }
}

function emit(event: TerminalEvent): void {
  for (const l of listeners) l(event)
}

function say(id: string, text: string): void {
  const t = terminals.find((x) => x.id === id)
  if (!t) return
  t.buffer += text
  emit({ type: 'data', id, data: text })
}

function runCommand(id: string, command: string): void {
  const cmd = command.trim()
  const out: string[] = []
  if (cmd === '') {
    // nothing
  } else if (cmd === 'ls' || cmd === 'dir') {
    out.push('', '    Directory: ' + ROOT, '', 'Mode          Name', '----          ----', 'd----         docs', 'd----         public', 'd----         scripts', 'd----         src', '-a---         .gitignore', '-a---         package.json', '-a---         README.md', '-a---         tsconfig.json')
  } else if (cmd === 'git status' || cmd === 'git status -s') {
    out.push('On branch feature/code-workspace', 'Your branch is ahead of \'origin/feature/code-workspace\' by 2 commits.', '', 'Changes to be committed:', '\tmodified:   src/lib/auth/session.ts', '\tmodified:   src/components/Nav.tsx')
  } else if (cmd === 'npm test') {
    out.push('', '> personal-website@0.4.0 test', '> vitest run', '', ' \x1b[32m✓\x1b[0m src/lib/auth/session.test.ts (4 tests) 12ms', ' \x1b[32m✓\x1b[0m src/lib/posts.test.ts (2 tests) 4ms', ' \x1b[31m✗\x1b[0m src/components/Nav.test.tsx (1 test | 1 failed) 31ms', '', ' \x1b[31mFAIL\x1b[0m  Nav renders the contact link', ' \x1b[33mTest Files  1 failed | 2 passed (3)\x1b[0m', '      Tests  1 failed | 6 passed (7)')
  } else if (cmd === 'node -v') {
    out.push('v26.7.0')
  } else {
    out.push(`${cmd.split(' ')[0]} : The term '${cmd.split(' ')[0]}' is not recognized as the name of a cmdlet, function, script file, or operable program.`)
  }
  say(id, out.map((l) => `${l}\r\n`).join('') + PROMPT)
}

export function createMockCodeApi(): Pick<RendererApi, 'fs' | 'git' | 'terminal'> {
  const fs: RendererApi['fs'] = {
    listDir: ({ relativePath }) => delay({ entries: childrenOf(relativePath), truncated: false }),
    readFile: ({ relativePath }): Promise<FsReadResult> => {
      if (relativePath in BINARY_FILES) {
        return delay({ status: 'binary', relativePath, sizeBytes: BINARY_FILES[relativePath] ?? 0, message: 'Binary file - reveal it in the folder to open it elsewhere' })
      }
      if (/(^|\/)\.env/.test(relativePath)) return delay({ status: 'denied', relativePath, sizeBytes: null, message: 'Access is blocked (secrets and .git internals)' })
      const content = FILES[relativePath]
      if (content === undefined) return delay({ status: 'missing', relativePath, sizeBytes: null, message: 'File no longer exists' })
      return delay({
        status: 'ok',
        relativePath,
        content,
        hash: hashOf(content),
        mtimeMs: Date.now(),
        sizeBytes: content.length,
        readOnly: false,
        readOnlyReason: null,
        bom: false,
      })
    },
    writeFile: ({ relativePath, content }) => {
      FILES[relativePath] = content
      return delay({ status: 'saved' as const, hash: hashOf(content), mtimeMs: Date.now(), sizeBytes: content.length })
    },
    listPaths: () => delay({ paths: [...Object.keys(FILES), ...Object.keys(BINARY_FILES)].sort(), truncated: false }),
    searchText: ({ query }) => {
      const needle = query.toLowerCase()
      const matches = Object.entries(FILES).flatMap(([path, text]) =>
        text.split('\n').flatMap((line, i) => {
          const column = line.toLowerCase().indexOf(needle)
          return column === -1 ? [] : [{ relativePath: path, line: i + 1, column: column + 1, preview: line.trim().slice(0, 200) }]
        }),
      )
      return delay({ matches: matches.slice(0, 200), filesScanned: Object.keys(FILES).length, truncated: false })
    },
    reveal: () => delay(undefined),
  }

  const git: RendererApi['git'] = {
    status: () => delay(buildStatus()),
    diff: ({ path, area }): Promise<GitDiffResult> => {
      const modified = FILES[path] ?? ''
      if (area === 'untracked') return delay({ status: 'ok', original: '', modified, originalLabel: '(empty)', modifiedLabel: 'working tree' })
      const original = HEAD[path] ?? ''
      return delay(
        area === 'staged'
          ? { status: 'ok', original, modified, originalLabel: 'HEAD', modifiedLabel: 'staged' }
          : { status: 'ok', original, modified, originalLabel: 'index', modifiedLabel: 'working tree' },
      )
    },
    stage: ({ paths }) => {
      for (const e of state.entries) if (paths.includes(e.path)) e.area = 'staged'
      return delay(undefined)
    },
    unstage: ({ paths }) => {
      for (const e of state.entries) if (paths.includes(e.path)) e.area = e.status === 'untracked' ? 'untracked' : 'unstaged'
      return delay(undefined)
    },
    stageAll: () => {
      for (const e of state.entries) e.area = 'staged'
      return delay(undefined)
    },
    unstageAll: () => {
      for (const e of state.entries) e.area = e.status === 'untracked' ? 'untracked' : 'unstaged'
      return delay(undefined)
    },
    commit: ({ message }) => {
      state.entries = state.entries.filter((e) => e.area !== 'staged')
      state.commits += 1
      const subject = message.split('\n')[0] ?? message
      state.head = { sha: `c0ffee${state.commits}`.padEnd(40, '0'), shortSha: `c0ffee${state.commits}`, subject }
      return delay({ ...state.head })
    },
  }

  const terminal: RendererApi['terminal'] = {
    create: ({ workspaceId }) => {
      const id = `term-${nextTerminal++}`
      const info = {
        id,
        workspaceId,
        title: 'PowerShell',
        shell: 'powershell.exe',
        cwd: ROOT,
        pid: 4000 + nextTerminal,
        status: 'running' as const,
        exitCode: null,
        createdAt: Date.now(),
        buffer: '',
        line: '',
      }
      terminals.push(info)
      setTimeout(() => say(id, `Windows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved.\r\n\r\n${PROMPT}`), 120)
      return delay(publicInfo(info))
    },
    list: (workspaceId) => delay(terminals.filter((t) => t.workspaceId === workspaceId).map(publicInfo)),
    getBuffer: (id) => delay(terminals.find((t) => t.id === id)?.buffer ?? ''),
    write: (id, data) => {
      const t = terminals.find((x) => x.id === id)
      if (!t) return delay(undefined)
      for (const ch of data) {
        if (ch === '\r') {
          const command = t.line
          t.line = ''
          say(id, '\r\n')
          runCommand(id, command)
        } else if (ch === '\x7f') {
          if (t.line.length > 0) {
            t.line = t.line.slice(0, -1)
            say(id, '\b \b')
          }
        } else if (ch >= ' ') {
          t.line += ch
          say(id, ch)
        }
      }
      return delay(undefined, 0)
    },
    resize: () => delay(undefined, 0),
    kill: (id) => {
      const index = terminals.findIndex((t) => t.id === id)
      if (index >= 0) terminals.splice(index, 1)
      return delay(undefined, 0)
    },
    onEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  return { fs, git, terminal }
}

export const MOCK_CODE_WORKSPACE = WORKSPACE
