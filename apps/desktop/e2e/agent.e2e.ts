/// <reference lib="dom" />
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { RendererApi } from '@ai-workspace/shared'
import { MATH_SOURCE, closeApp, createFailingTestRepo, launchApp, processAlive, seedAgentUserData, tempDir } from './helpers'
import { call, startStubModel, type StubModel } from './stub-model'

/**
 * The Phase 5 acceptance flow in the REAL built app: the user says "Find why this test is failing and fix it." and a
 * scripted model (a local OpenAI-compatible server the app uses as a custom endpoint, so the real provider adapter and
 * the real AI SDK are exercised) reads files, asks to patch one, asks to run the tests. Everything it asks for goes
 * through the real permission engine; the report is checked against the disk and the real exit codes.
 */

/** Best-effort cleanup: a directory a just-killed process still holds open must not mask the real test failure. */
function tidy(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
  } catch {
    /* left for the OS temp cleaner */
  }
}

const PROMPT = 'Find why this test is failing and fix it.'
const FIXED = MATH_SOURCE.replace('(a, b) => a - b\nexports.mul', '(a, b) => a + b\nexports.mul')

test.describe.serial('agent: Build mode end to end', () => {
  let stub: StubModel
  let app: ElectronApplication
  let page: Page
  let stderr: string[] = []
  let repo: string
  let userData: string
  let seed: ReturnType<typeof seedAgentUserData>
  const problems: string[] = []

  const composer = (): Locator => page.locator('#composer-input')
  const prompt = (): Locator => page.locator('.permission')
  const row = (toolId: string): Locator => page.locator(`.agent-row[data-tool-id="${toolId}"]`)
  const disk = (rel: string): string => readFileSync(join(repo, ...rel.split('/')), 'utf8')

  async function setMode(mode: 'plan' | 'build' | 'chat'): Promise<void> {
    await page.locator('.mode-chip__trigger').click()
    await page.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click()
    await expect(page.locator('.mode-chip__trigger')).toContainText(mode)
  }

  async function ask(text: string): Promise<void> {
    await composer().fill(text)
    await composer().press('Enter')
  }

  async function answer(label: string): Promise<void> {
    await prompt().getByRole('button', { name: label, exact: true }).click()
  }

  test.beforeAll(async () => {
    stub = await startStubModel()
    repo = tempDir('aiw-e2e-agent-repo-')
    createFailingTestRepo(repo)
    seed = seedAgentUserData(stub.url, repo)
    userData = seed.userData
    ;({ app, page, stderr } = await launchApp(userData, { size: { width: 1440, height: 900 } }))
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`)
    })
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    await stub?.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(userData, { recursive: true, force: true })
  })

  test('1. "Find why this test is failing and fix it." - read freely, patch and run only with approval, report from the facts', async () => {
    await setMode('build')
    stub.setScript([
      call('filesystem_list', {}, 'Let me look at the project first.'),
      call('filesystem_read', { path: 'math.test.js' }),
      call('filesystem_read', { path: 'src/math.js' }),
      call('terminal_execute', { command: 'node --test' }, 'Running the tests to see how they fail.'),
      call('filesystem_patch', { path: 'src/math.js', old_string: 'exports.add = (a, b) => a - b', new_string: 'exports.add = (a, b) => a + b' }, 'add() subtracts instead of adding. Patching it.'),
      call('terminal_execute', { command: 'node --test' }),
      { text: 'The bug was in `add()` in `src/math.js`: it subtracted. I changed it to add, and the tests pass now.\n\nRemaining concerns: none.' },
    ])
    expect(disk('src/math.js')).toBe(MATH_SOURCE)
    await ask(PROMPT)

    // --- reads run with NO prompt
    await expect(row('filesystem.list')).toBeVisible()
    await expect(row('filesystem.read')).toHaveCount(2)
    await expect(row('filesystem.read').first()).toContainText('math.test.js')
    // (the audit log below proves no read ever asked)

    // --- first command: exact command + cwd + shell + timeout, nothing has run yet
    await expect(prompt()).toBeVisible()
    await expect(prompt().locator('.permission__heading')).toContainText('AGENT REQUESTS · run (execution)')
    await expect(prompt().locator('.permission__command')).toHaveText('node --test')
    await expect(prompt()).toContainText(repo)
    await expect(prompt().getByRole('button')).toHaveText(['[allow once]', '[allow session]', '[allow workspace]', '[deny]'])
    await answer('[allow once]')

    // --- the test really runs and fails (exit 1), shown as an activity row
    await expect(row('terminal.execute').first()).toContainText('exit 1')
    await expect(row('terminal.execute').first()).toHaveAttribute('data-status', 'error')

    // --- the patch prompt shows the diff; the file on disk is untouched while it is open
    await expect(prompt()).toBeVisible()
    await expect(prompt().locator('.permission__heading')).toContainText('AGENT REQUESTS · patch (write)')
    await expect(prompt().locator('.permission__path-name')).toHaveText('src/math.js')
    await expect(prompt().locator('.agent-diff__line--add').filter({ hasText: '+exports.add = (a, b) => a + b' })).toBeVisible()
    await expect(prompt().locator('.agent-diff__line--del').filter({ hasText: '-exports.add = (a, b) => a - b' })).toBeVisible()
    expect(disk('src/math.js')).toBe(MATH_SOURCE)
    await answer('[allow workspace]')

    // --- second run of the tests: approve for the session; it passes
    await expect(prompt().locator('.permission__command')).toHaveText('node --test')
    expect(disk('src/math.js')).toBe(FIXED) // the approved patch is on disk, exactly
    await answer('[allow session]')

    // --- the run finishes; the report comes from the audit log and the disk
    const report = page.locator('.run-report')
    await expect(report).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.assistant-message').last()).toContainText('The bug was in')
    await expect(report.locator('.run-report__section', { hasText: 'files inspected' })).toContainText('math.test.js · src/math.js')
    const changed = report.locator('.run-report__section', { hasText: 'files changed' })
    await expect(changed).toContainText('src/math.js')
    await expect(changed).toContainText('+1')
    await expect(changed).toContainText('-1')
    await expect(changed).toContainText('verified on disk')
    const commands = report.locator('.run-report__section', { hasText: 'commands executed' })
    await expect(commands.locator('.run-report__line')).toHaveCount(2)
    await expect(commands.locator('.run-report__line').nth(0)).toContainText('exit 1')
    await expect(commands.locator('.run-report__line').nth(1)).toContainText('exit 0')
    const tests = report.locator('.run-report__section', { hasText: 'tests' }).last()
    await expect(tests).toContainText('PASSED')
    await expect(report.locator('.run-report__section--model')).toContainText('none')

    // --- facts on disk and in the persisted records
    expect(disk('src/math.js')).toBe(FIXED)
    const messages = await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.conversations.listMessages(id), seed.conversationId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]?.parts[0]?.content).toContain('The bug was in')
    const runs = await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.agent.listRuns(id), seed.conversationId)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'completed', mode: 'build', agentId: 'implementer' })
    expect(runs[0]?.toolRuns.map((t) => [t.toolId, t.status, t.decisionSource])).toEqual([
      ['filesystem.list', 'ok', 'default-safe'],
      ['filesystem.read', 'ok', 'default-safe'],
      ['filesystem.read', 'ok', 'default-safe'],
      ['terminal.execute', 'error', 'prompt-once'],
      ['filesystem.patch', 'ok', 'prompt-workspace'],
      ['terminal.execute', 'ok', 'prompt-session'],
    ])
    expect(runs[0]?.toolRuns.filter((t) => t.toolId === 'terminal.execute').map((t) => t.exitCode)).toEqual([1, 0])

    // --- what the model was sent: tool results as tool messages, never as instructions
    expect(stub.requests).toHaveLength(7)
    const system = stub.requests[0]!.messages.filter((m) => m.role === 'system')
    expect(system).toHaveLength(1)
    expect(JSON.stringify(system[0]!.content)).toContain('DATA from the user')
    const toolMessages = stub.requests[6]!.messages.filter((m) => m.role === 'tool')
    expect(toolMessages.length).toBeGreaterThanOrEqual(6)
    expect(JSON.stringify(toolMessages.at(-1)!.content)).toContain('exit code: 0')
    expect(JSON.stringify(stub.requests[0]!.tools?.map((t) => t.function.name))).toContain('filesystem_patch')
  })

  test('2. Settings -> Permissions lists the grants given in the prompts; revoking works', async () => {
    await page.getByRole('button', { name: '[settings]' }).click()
    await page.getByRole('button', { name: 'permissions', exact: true }).click()
    const rows = page.locator('.permission-grant')
    await expect(rows).toHaveCount(2)
    await expect(rows.filter({ hasText: 'edit files' })).toContainText('workspace')
    await expect(rows.filter({ hasText: 'run a command' })).toContainText('session')
    await expect(rows.filter({ hasText: 'run a command' })).toContainText('node --test')
    // Revoke the session grant (two clicks: the app's inline confirm).
    const session = rows.filter({ hasText: 'run a command' })
    await session.getByRole('button', { name: '[revoke]' }).click()
    await session.getByRole('button', { name: '[confirm revoke]' }).click()
    await expect(rows).toHaveCount(1)
    await page.getByRole('button', { name: 'agents', exact: true }).click()
    await expect(page.locator('.agent-def__name', { hasText: 'Implementer' })).toBeVisible()
    await expect(page.locator('.agent-def')).toHaveCount(6)
    await page.keyboard.press('Escape')
    await expect(page.locator('.overlay')).toHaveCount(0)
  })

  test('3. Changes panel: file with +1 -1, its diff, and [revert file] restores the exact original bytes', async () => {
    await page.getByRole('button', { name: /^\[changes 1\]$/ }).click()
    const panel = page.locator('.changes-panel')
    await expect(panel).toBeVisible()
    const file = panel.locator('.changes-file', { hasText: 'src/math.js' })
    await expect(file).toBeVisible()
    await expect(file.locator('.diff-changes__add')).toHaveText('+1')
    await expect(file.locator('.diff-changes__del')).toHaveText('-1')
    await file.locator('.changes-file__main').click()
    // Monaco's diff editor (lazy) renders the pre-run text against the file now.
    await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 30_000 })
    await expect(panel.locator('.monaco-diff-editor')).toContainText('exports.add')

    await file.getByRole('button', { name: '[revert file]' }).click()
    await expect(panel.locator('.changes-panel__note')).toContainText('reverted src/math.js')
    expect(readFileSync(join(repo, 'src', 'math.js')).equals(Buffer.from(MATH_SOURCE))).toBe(true)
    await expect(file).toContainText('reverted')
    // The change view of the chat also shows git agrees: working tree is clean again.
    expect((await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.git.status(id), seed.workspaceIds[0]!)).state).toBe('ok')
    await panel.getByRole('button', { name: '[close]' }).click()
  })

  test('4. a destructive command offers only allow-once / deny, with a warning; deny keeps the file and the report says so', async () => {
    stub.setScript([
      call('terminal_execute', { command: 'rm src/math.js' }, 'I will delete the file and start over.'),
      { text: 'Understood, I will leave src/math.js alone.\n\nRemaining concerns: I could not rewrite the module.' },
    ])
    await ask('Delete src/math.js and rewrite it from scratch.')
    await expect(prompt()).toBeVisible()
    await expect(prompt()).toHaveClass(/permission--destructive/)
    await expect(prompt().locator('.permission__heading')).toContainText('AGENT REQUESTS · run (destructive)')
    await expect(prompt().locator('.permission__heading .chip')).toContainText('destructive')
    await expect(prompt().locator('.permission__command')).toHaveText('rm src/math.js')
    await expect(prompt().locator('.permission__reasons')).toContainText('deletes files')
    await expect(prompt().locator('.permission__note.signal')).toContainText('only be allowed once')
    await expect(prompt().getByRole('button')).toHaveText(['[allow once]', '[deny]'])
    // Keyboard: the shortcuts for the grants that do not exist do nothing; D denies.
    await prompt().focus()
    await page.keyboard.press('w')
    await page.keyboard.press('s')
    await expect(prompt()).toBeVisible()
    expect(existsSync(join(repo, 'src', 'math.js'))).toBe(true)
    await page.keyboard.press('d')
    await expect(page.locator('.run-report').last()).toContainText('denied by you', { timeout: 60_000 })
    expect(existsSync(join(repo, 'src', 'math.js'))).toBe(true)
    await expect(page.locator('.assistant-message').last()).toContainText('I will leave src/math.js alone')
    await expect(page.locator('.run-report').last().locator('.run-report__section--model')).toContainText('could not rewrite')
    // The model was told it was denied, as a tool result.
    expect(JSON.stringify(stub.requests[1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content)).toContain('DENIED')
  })

  test('5. cancel mid-run kills the running command, withdraws nothing it did not approve, and the report says stopped', async () => {
    const pidFile = join(repo, 'pid.txt')
    stub.setScript([
      call('terminal_execute', { command: `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(()=>{},120000)"` }, 'Starting a long job.'),
      { text: 'never reached' },
    ])
    await ask('Run the long job.')
    await expect(prompt()).toBeVisible()
    await answer('[allow once]')
    await expect.poll(() => existsSync(pidFile), { timeout: 30_000 }).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(processAlive(pid)).toBe(true)
    await expect(row('terminal.execute').last()).toHaveAttribute('data-status', 'running')
    await page.locator('.agent-block--live').getByRole('button', { name: '[stop ■]' }).click()
    await expect(page.locator('.agent-block').last()).toContainText('stopped', { timeout: 30_000 })
    await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false)
    await expect(row('terminal.execute').last()).toHaveAttribute('data-status', 'cancelled')
    await expect(page.locator('.run-report').last()).toContainText('stopped by you')
    expect(stub.requests).toHaveLength(1) // the loop did not continue after the stop
    await expect(composer()).toBeEnabled()
  })

  test('6. Plan mode: the read-only Planner is not even offered an edit tool or the terminal', async () => {
    await setMode('plan')
    stub.setScript([call('filesystem_read', { path: 'README.md' }, 'Reading the readme.'), { text: '1. Fix add() in src/math.js.\n2. Run the tests.\n\nRemaining concerns: none.' }])
    await ask('Plan the fix.')
    await expect(page.locator('.assistant-message').last()).toContainText('Fix add()', { timeout: 60_000 })
    const offered = (stub.requests[0]!.tools ?? []).map((t) => t.function.name)
    expect(offered).toContain('filesystem_read')
    for (const forbidden of ['filesystem_write', 'filesystem_patch', 'terminal_execute']) expect(offered).not.toContain(forbidden)
    expect(await prompt().count()).toBe(0)
    await expect(page.locator('.agent-block').last()).toContainText('plan')
    await expect(page.locator('.agent-block').last().locator('.chip', { hasText: 'Planner' })).toBeVisible()
  })

  test('7. a model without tool support cannot run Plan or Build - the UI says why instead of failing', async () => {
    await page.evaluate(
      ({ id }) => (window as unknown as { api: RendererApi }).api.settings.set({ lastModelSelection: { providerConfigId: id, model: 'allam-2-7b', effort: null } }),
      { id: seed.groqConfigId },
    )
    await page.reload()
    await page.waitForSelector('.topbar')
    await setMode('chat')
    await page.locator('.mode-chip__trigger').click()
    const build = page.getByRole('menuitemradio', { name: /^build/ })
    await expect(build).toHaveAttribute('aria-disabled', 'true')
    await expect(build).toContainText('no tool support')
    await expect(page.getByRole('menuitemradio', { name: /^plan/ })).toHaveAttribute('aria-disabled', 'true')
    await build.click({ force: true })
    await expect(page.locator('.mode-chip__trigger')).toContainText('chat') // it did not switch
    await page.keyboard.press('Escape')
  })

  test('8. quiet: no console errors, empty main-process stderr', async () => {
    expect(problems.filter((p) => !/ResizeObserver|Failed to load resource/.test(p))).toEqual([])
    expect(stderr).toEqual([])
  })
})

