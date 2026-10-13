/// <reference lib="dom" />
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import type { RendererApi } from '@ai-workspace/shared'
import { APP_DIR, closeApp, createFailingTestRepo, launchApp, processAlive, seedAgentUserData, tempDir } from './helpers'
import { call, startStubModel, type StubModel } from './stub-model'

/**
 * Phase 7 acceptance in the REAL built app: a real MCP server (the SDK-built fixture, a child process on stdio) is
 * added in Settings -> MCP, tested, and a Build-mode run driven by the scripted model calls its tool through the same
 * permission prompt, executor and audit log as every other tool.
 */

export const FIXTURE = join(APP_DIR, 'src', 'main', '__tests__', 'fixtures', 'mcp-echo-server.mjs')

function tidy(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
  } catch {
    /* left for the OS temp cleaner */
  }
}

test.describe.serial('MCP: configure, test, call through the permission engine', () => {
  let stub: StubModel
  let app: ElectronApplication
  let page: Page
  let stderr: string[] = []
  let repo: string
  let seed: ReturnType<typeof seedAgentUserData>
  let serverPid = 0
  const problems: string[] = []

  const composer = (): Locator => page.locator('#composer-input')
  const prompt = (): Locator => page.locator('.permission')
  const row = (toolId: string): Locator => page.locator(`.agent-row[data-tool-id="${toolId}"]`)
  const mcpList = () => page.evaluate(() => (window as unknown as { api: RendererApi }).api.mcp.list())

  async function setMode(mode: 'plan' | 'build'): Promise<void> {
    await page.locator('.mode-chip__trigger').click()
    await page.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click()
    await expect(page.locator('.mode-chip__trigger')).toContainText(mode)
  }
  async function ask(text: string): Promise<void> {
    await composer().fill(text)
    await composer().press('Enter')
  }
  const answer = (label: string): Promise<void> => prompt().getByRole('button', { name: label, exact: true }).click()
  const openSettings = async (section: string): Promise<void> => {
    await page.getByRole('button', { name: '[settings]' }).click()
    await page.getByRole('button', { name: section, exact: true }).click()
  }

  test.beforeAll(async () => {
    stub = await startStubModel()
    repo = tempDir('aiw-e2e-mcp-repo-')
    createFailingTestRepo(repo)
    seed = seedAgentUserData(stub.url, repo)
    ;({ app, page, stderr } = await launchApp(seed.userData, { size: { width: 1440, height: 900 } }))
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console.${m.type()}: ${m.text()}`)
    })
  })

  test.afterAll(async () => {
    if (app) await closeApp(app)
    await stub?.close()
    tidy(repo)
    tidy(seed.userData)
  })

  test('1. Settings -> MCP: empty state, add the fixture server (with a secret variable), [test] connects and lists its tools', async () => {
    await openSettings('mcp')
    const panel = page.locator('.settings__content')
    await expect(panel.locator('.mcp-empty')).toContainText('no servers')
    await expect(panel).toContainText('a stdio server runs with your user account')

    await panel.getByRole('button', { name: '[+ add server]' }).click()
    await page.getByLabel('Server name').fill('fixture')
    await page.getByLabel('Command', { exact: true }).fill(process.execPath)
    await page.getByLabel('Arguments').fill(FIXTURE)
    await page.getByRole('button', { name: '[+ variable]' }).click()
    await page.getByLabel('Variable name', { exact: true }).fill('FIXTURE_TOKEN')
    await page.getByLabel('Variable name value').fill('super-secret-token-value-123456')
    await page.getByRole('checkbox', { name: 'secret' }).check()
    await expect(page.getByLabel('Variable name value')).toHaveAttribute('type', 'password')
    await page.getByRole('button', { name: '[save]' }).click()

    const server = panel.locator('.mcp-server[data-server="fixture"]')
    await expect(server).toBeVisible()
    await expect(server.locator('.mcp-status')).toHaveText('not connected')
    // Saving started nothing.
    expect((await mcpList())[0]?.diagnostics.pid).toBeNull()

    await server.getByRole('button', { name: '[test]' }).click()
    await expect(server.locator('.mcp-status')).toHaveText('connected', { timeout: 30_000 })
    const diag = panel.locator('.mcp-diag')
    await expect(diag).toContainText('Fixture server 9.9.9')
    await expect(diag).toContainText('stdio')
    await expect(diag.locator('.mcp-diag__stderr')).toContainText('fixture: ready')
    await expect(diag.locator('.mcp-tool')).toHaveCount(await diag.locator('.mcp-tool').count())
    const tools = diag.locator('.mcp-tool')
    await expect(tools.filter({ hasText: 'echo' }).first()).toBeVisible()
    await expect(tools.filter({ hasText: 'wipe' })).toContainText('says destructive')
    await expect(tools.filter({ hasText: 'liar' })).toContainText('says read-only')
    expect(await tools.count()).toBeGreaterThanOrEqual(14)

    // Per-tool switch: turn `liar` off.
    const liar = tools.filter({ has: page.locator('.mcp-tool__name', { hasText: /^liar$/ }) })
    await liar.getByRole('switch').click()
    await expect(liar.getByRole('switch')).toHaveAttribute('aria-checked', 'false')

    // The renderer never received the secret, and the process exists.
    const states = await mcpList()
    expect(JSON.stringify(states)).not.toContain('super-secret-token-value-123456')
    serverPid = states[0]?.diagnostics.pid ?? 0
    expect(serverPid).toBeGreaterThan(0)
    expect(processAlive(serverPid)).toBe(true)
    expect(states[0]?.config.env).toEqual([{ key: 'FIXTURE_TOKEN', value: null, secret: true }])

    await page.keyboard.press('Escape')
    await expect(page.locator('.overlay')).toHaveCount(0)
  })

  test('2. Build mode: the model calls mcp__fixture__echo - the mcp prompt, allow once, the result reaches the activity row and the model', async () => {
    await setMode('build')
    stub.setScript([
      call('mcp__fixture__echo', { text: 'from the model' }, 'I will use the echo tool.'),
      { text: 'The tool answered with the echoed text.\n\nRemaining concerns: none.' },
    ])
    await ask('Use the echo tool.')

    await expect(prompt()).toBeVisible()
    await expect(prompt().locator('.permission__heading')).toContainText('AGENT REQUESTS · mcp fixture/echo (execution)')
    await expect(prompt().locator('.permission__path-name')).toHaveText('fixture/echo')
    await expect(prompt().locator('.permission__mcp-description')).toContainText('Returns the text it was given.')
    await expect(prompt().locator('pre.permission__command')).toContainText('"text": "from the model"')
    await expect(prompt()).toContainText('the server says: read-only')
    await expect(prompt().getByRole('button')).toHaveText(['[allow once]', '[allow session]', '[allow workspace]', '[deny]'])
    // Nothing has been called yet.
    await expect(row('mcp.call')).toHaveAttribute('data-status', 'pending')
    await answer('[allow once]')

    await expect(row('mcp.call')).toHaveAttribute('data-status', 'ok', { timeout: 30_000 })
    await expect(row('mcp.call')).toContainText('fixture/echo')
    await row('mcp.call').locator('.agent-row__line').click()
    await expect(row('mcp.call').locator('.agent-output')).toHaveText('echo: from the model')
    await expect(page.locator('.run-report')).toBeVisible({ timeout: 60_000 })
    await expect(page.locator('.run-report .run-report__section', { hasText: 'mcp calls' })).toContainText('fixture/echo')
    await expect(page.locator('.assistant-message').last()).toContainText('The tool answered')

    // --- what the model was given and was sent back
    const offered = stub.requests[0]!.tools?.map((t) => t.function.name) ?? []
    expect(offered).toEqual(expect.arrayContaining(['filesystem_read', 'terminal_execute', 'mcp__fixture__echo', 'mcp__fixture__wipe']))
    expect(offered).not.toContain('mcp__fixture__liar') // switched off in Settings
    expect(JSON.stringify(stub.requests[1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content)).toContain('echo: from the model')

    // --- the audit trail: the same shape as any other tool
    const list = await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.agent.listRuns(id), seed.conversationId)
    expect(list).toHaveLength(1)
    expect(list[0]?.toolRuns.map((t) => [t.toolId, t.label, t.status, t.decisionSource, t.risk])).toEqual([['mcp.call', 'mcp fixture/echo', 'ok', 'prompt-once', 'execution']])
  })

  test('3. a tool the server calls destructive asks every time and can only be allowed once; denying calls nothing', async () => {
    stub.setScript([call('mcp__fixture__wipe', { target: 'everything' }, 'Cleaning up.'), { text: 'I did not wipe anything.\n\nRemaining concerns: none.' }])
    await ask('Wipe it.')
    await expect(prompt()).toBeVisible()
    await expect(prompt()).toHaveClass(/permission--destructive/)
    await expect(prompt().locator('.permission__heading')).toContainText('AGENT REQUESTS · mcp fixture/wipe (destructive)')
    await expect(prompt()).toContainText('the server says: destructive')
    await expect(prompt().getByRole('button')).toHaveText(['[allow once]', '[deny]'])
    await prompt().focus()
    await page.keyboard.press('w')
    await page.keyboard.press('s')
    await expect(prompt()).toBeVisible()
    await page.keyboard.press('d')
    await expect(page.locator('.run-report').last()).toContainText('denied by you', { timeout: 60_000 })
    await expect(row('mcp.call').last()).toHaveAttribute('data-status', 'denied')
    expect(JSON.stringify(stub.requests[1]!.messages.filter((m) => m.role === 'tool').at(-1)!.content)).toContain('DENIED')
  })

  test('4. an allow-for-workspace grant covers that exact server/tool and shows in Settings -> Permissions', async () => {
    stub.setScript([call('mcp__fixture__echo', { text: 'second' }), { text: 'done' }])
    await ask('Echo again.')
    await expect(prompt()).toBeVisible()
    await answer('[allow workspace]')
    await expect(page.locator('.run-report')).toHaveCount(3, { timeout: 60_000 })

    // A different tool of the same server still asks; the granted one does not.
    stub.setScript([call('mcp__fixture__echo', { text: 'third' }), call('mcp__fixture__add', { a: 2, b: 3 }), { text: 'done' }])
    await ask('Echo and add.')
    await expect(prompt().locator('.permission__path-name')).toHaveText('fixture/add')
    await answer('[deny]')
    await expect(page.locator('.run-report')).toHaveCount(4, { timeout: 60_000 })

    await openSettings('permissions')
    const grants = page.locator('.permission-grant')
    await expect(grants).toHaveCount(1)
    await expect(grants).toContainText('mcp')
    await expect(grants).toContainText('fixture/echo')
    await expect(grants).toContainText('workspace')
    await page.keyboard.press('Escape')
  })

  test('5. Plan mode gets no MCP tool', async () => {
    await setMode('plan')
    stub.setScript([{ text: 'A plan, without tools from servers.' }])
    await ask('Plan something.')
    await expect(page.locator('.assistant-message').last()).toContainText('A plan, without tools')
    const names = stub.requests[0]!.tools?.map((t) => t.function.name) ?? []
    expect(names.length).toBeGreaterThan(0)
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false)
    await setMode('build')
  })

  test('6. composer: "MCP resource…" lists the server\'s resources and attaches text; binary is refused with a reason', async () => {
    await page.getByRole('button', { name: '+', exact: true }).click()
    await page.getByRole('button', { name: 'MCP resource…' }).click()
    const picker = page.locator('.mcp-picker')
    await expect(picker).toBeVisible()
    await picker.getByRole('radio', { name: /fixture/ }).click()
    await expect(picker.locator('.mcp-resource')).toHaveCount(4, { timeout: 30_000 })
    await picker.locator('.mcp-resource', { hasText: 'Readme' }).getByRole('checkbox').check()
    await picker.locator('.mcp-resource', { hasText: 'todo' }).getByRole('checkbox').check()
    await picker.getByRole('button', { name: '[attach 2]' }).click()
    await expect(picker).toHaveCount(0)
    const attachments = page.locator('.composer__attachments')
    await expect(attachments).toContainText('readme.md')
    await expect(attachments).toContainText('todo.txt')

    await page.getByRole('button', { name: '+', exact: true }).click()
    await page.getByRole('button', { name: 'MCP resource…' }).click()
    await page.locator('.mcp-picker').getByRole('radio', { name: /fixture/ }).click()
    await page.locator('.mcp-picker .mcp-resource', { hasText: 'logo' }).getByRole('checkbox').check()
    await page.locator('.mcp-picker').getByRole('button', { name: '[attach 1]' }).click()
    await expect(page.locator('.composer__note.signal')).toContainText('binary content')
    // Remove the pending attachments so they do not leak into later tests.
    for (const name of ['readme.md', 'todo.txt']) await attachments.locator('.activity-row', { hasText: name }).getByRole('button').first().click()
  })

  test('7. a server that crashes is reconnected on next use; quitting the app kills the server process', async () => {
    const before = (await mcpList())[0]!.diagnostics.pid as number
    stub.setScript([call('mcp__fixture__crash', {}), { ...call('mcp__fixture__echo', { text: 'after the crash' }), delayMs: 1200 }, { text: 'recovered' }])
    await ask('Crash it, then echo.')
    await expect(prompt()).toBeVisible()
    await answer('[allow once]')
    // echo is covered by the workspace grant from test 4, so it runs without asking - on a fresh connection.
    await expect(page.locator('.assistant-message').last()).toContainText('recovered', { timeout: 60_000 })
    const after = (await mcpList())[0]!.diagnostics
    expect(after.status).toBe('connected')
    expect(after.pid).not.toBe(before)
    expect(processAlive(before)).toBe(false)

    serverPid = after.pid as number
    expect(processAlive(serverPid)).toBe(true)
    await closeApp(app)
    await expect.poll(() => processAlive(serverPid), { timeout: 20_000 }).toBe(false)
  })

  test('8. no console errors, and nothing unexpected on the main process\'s stderr', () => {
    expect(problems).toEqual([])
    expect(stderr).toEqual([])
  })
})
