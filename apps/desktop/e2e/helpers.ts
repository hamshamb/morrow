/// <reference lib="dom" />
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { ConversationRepository, ProviderConfigRepository, SettingsRepository, WorkspaceFileRepository, WorkspaceRepository, openDatabase } from '@ai-workspace/storage'
import type { AppSettingsPartial, RendererApi, TerminalInfo } from '@ai-workspace/shared'

/**
 * Shared plumbing for the real-Electron tests: throwaway user-data dirs (the
 * user's real data is never touched), throwaway git repositories with their
 * own local identity, a seeded SQLite database (a workspace and a placeholder
 * provider so onboarding is skipped), and the launcher.
 */

export const APP_DIR = resolve(__dirname, '..')

export function tempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

/** A realistic little project: one commit on main, with a throwaway local identity. */
export function createProjectRepo(dir: string, options: { withChanges?: boolean } = {}): void {
  const put = (rel: string, content: string): void => {
    const full = join(dir, ...rel.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'E2E Tester')
  git(dir, 'config', 'user.email', 'e2e@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  put('.gitignore', 'node_modules/\ndist/\n.env*\n')
  put('README.md', '# Demo project\n\nA small project used by the end-to-end tests.\n\n## Usage\n\nRun `npm start`.\n')
  put('package.json', '{\n  "name": "demo-project",\n  "version": "1.0.0",\n  "scripts": { "start": "node src/index.js", "test": "vitest run" }\n}\n')
  put(
    'src/index.js',
    `import { greet } from './greet.js'\n\nconst name = process.argv[2] ?? 'world'\nconsole.log(greet(name))\n`,
  )
  put('src/greet.js', `export function greet(name) {\n  return \`Hello, \${name}!\`\n}\n`)
  put(
    'src/lib/session.ts',
    `export interface Session {\n  userId: string\n  expiresAt: number\n}\n\nexport function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt <= now\n}\n\nexport function remaining(session: Session, now = Date.now()): number {\n  return Math.max(0, session.expiresAt - now)\n}\n`,
  )
  put('src/components/Nav.tsx', `export function Nav() {\n  return (\n    <nav>\n      <a href="/">home</a>\n      <a href="/about">about</a>\n    </nav>\n  )\n}\n`)
  put('docs/notes.md', '# Notes\n\n- ship the editor\n- ship the terminal\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: initial commit')

  if (options.withChanges) {
    // staged: a modified file and a modified component
    put('src/lib/session.ts', `export interface Session {\n  userId: string\n  expiresAt: number\n}\n\nexport function isExpired(session: Session, now = Date.now()): boolean {\n  return session.expiresAt <= now\n}\n\nexport function remaining(session: Session, now = Date.now()): number {\n  return Math.max(0, session.expiresAt - now)\n}\n\nexport const REFRESH_WINDOW_MS = 5 * 60 * 1000\n\nexport function needsRefresh(session: Session, now = Date.now()): boolean {\n  return remaining(session, now) < REFRESH_WINDOW_MS\n}\n`)
    put('src/components/Nav.tsx', `export function Nav() {\n  return (\n    <nav aria-label="Primary">\n      <a href="/">home</a>\n      <a href="/about">about</a>\n      <a href="/contact">contact</a>\n    </nav>\n  )\n}\n`)
    git(dir, 'add', 'src/lib/session.ts', 'src/components/Nav.tsx')
    // unstaged: two edits on top of HEAD
    put('src/greet.js', `export function greet(name, punctuation = '!') {\n  return \`Hello, \${name}\${punctuation}\`\n}\n\nexport function farewell(name) {\n  return \`Goodbye, \${name}.\`\n}\n`)
    put('README.md', '# Demo project\n\nA small project used by the end-to-end tests.\n\n## Usage\n\nRun `npm start`, or `npm start -- Ada` to greet someone.\n')
    // untracked
    put('src/lib/format.ts', `export function pad(n: number): string {\n  return String(n).padStart(2, '0')\n}\n\nexport function clock(ms: number): string {\n  const s = Math.floor(ms / 1000)\n  return \`\${pad(Math.floor(s / 60))}:\${pad(s % 60)}\`\n}\n`)
    put('docs/deploy.md', '# Deploying\n\n1. Merge to main.\n2. Tag the release.\n')
  }
}

export const MATH_SOURCE = 'exports.add = (a, b) => a - b\nexports.mul = (a, b) => a * b\n'
export const MATH_TEST = `const test = require('node:test')
const assert = require('node:assert')
const { add, mul } = require('./src/math.js')

test('add adds', () => {
  assert.strictEqual(add(2, 3), 5)
})

test('mul multiplies', () => {
  assert.strictEqual(mul(2, 3), 6)
})
`

/** A tiny project with ONE failing test (add() subtracts) - the brief's "find why this test is failing and fix it". */
export function createFailingTestRepo(dir: string): void {
  const put = (rel: string, content: string): void => {
    const full = join(dir, ...rel.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'E2E Tester')
  git(dir, 'config', 'user.email', 'e2e@example.invalid')
  git(dir, 'config', 'commit.gpgsign', 'false')
  git(dir, 'config', 'core.autocrlf', 'false')
  put('.gitignore', 'node_modules/\n')
  put('package.json', '{\n  "name": "demo-math",\n  "version": "1.0.0",\n  "scripts": { "test": "node --test" }\n}\n')
  put('src/math.js', MATH_SOURCE)
  put('math.test.js', MATH_TEST)
  put('README.md', '# demo-math\n\nA tiny project with one failing test.\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'chore: initial commit')
}

/**
 * Like `seedUserData`, but the only keyless provider is a CUSTOM endpoint pointing at `stubUrl` (the scripted model
 * server), the workspace folder is already chosen, one session exists and the composer remembers the stub model. A
 * second provider (Groq) is added so a model WITHOUT tool support can be selected.
 */
export function seedAgentUserData(
  stubUrl: string,
  repo: string,
  settings: AppSettingsPartial = {},
): Seed & { conversationId: string; stubConfigId: string; groqConfigId: string } {
  const userData = tempDir('aiw-e2e-agent-userdata-')
  mkdirSync(join(userData, 'data'), { recursive: true })
  const db = openDatabase(join(userData, 'data', 'workspace.sqlite3'))
  try {
    const workspace = new WorkspaceRepository(db).create({ name: 'Math project' })
    new WorkspaceFileRepository(db).setRoot(workspace.id, repo)
    const conversation = new ConversationRepository(db).create({ workspaceId: workspace.id })
    const configs = new ProviderConfigRepository(db)
    const stub = configs.create({ provider: 'custom', label: 'Stub model', maskedKey: 'no key', encryptedKey: Buffer.alloc(0), baseUrl: stubUrl })
    const groq = configs.create({ provider: 'groq', label: 'Groq', maskedKey: 'gsk_…e2e0', encryptedKey: Buffer.from('placeholder-not-a-real-key'), baseUrl: null })
    new SettingsRepository(db).set({
      activeWorkspaceId: workspace.id,
      modelsDevFetchEnabled: false,
      lastModelSelection: { providerConfigId: stub.id, model: 'stub-model', effort: null },
      ...settings,
    })
    return { userData, workspaceIds: [workspace.id], conversationId: conversation.id, stubConfigId: stub.id, groqConfigId: groq.id }
  } finally {
    db.close()
  }
}

export interface Seed {
  userData: string
  workspaceIds: string[]
}

/**
 * Creates `<userData>/data/workspace.sqlite3` with the app's own migrations and
 * seeds workspaces + a placeholder provider key (never used - no request is made).
 */
export function seedUserData(
  workspaces: { name: string; root?: string }[],
  settings: AppSettingsPartial = {},
): Seed {
  const userData = tempDir('aiw-e2e-userdata-')
  mkdirSync(join(userData, 'data'), { recursive: true })
  const db = openDatabase(join(userData, 'data', 'workspace.sqlite3'))
  try {
    const wsRepo = new WorkspaceRepository(db)
    const files = new WorkspaceFileRepository(db)
    const ids: string[] = []
    for (const w of workspaces) {
      const created = wsRepo.create({ name: w.name })
      ids.push(created.id)
      if (w.root) files.setRoot(created.id, w.root)
    }
    new ProviderConfigRepository(db).create({
      provider: 'anthropic',
      label: 'Anthropic',
      maskedKey: 'sk-ant-…e2e0',
      encryptedKey: Buffer.from('placeholder-not-a-real-key'),
      baseUrl: null,
    })
    // Skip the models.dev download: the e2e must not touch the network.
    new SettingsRepository(db).set({ activeWorkspaceId: ids[0] ?? null, modelsDevFetchEnabled: false, ...settings })
    return { userData, workspaceIds: ids }
  } finally {
    db.close()
  }
}

export interface Launched {
  app: ElectronApplication
  page: Page
  /** Main-process stderr lines (Playwright's own inspector chatter filtered out). */
  stderr: string[]
}

export async function launchApp(userData: string, options: { env?: NodeJS.ProcessEnv; size?: { width: number; height: number } } = {}): Promise<Launched> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'ELECTRON_RENDERER_URL') env[key] = value
  }
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: APP_DIR,
    env,
  })
  const stderr: string[] = []
  app.process().stderr?.on('data', (chunk: Buffer) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const text = line.trim()
      // Chatter that is not the app's: Playwright's inspector, and the startup model-list refresh
      // choking on the placeholder (not a real ciphertext) key `seedUserData` stores.
      const noise = /Debugger (listening|ending)|nodejs\.org\/en\/docs\/inspector|^For help, see|model-catalog:refresh|safeStorage|decryptSecret|ProviderCatalogService|node:electron\/js2c|node:events|^at |^    at /
      if (text && !noise.test(text)) stderr.push(text)
    }
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.topbar', { timeout: 60_000 })
  if (options.size) await setContentSize(app, options.size.width, options.size.height)
  return { app, page, stderr }
}