test.describe.serial('agent: quit', () => {
  test('quitting the app while a command is running kills it (no process outlives the app)', async () => {
    const stub = await startStubModel()
    const repo = tempDir('aiw-e2e-agent-repo3-')
    createFailingTestRepo(repo)
    const seed = seedAgentUserData(stub.url, repo)
    const launched = await launchApp(seed.userData, { size: { width: 1440, height: 900 } })
    try {
      await launched.page.locator('.mode-chip__trigger').click()
      await launched.page.getByRole('menuitemradio', { name: /^build/ }).click()
      stub.setScript([
        call('terminal_execute', { command: `node -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(()=>{},120000)"` }),
        { text: 'never' },
      ])
      await launched.page.locator('#composer-input').fill('Run the long job.')
      await launched.page.locator('#composer-input').press('Enter')
      await launched.page.locator('.permission').getByRole('button', { name: '[allow once]', exact: true }).click()
      await expect.poll(() => existsSync(join(repo, 'pid.txt')), { timeout: 30_000 }).toBe(true)
      const pid = Number(readFileSync(join(repo, 'pid.txt'), 'utf8'))
      expect(processAlive(pid)).toBe(true)
      await closeApp(launched.app)
      await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false)
    } finally {
      await closeApp(launched.app).catch(() => undefined)
      await stub.close()
      tidy(repo)
      tidy(seed.userData)
    }
  })

  test('quitting while a permission prompt is open leaves nothing running and the run is closed on the next start', async () => {
    const stub = await startStubModel()
    const repo = tempDir('aiw-e2e-agent-repo4-')
    createFailingTestRepo(repo)
    const seed = seedAgentUserData(stub.url, repo)
    let launched = await launchApp(seed.userData, { size: { width: 1440, height: 900 } })
    try {
      await launched.page.locator('.mode-chip__trigger').click()
      await launched.page.getByRole('menuitemradio', { name: /^build/ }).click()
      stub.setScript([call('terminal_execute', { command: `node -e "require('fs').writeFileSync('should-not-exist.txt','x')"` }), { text: 'never' }])
      await launched.page.locator('#composer-input').fill('Write the marker file.')
      await launched.page.locator('#composer-input').press('Enter')
      await expect(launched.page.locator('.permission')).toBeVisible()
      await closeApp(launched.app) // never answered
      expect(existsSync(join(repo, 'should-not-exist.txt'))).toBe(false)

      launched = await launchApp(seed.userData, { size: { width: 1440, height: 900 } })
      // The unfinished run is closed, not left "running" forever, and no stale prompt comes back.
      await expect(launched.page.locator('.permission')).toHaveCount(0)
      const runs = await launched.page.evaluate((id) => (window as unknown as { api: RendererApi }).api.agent.listRuns(id), seed.conversationId)
      expect(runs.at(-1)).toMatchObject({ status: expect.stringMatching(/failed|cancelled/) as unknown as string })
      expect(await launched.page.evaluate(() => (window as unknown as { api: RendererApi }).api.agent.pendingPermissions())).toEqual([])
      await expect(launched.page.locator('#composer-input')).toBeEnabled()
    } finally {
      await closeApp(launched.app).catch(() => undefined)
      await stub.close()
      tidy(repo)
      tidy(seed.userData)
    }
  })
})

