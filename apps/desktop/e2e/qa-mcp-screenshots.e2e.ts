/// <reference lib="dom" />
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import type { RendererApi } from '@ai-workspace/shared'
import { APP_DIR, closeApp, createFailingTestRepo, launchApp, seedAgentUserData, tempDir } from './helpers'
import { call, startStubModel, type StubModel } from './stub-model'

/**
 * Phase 7 screenshot QA from the REAL app (real main process, preload, a real MCP server child process, the permission
 * engine, a scripted OpenAI-compatible model). Skipped unless QA_SCREENSHOTS_DIR is set:
 *
 *   QA_SCREENSHOTS_DIR=C:/path/out pnpm --filter @ai-workspace/desktop exec playwright test -c e2e/playwright.config.ts qa-mcp
 */
const OUT = process.env['QA_SCREENSHOTS_DIR']
const FIXTURE = join(APP_DIR, 'src', 'main', '__tests__', 'fixtures', 'mcp-echo-server.mjs')

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
  test.describe.serial(`mcp screenshots ${variant.key}`, () => {
    test.skip(!OUT, 'set QA_SCREENSHOTS_DIR to capture screenshots')
    test.setTimeout(300_000)

    let stub: StubModel
    let app: ElectronApplication
    let page: Page
    let repo: string
    let seed: ReturnType<typeof seedAgentUserData>

    const shot = async (name: string): Promise<void> => {
      await page.waitForTimeout(500)
      await capture(app, join(OUT as string, `${name}-${variant.key}.png`))
    }
    const panel = () => page.locator('.settings__content')
    const answer = (label: string) => page.locator('.permission').getByRole('button', { name: label, exact: true }).click()
    const ask = async (text: string): Promise<void> => {
      await page.locator('#composer-input').fill(text)
      await page.locator('#composer-input').press('Enter')
    }
    const openSettings = async (section: string): Promise<void> => {
      await page.getByRole('button', { name: '[settings]' }).click()
      await page.getByRole('button', { name: section, exact: true }).click()
    }

    test.beforeAll(async () => {
      mkdirSync(OUT as string, { recursive: true })
      stub = await startStubModel()
      repo = tempDir('aiw-qa-mcp-repo-')
      createFailingTestRepo(repo)
      seed = seedAgentUserData(stub.url, repo, { theme: variant.theme })
      ;({ app, page } = await launchApp(seed.userData, { size: { width: variant.width, height: variant.height } }))
      await page.waitForTimeout(800)
    })

    test.afterAll(async () => {
      if (app) await closeApp(app)
      await stub?.close()
      try {
        rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        rmSync(seed.userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        /* temp dir cleanup is best effort */
      }
    })

    test('empty state and the add forms', async () => {
      await openSettings('mcp')
      await expect(panel().locator('.mcp-empty')).toBeVisible()
      await shot('00-mcp-empty')

      await panel().getByRole('button', { name: '[+ add server]' }).click()
      await page.getByLabel('Server name').fill('fixture')
      await page.getByLabel('Command', { exact: true }).fill('node')
      await page.getByLabel('Arguments').fill(`${FIXTURE}\n--verbose`)
      await page.getByRole('button', { name: '[+ variable]' }).click()
      await page.getByLabel('Variable name', { exact: true }).fill('LOG_LEVEL')
      await page.getByLabel('Variable name value').fill('debug')
      await page.getByRole('button', { name: '[+ variable]' }).click()
      await page.getByLabel('Variable name', { exact: true }).nth(1).fill('API_TOKEN')
      await page.getByLabel('Variable name value').nth(1).fill('secret-token-value-123456')
      await page.getByRole('checkbox', { name: 'secret' }).nth(1).check()
      await shot('01-mcp-form-stdio')

      await page.getByRole('radio', { name: 'http' }).click()
      await page.getByLabel('URL').fill('https://mcp.example.com/mcp')
      await page.getByRole('button', { name: '[+ header]' }).click()
      await page.getByLabel('Header name', { exact: true }).fill('Authorization')
      await page.getByLabel('Header name value').fill('Bearer abcdefghijklmnop')
      await shot('02-mcp-form-http')

      // A form with mistakes shows them in words.
      await page.getByLabel('URL').fill('http://example.com/mcp')
      await page.getByRole('button', { name: '[save]' }).click()
      await expect(page.locator('.mcp-form__problems')).toContainText('localhost')
      await shot('03-mcp-form-problem')

      // Back to the stdio server and save it.
      await page.getByRole('radio', { name: 'stdio' }).click()
      await page.getByRole('button', { name: '[save]' }).click()
      await expect(panel().locator('.mcp-server[data-server="fixture"]')).toBeVisible()
    })

    test('server list with a connected and an errored server, and the diagnostics', async () => {
      // Two more servers, added through the API: one that exits at start (an error with stderr), one disabled http.
      await page.evaluate(
        async (fixture) => {
          const api = (window as unknown as { api: RendererApi }).api
          await api.mcp.save({
            name: 'broken',
            transport: 'stdio',
            command: 'node',
            args: [fixture],
            env: [{ key: 'FIXTURE_EXIT_AT_START', value: '1', secret: false }],
          })
          await api.mcp.save({ name: 'search', transport: 'http', url: 'https://mcp.example.com/mcp', headers: [{ key: 'Authorization', value: 'Bearer abcdefghijklmnop', secret: true }], enabled: false })
        },
        FIXTURE,
      )
      await page.keyboard.press('Escape')
      await openSettings('mcp')
      const fixture = panel().locator('.mcp-server[data-server="fixture"]')
      const broken = panel().locator('.mcp-server[data-server="broken"]')
      await fixture.getByRole('button', { name: '[test]' }).click()
      await expect(fixture.locator('.mcp-status')).toHaveText('connected', { timeout: 30_000 })
      await broken.getByRole('button', { name: '[test]' }).click()
      await expect(broken.locator('.mcp-status')).toHaveText('error', { timeout: 30_000 })
      // [test] opens the diagnostics of the server it tested; collapse them so the list reads as a list
      await broken.locator('.mcp-server__toggle').click()
      await expect(panel().locator('.mcp-diag')).toHaveCount(0)
      await shot('04-mcp-server-list')

      await fixture.locator('.mcp-server__toggle').click()
      await expect(fixture.locator('.mcp-tool').first()).toBeVisible({ timeout: 30_000 })
      await shot('05-mcp-diagnostics-connected')
      await panel().evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await shot('06-mcp-diagnostics-tools')
      await fixture.locator('.mcp-server__toggle').click()

      await broken.locator('.mcp-server__toggle').click()
      await expect(broken.locator('.mcp-diag__error')).toBeVisible()
      await shot('07-mcp-diagnostics-error')
      await page.keyboard.press('Escape')
    })

    test('the mcp permission prompts, the activity row and the report', async () => {
      await page.locator('.mode-chip__trigger').click()
      await page.getByRole('menuitemradio', { name: /^build/ }).click()
      stub.setScript([
        call('mcp__fixture__echo', { text: 'Summarise the release notes for v2.4 and list the breaking changes.' }, 'I will ask the fixture server to echo this back.'),
        call('mcp__fixture__wipe', { target: 'build-cache' }, 'Now cleaning the build cache.'),
        { text: 'The echo tool answered. I did not clean the build cache because that was denied.\n\nRemaining concerns: none.' },
      ])
      await ask('Use the fixture server.')
      await expect(page.locator('.permission')).toBeVisible({ timeout: 30_000 })
      await shot('08-mcp-prompt')
      await answer('[allow workspace]')
      await expect(page.locator('.permission--destructive')).toBeVisible({ timeout: 30_000 })
      await shot('09-mcp-prompt-destructive')
      await answer('[deny]')
      await expect(page.locator('.run-report')).toBeVisible({ timeout: 60_000 })
      await page.locator('.agent-row[data-tool-id="mcp.call"] .agent-row__line').first().click()
      await shot('10-mcp-activity-and-report')
    })

    test('the composer resource picker', async () => {
      await page.getByRole('button', { name: '+', exact: true }).click()
      await page.getByRole('button', { name: 'MCP resource…' }).click()
      const picker = page.locator('.mcp-picker')
      await picker.getByRole('radio', { name: /fixture/ }).click()
      await expect(picker.locator('.mcp-resource')).toHaveCount(4, { timeout: 30_000 })
      await picker.locator('.mcp-resource', { hasText: 'Readme' }).getByRole('checkbox').check()
      await shot('11-mcp-resource-picker')
      await picker.getByRole('button', { name: '[attach 1]' }).click()
      await expect(page.locator('.composer__attachments')).toContainText('readme.md')
      await shot('12-mcp-resource-attached')
    })

    test('permissions list shows the mcp grant', async () => {
      await openSettings('permissions')
      await expect(page.locator('.permission-grant')).toContainText('fixture/echo')
      await shot('13-mcp-permissions')
      await page.keyboard.press('Escape')
    })
  })
}
