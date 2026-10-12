/// <reference lib="dom" />
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp, createFailingTestRepo, launchApp, seedAgentUserData, tempDir } from './helpers'
import { call, startStubModel, type StubModel } from './stub-model'

/**
 * Phase 5 screenshot QA from the REAL app (real main process, preload, permission engine, a scripted OpenAI-compatible
 * model). Skipped unless QA_SCREENSHOTS_DIR is set:
 *
 *   QA_SCREENSHOTS_DIR=C:/path/out pnpm --filter @ai-workspace/desktop exec playwright test -c e2e/playwright.config.ts qa-agent
 *
 * Frames are taken with `webContents.invalidate()` followed by `capturePage()` (a window that is not repainting returns a
 * stale frame), then looked at one by one.
 */
const OUT = process.env['QA_SCREENSHOTS_DIR']

const VARIANTS = [
  { key: 'hd-dark', width: 1920, height: 1080, theme: 'dark' as const },
  { key: 'small-dark', width: 1280, height: 720, theme: 'dark' as const },
  { key: 'hd-light', width: 1920, height: 1080, theme: 'light' as const },
]

async function capture(app: ElectronApplication, file: string): Promise<void> {
  const base64 = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return ''
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 450))
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 150))
    return (await win.webContents.capturePage()).toPNG().toString('base64')
  })
  writeFileSync(file, Buffer.from(base64, 'base64'))
}