test.describe.serial('agent: restart', () => {
  test('workspace grants survive a restart; runs are remembered; no command or prompt is left behind', async () => {
    const stub = await startStubModel()
    const repo = tempDir('aiw-e2e-agent-repo2-')
    createFailingTestRepo(repo)
    const seed = seedAgentUserData(stub.url, repo)
    let launched = await launchApp(seed.userData, { size: { width: 1440, height: 900 } })
    try {
      await launched.page.locator('.mode-chip__trigger').click()
      await launched.page.getByRole('menuitemradio', { name: /^build/ }).click()
      stub.setScript([
        call('filesystem_read', { path: 'src/math.js' }),
        call('filesystem_patch', { path: 'src/math.js', old_string: 'a - b', new_string: 'a + b' }),
        { text: 'Patched.' },
      ])
      await launched.page.locator('#composer-input').fill('Fix add().')
      await launched.page.locator('#composer-input').press('Enter')
      await launched.page.locator('.permission').getByRole('button', { name: '[allow workspace]', exact: true }).click()
      await expect(launched.page.locator('.run-report')).toBeVisible({ timeout: 60_000 })
      await closeApp(launched.app)

      launched = await launchApp(seed.userData, { size: { width: 1440, height: 900 } })
      // The finished run is back in the thread...
      await expect(launched.page.locator('.agent-block')).toHaveCount(1)
      await expect(launched.page.locator('.run-report')).toContainText('src/math.js')
      // ...and the workspace grant still applies: a second patch needs no prompt.
      await launched.page.locator('.mode-chip__trigger').click()
      await launched.page.getByRole('menuitemradio', { name: /^build/ }).click()
      stub.setScript([
        call('filesystem_read', { path: 'src/math.js' }),
        call('filesystem_patch', { path: 'src/math.js', old_string: 'exports.mul', new_string: '// product\nexports.mul' }),
        { text: 'Commented.' },
      ])
      await launched.page.locator('#composer-input').fill('Comment mul().')
      await launched.page.locator('#composer-input').press('Enter')
      await expect(launched.page.locator('.run-report')).toHaveCount(2, { timeout: 60_000 })
      expect(await launched.page.locator('.permission').count()).toBe(0)
      expect(readFileSync(join(repo, 'src', 'math.js'), 'utf8')).toContain('// product')
      const runs = await launched.page.evaluate((id) => (window as unknown as { api: RendererApi }).api.agent.listRuns(id), seed.conversationId)
      expect(runs[1]?.toolRuns.at(-1)).toMatchObject({ toolId: 'filesystem.patch', decisionSource: 'workspace-grant' })
    } finally {
      await closeApp(launched.app)
      await stub.close()
      tidy(repo)
      tidy(seed.userData)
    }
  })
})