export async function setContentSize(app: ElectronApplication, width: number, height: number): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      win.setMinimumSize(400, 300)
      win.setContentSize(w as number, h as number)
      win.center()
    },
    [width, height],
  )
}

/** The native folder picker can't be driven; the main process's `dialog.showOpenDialog` is stubbed to answer with `folder`. */
export async function stubFolderDialog(app: ElectronApplication, folder: string): Promise<void> {
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: false, filePaths: [picked] })) as typeof dialog.showOpenDialog
  }, folder)
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const IS_WINDOWS = process.platform === 'win32'

/** A command whose OUTPUT (e2e-42) differs from its typed text, in the platform's default shell. */
export const ECHO_COMMAND = IS_WINDOWS ? "Write-Output ('e2e-' + (6*7))" : 'echo e2e-$((6*7))'
export const ECHO_EXPECTED = 'e2e-42'

/** The terminals the main process currently holds for a workspace (via the real preload API). */
export function listTerminals(page: Page, workspaceId: string): Promise<TerminalInfo[]> {
  return page.evaluate((id) => (window as unknown as { api: RendererApi }).api.terminal.list(id), workspaceId)
}

/** Closes the app; if it doesn't quit in time (e.g. an unexpected unsaved-changes dialog), kills it so a test run can never hang. */
export async function closeApp(app: ElectronApplication, timeoutMs = 20_000): Promise<'closed' | 'killed'> {
  const outcome = await Promise.race([
    app.close().then(() => 'closed' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
  ])
  if (outcome === 'closed') return 'closed'
  app.process().kill()
  return 'killed'
}