for (const variant of VARIANTS) {
  test.describe.serial(`agent screenshots ${variant.key}`, () => {
    test.skip(!OUT, 'set QA_SCREENSHOTS_DIR to capture screenshots')
    test.setTimeout(300_000)

    let stub: StubModel
    let app: ElectronApplication
    let page: Page
    let repo: string
    let userData: string
    let seed: ReturnType<typeof seedAgentUserData>

    const shot = async (name: string): Promise<void> => {
      await page.waitForTimeout(500)
      await capture(app, join(OUT as string, `${name}-${variant.key}.png`))
    }
    const setMode = async (mode: string): Promise<void> => {
      await page.locator('.mode-chip__trigger').click()
      await page.getByRole('menuitemradio', { name: new RegExp(`^${mode}`) }).click()
    }
    const ask = async (text: string): Promise<void> => {
      await page.locator('#composer-input').fill(text)
      await page.locator('#composer-input').press('Enter')
    }
    const answer = (label: string) => page.locator('.permission').getByRole('button', { name: label, exact: true }).click()

    test.beforeAll(async () => {
      mkdirSync(OUT as string, { recursive: true })
      stub = await startStubModel()
      repo = tempDir('aiw-qa-agent-repo-')
      createFailingTestRepo(repo)
      seed = seedAgentUserData(stub.url, repo, { theme: variant.theme })
      userData = seed.userData
      ;({ app, page } = await launchApp(userData, { size: { width: variant.width, height: variant.height } }))
      await page.waitForTimeout(800)
    })

    test.afterAll(async () => {
      if (app) await closeApp(app)
      await stub?.close()
      try {
        rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        /* temp dir cleanup is best effort */
      }
    })

    test('plan run in progress: compact activity rows, a pending step', async () => {
      await setMode('plan')
      await shot('00-composer-plan')
      stub.setScript([
        call('filesystem_list', {}, 'I will start by looking at how the project is laid out.'),
        call('filesystem_read', { path: 'package.json' }),
        call('filesystem_search', { query: 'add' }, 'Looking for where add() is defined and used.'),
        call('filesystem_read', { path: 'src/math.js' }),
        call('git_status', {}),
        { text: '1. Fix `add()` in `src/math.js` (it subtracts).\n2. Run `node --test`.\n\nRemaining concerns: none.', delayMs: 9000 },
      ])
      await ask('Plan how to fix the failing test.')
      await expect(page.locator('.agent-row[data-tool-id="git.status"]')).toBeVisible({ timeout: 30_000 })
      await shot('01-plan-in-progress')
      await expect(page.locator('.run-report')).toBeVisible({ timeout: 60_000 })
      await shot('02-plan-finished')
    })

    test('build run: execution prompt, patch prompt with the diff, the run report', async () => {
      await setMode('build')
      stub.setScript([
        call('filesystem_read', { path: 'math.test.js' }, 'Let me read the test and the module.'),
        call('filesystem_read', { path: 'src/math.js' }),
        call('terminal_execute', { command: 'node --test' }, 'Running the tests to see how they fail.'),
        call('filesystem_patch', { path: 'src/math.js', old_string: 'exports.add = (a, b) => a - b', new_string: 'exports.add = (a, b) => a + b' }, 'add() subtracts instead of adding. Patching it.'),
        call('terminal_execute', { command: 'node --test' }),
        { text: 'The bug was in `add()` in `src/math.js`: it subtracted its second argument. I changed it to add, and the test suite now passes.\n\nRemaining concerns: none.' },
      ])
      await ask('Find why this test is failing and fix it.')
      await expect(page.locator('.permission')).toBeVisible({ timeout: 30_000 })
      await shot('03-prompt-execution')
      await answer('[allow once]')
      await expect(page.locator('.permission .agent-diff')).toBeVisible({ timeout: 30_000 })
      await shot('04-prompt-patch-diff')
      await answer('[allow workspace]')
      await expect(page.locator('.permission__command')).toBeVisible({ timeout: 30_000 })
      await answer('[allow session]')
      await expect(page.locator('.run-report')).toHaveCount(2, { timeout: 60_000 })
      await page.locator('.agent-row[data-tool-id="filesystem.patch"] .agent-row__line').last().click()
      await page.locator('.agent-row[data-tool-id="terminal.execute"] .agent-row__line').last().click()
      await shot('05-run-report')
    })

    test('changes panel with the diff', async () => {
      await page.getByRole('button', { name: /^\[changes 1\]$/ }).click()
      const panel = page.locator('.changes-panel')
      await panel.locator('.changes-file__main').first().click()
      await expect(panel.locator('.monaco-diff-editor')).toBeVisible({ timeout: 30_000 })
      await shot('06-changes-diff')
      await panel.getByRole('button', { name: '[close]' }).click()
    })

    test('destructive prompt', async () => {
      stub.setScript([
        call('terminal_execute', { command: 'rm src/math.js' }, 'I will delete the file and start over.'),
        { text: 'I left src/math.js alone.\n\nRemaining concerns: none.' },
      ])
      await ask('Delete src/math.js and rewrite it.')
      await expect(page.locator('.permission--destructive')).toBeVisible({ timeout: 30_000 })
      await shot('07-prompt-destructive')
      await answer('[deny]')
      await expect(page.locator('.run-report')).toHaveCount(3, { timeout: 60_000 })
      await shot('08-denied-report')
    })

    test('a running command: live output in the row and in the bottom panel', async () => {
      stub.setScript([
        call('terminal_execute', { command: `node -e "for (let i = 1; i <= 6; i++) console.log('building step ' + i + ' of 6 ... ok'); setTimeout(() => {}, 30000)"` }, 'Starting the build.'),
        { text: 'stopped' },
      ])
      await ask('Run the build.')
      await expect(page.locator('.permission')).toBeVisible({ timeout: 30_000 })
      await answer('[allow once]')
      await expect(page.locator('.agent-row[data-status="running"] .agent-output')).toContainText('building step 6 of 6', { timeout: 30_000 })
      await shot('09-live-command-output')
      // The bottom panel's agent tab (Ctrl+` opens the panel; a shell starts only because that is the explicit request).
      await page.keyboard.press('Control+Backquote')
      await page.locator('.bottom-panel').getByRole('tab', { name: /^agent/ }).click()
      await expect(page.locator('.agent-output-entry').last()).toBeVisible()
      await shot('10-bottom-panel-agent-output')
      await page.locator('.bottom-panel').getByRole('button', { name: /\[hide\]/ }).click()
      await page.locator('.agent-block--live').getByRole('button', { name: '[stop ■]' }).click()
      await expect(page.locator('.run-report')).toHaveCount(4, { timeout: 60_000 })
    })

    test('settings: permissions and agents', async () => {
      await page.getByRole('button', { name: '[settings]' }).click()
      await page.getByRole('button', { name: 'permissions', exact: true }).click()
      await expect(page.locator('.permission-grant')).toHaveCount(2)
      await shot('11-settings-permissions')
      await page.getByRole('button', { name: 'agents', exact: true }).click()
      await page.locator('.agent-def__head', { hasText: 'Implementer' }).click()
      await page.locator('.settings__content').evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await shot('12-settings-agents')
      await page.keyboard.press('Escape')
    })

    test('a model without tool support: plan/build are disabled with the reason', async () => {
      // Build is still selected; switch the composer to a model whose models.dev entry says tool_call: false.
      await page.locator('.model-selector__trigger').click()
      await page.locator('.model-picker__search').fill('allam')
      await page.getByRole('option', { name: /allam/i }).first().click()
      await expect(page.locator('.mode-row__problem')).toContainText('no tool support')
      await shot('13-no-tool-support-composer')
      await page.locator('.mode-chip__trigger').click()
      await expect(page.getByRole('menuitemradio', { name: /^build/ })).toHaveAttribute('aria-disabled', 'true')
      await shot('14-no-tool-support-menu')
      await page.keyboard.press('Escape')
    })
  })
}
