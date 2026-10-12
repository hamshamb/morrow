/// <reference lib="dom" />
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  ECHO_COMMAND,
  ECHO_EXPECTED,
  closeApp,
  createProjectRepo,
  git,
  launchApp,
  listTerminals,
  processAlive,
  seedUserData,
  stubFolderDialog,
  tempDir,
} from './helpers'

/**
 * The brief's critical path, in the real app: open a repository, edit a file
 * and save it, run a command in the terminal, inspect the diff, stage and
 * commit - then quit and prove no shell survives.
 */

test.describe.serial('code workspace - critical path', () => {
  let app: ElectronApplication
  let page: Page
  let stderr: string[] = []
  let repo: string
  let userData: string
  let workspaceId: string
  const problems: string[] = []

  test.beforeAll(async () => {
    repo = tempDir('aiw-e2e-repo-')
    createProjectRepo(repo)
    const seed = seedUserData([{ name: 'E2E project' }])
    userData = seed.userData
    workspaceId = seed.workspaceIds[0] as string
    ;({ app, page, stderr } = await launchApp(userData, { size: { width: 1440, height: 900 } }))
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error' || /content security policy|refused to|worker/i.test(m.text())) problems.push(`console.${m.type()}: ${m.text()}`)
    })
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    rmSync(repo, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  test('1. open a repository: choose a folder, browse the lazy tree', async () => {
    await stubFolderDialog(app, repo)
    await page.getByRole('button', { name: '/code' }).click()
    await expect(page.getByText('No folder chosen for this workspace')).toBeVisible()
    await page.getByRole('button', { name: '[choose a folder]' }).click()

    const tree = page.getByRole('tree', { name: 'Files' })
    await expect(tree.getByRole('treeitem', { name: /README\.md/ })).toBeVisible()
    // Deny-listed / ignored entries never reach the renderer.
    await expect(tree.locator('[data-path=".git"]')).toHaveCount(0)
    await expect(tree.locator('[data-path="node_modules"]')).toHaveCount(0)
    await tree.locator('[data-path="src"]').click()
    await expect(tree.locator('[data-path="src/greet.js"]')).toBeVisible()
  })

  test('2. edit a file and save it with Ctrl+S (atomic write, dirty marker clears)', async () => {
    await page.locator('[data-path="src/greet.js"]').click()
    await expect(page.locator('.editor-tab.is-active')).toContainText('greet.js')
    const editor = page.locator('.monaco-editor .view-lines').first()
    await expect(editor).toContainText('Hello')
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('// edited by the e2e test\n')
    await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(1)
    await expect(page.locator('.topbar__dirty')).toBeVisible()

    await page.keyboard.press('Control+s')
    await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(0)
    expect(readFileSync(join(repo, 'src', 'greet.js'), 'utf8')).toContain('// edited by the e2e test')
    // Saved atomically: no temp file left beside it.
    expect(git(repo, 'status', '--porcelain')).toBe('M src/greet.js')
  })

  test('3. a file changed on disk since it was opened asks before overwriting', async () => {
    await page.getByRole('button', { name: '[open file]' }).click()
    await page.keyboard.type('README')
    await page.keyboard.press('Enter')
    await expect(page.locator('.editor-tab.is-active')).toContainText('README.md')
    const editor = page.locator('.monaco-editor .view-lines').first()
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type('my local line')
    // Somebody else edits the file meanwhile...
    writeFileSync(join(repo, 'README.md'), '# Replaced from outside\n')
    await page.keyboard.press('Control+s')
    await expect(page.getByText('This file changed on disk since you opened it.')).toBeVisible()
    expect(readFileSync(join(repo, 'README.md'), 'utf8')).toBe('# Replaced from outside\n') // not silently overwritten
    await page.getByRole('button', { name: '[reload from disk]' }).click()
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('Replaced from outside')
    await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(0)
    git(repo, 'checkout', '-q', '--', 'README.md') // test housekeeping: back to HEAD
  })

  test('4. closing a dirty tab asks inline (no modal) and Ctrl+W closes a clean one', async () => {
    const editor = page.locator('.monaco-editor .view-lines').first()
    await editor.click()
    await page.keyboard.type('x')
    await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(1)
    await page.keyboard.press('Control+w')
    await expect(page.getByText('has unsaved changes.')).toBeVisible()
    await page.getByRole('button', { name: '[discard]' }).click()
    await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toHaveCount(0)
    await page.keyboard.press('Control+w')
    await expect(page.locator('.editor-tab')).toHaveCount(0)
  })

  test('5. quick open and text search find files and lines', async () => {
    await page.keyboard.press('Control+p')
    await expect(page.locator('[data-quick-open] input')).toBeFocused()
    await page.keyboard.type('sess')
    await expect(page.locator('.command-palette__row').first()).toContainText('session.ts')
    await page.keyboard.press('Enter')
    await expect(page.locator('.editor-tab.is-active')).toContainText('session.ts')

    await page.keyboard.press('Control+Shift+f')
    await expect(page.locator('.search-panel__input')).toBeFocused()
    await page.keyboard.type('isExpired')
    // Nothing leaked into the open file while typing the query.
    await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(0)
    await expect(page.locator('.search-hit').first()).toContainText('isExpired')
    await page.locator('.search-hit').first().click()
    await expect(page.locator('.status-bar')).toContainText(/Ln \d+/)
  })

  test('5b. middle-click closes a tab', async () => {
    await page.keyboard.press('Control+p')
    await expect(page.locator('[data-quick-open] input')).toBeFocused()
    await page.keyboard.type('index.js')
    await page.keyboard.press('Enter')
    await expect(page.locator('.editor-tab.is-active')).toContainText('index.js')
    await expect(page.locator('.editor-tab')).toHaveCount(2)
    await page.locator('.editor-tab', { hasText: 'index.js' }).click({ button: 'middle' })
    await expect(page.locator('.editor-tab', { hasText: 'index.js' })).toHaveCount(0)
    await expect(page.locator('.editor-tab.is-active')).toContainText('session.ts')
  })

  test('6. a terminal starts only when asked, runs a command and shows its output', async () => {
    // Nothing runs until the user asks: no shell exists yet.
    const before = await listTerminals(page, workspaceId)
    expect(before).toHaveLength(0)

    await page.keyboard.press('Control+`')
    await expect(page.locator('.xterm')).toBeVisible()
    const rows = page.locator('.xterm-rows')
    await page.locator('.xterm').click()
    await expect(rows).toContainText(/PS |>|\$/, { timeout: 30_000 }) // a prompt appeared
    await page.keyboard.type(ECHO_COMMAND)
    await page.keyboard.press('Enter')
    await expect(rows).toContainText(ECHO_EXPECTED, { timeout: 30_000 })

    const [info] = await listTerminals(page, workspaceId)
    expect(info?.status).toBe('running')
    expect(info?.cwd.toLowerCase()).toBe(repo.toLowerCase())
    expect(info?.pid ?? 0).toBeGreaterThan(0)
    expect(processAlive(info?.pid ?? 0)).toBe(true)

    // The terminal can drive the repo too: create a file with a command; the tree follows.
    await page.keyboard.type(process.platform === 'win32' ? "Set-Content -Path made-in-terminal.txt -Value 'hi'" : "echo hi > made-in-terminal.txt")
    await page.keyboard.press('Enter')
    await expect.poll(() => git(repo, 'status', '--porcelain', '--untracked-files=all')).toContain('made-in-terminal.txt')
  })

  test('6b. more terminals, exit status + restart, and the Output tab', async () => {
    await page.getByRole('button', { name: '[+ new terminal]' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(2)
    await expect(page.locator('.xterm').nth(1)).toBeVisible()
    await page.locator('.terminal-view:not([hidden]) .xterm').click()
    await expect(page.locator('.terminal-view:not([hidden]) .xterm-rows')).toContainText(/PS |>|\$/, { timeout: 30_000 })
    await page.keyboard.type('exit 3')
    await page.keyboard.press('Enter')
    await expect(page.getByText('Process exited with code 3.')).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.term-tab.is-exited')).toHaveCount(1)

    await page.getByRole('button', { name: '[restart]' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(2) // the dead one was replaced
    await expect(page.locator('.term-tab.is-exited')).toHaveCount(0)

    // Output tab: the log of what the workspace did.
    await page.getByRole('tab', { name: /^output/ }).click()
    await expect(page.locator('.output-log')).toContainText('saved src/greet.js')
    await expect(page.locator('.output-log')).toContainText('terminal exited with code 3')
    await page.getByRole('tab', { name: 'terminal' }).click()
  })

  test('7. changes view: groups, +N -M, and a real diff', async () => {
    await page.getByRole('button', { name: '/git' }).click()
    await expect(page.locator('.chip--inverted', { hasText: 'main' })).toBeVisible()
    await expect(page.getByText('chore: initial commit')).toBeVisible()
    const unstaged = page.getByRole('region', { name: 'unstaged' })
    await expect(unstaged.locator('.change-row', { hasText: 'greet.js' })).toContainText('+1')
    await expect(page.getByRole('region', { name: 'untracked' }).locator('.change-row', { hasText: 'made-in-terminal.txt' })).toBeVisible()

    await unstaged.locator('.change-row__main', { hasText: 'greet.js' }).click()
    await expect(page.locator('.diff-viewer .monaco-diff-editor')).toBeVisible()
    await expect(page.locator('.diff-viewer')).toContainText('edited by the e2e test')
    await page.getByRole('button', { name: 'inline' }).click()
    await expect(page.locator('.diff-viewer .monaco-diff-editor')).toBeVisible()
  })

  test('7b. Monaco ran its worker under the unchanged CSP: no violations or errors were logged', async () => {
    // The diff editor started its worker from the bundled asset (file:// under CSP 'self').
    await expect.poll(() => page.workers().map((w) => w.url()).some((url) => /editor\.worker-.*\.js$/.test(url))).toBe(true)
    const csp = await page.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'))
    expect(csp).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;")
    expect(problems).toEqual([])
  })

  test('8. stage, then commit - the commit has the repo identity and the right content', async () => {
    const commitButton = page.getByRole('button', { name: /^commit \d+ staged|^commit/ })
    await expect(commitButton).toBeDisabled() // nothing staged, no message

    await page.getByRole('button', { name: 'stage src/greet.js' }).click()
    await expect(page.getByRole('region', { name: 'staged' }).locator('.change-row', { hasText: 'greet.js' })).toBeVisible()
    await expect(commitButton).toBeDisabled() // staged, but still no message

    await page.locator('#commit-message').fill('feat: edit greet from the e2e test')
    await expect(page.getByRole('button', { name: /commit 1 staged/ })).toBeEnabled()
    await page.getByRole('button', { name: /commit 1 staged/ }).click()

    await expect(page.getByText(/committed [0-9a-f]{7} feat: edit greet/)).toBeVisible()
    expect(git(repo, 'log', '-1', '--format=%an <%ae>|%s')).toBe('E2E Tester <e2e@example.invalid>|feat: edit greet from the e2e test')
    expect(git(repo, 'show', 'HEAD:src/greet.js')).toContain('// edited by the e2e test')
    // Only the staged file was committed.
    expect(git(repo, 'status', '--porcelain', '--untracked-files=all')).toBe('?? made-in-terminal.txt')
    // No push / reset / clean affordance exists anywhere in the UI.
    for (const word of [/push/i, /reset/i, /\bclean\b/i, /force/i]) {
      await expect(page.locator('.git-view').getByRole('button', { name: word })).toHaveCount(0)
    }
  })

  test('9. quitting the app kills every shell (no orphan processes)', async () => {
    const running = (await listTerminals(page, workspaceId)).filter((t) => t.status === 'running')
    const pids = running.map((t) => t.pid ?? 0)
    expect(pids.length).toBeGreaterThanOrEqual(2) // the first terminal and the restarted one
    for (const pid of pids) expect(processAlive(pid)).toBe(true)
    expect(stderr, 'the main process wrote nothing to stderr during the whole session').toEqual([])
    // Nothing unsaved is left, so quitting must not stop on the unsaved-changes dialog.
    await expect(page.locator('.topbar__dirty')).toHaveCount(0)
    expect(await closeApp(app)).toBe('closed')
    for (const pid of pids) await expect.poll(() => processAlive(pid), { timeout: 20_000 }).toBe(false)
  })

  test('10. relaunch: the open tabs come back and the terminal does not auto-start', async () => {
    ;({ app, page } = await launchApp(userData, { size: { width: 1440, height: 900 } }))
    await page.getByRole('button', { name: '/code' }).click()
    await expect(page.locator('.editor-tab', { hasText: 'session.ts' })).toBeVisible({ timeout: 30_000 })
    const terminals = await listTerminals(page, workspaceId)
    expect(terminals).toHaveLength(0)
  })
})
