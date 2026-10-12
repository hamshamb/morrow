/// <reference lib="dom" />
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { IS_WINDOWS, closeApp, createProjectRepo, launchApp, seedUserData, tempDir } from './helpers'

/**
 * Screenshot QA from the REAL app against a throwaway repository with staged /
 * unstaged / untracked changes. Skipped unless QA_SCREENSHOTS_DIR is set:
 *
 *   QA_SCREENSHOTS_DIR=C:/path/to/out pnpm --filter @ai-workspace/desktop exec playwright test -c e2e/playwright.config.ts qa-screenshots
 */
const OUT = process.env['QA_SCREENSHOTS_DIR']

const VARIANTS = [
  { key: 'hd-dark', width: 1920, height: 1080, theme: 'dark' as const },
  { key: 'small-dark', width: 1280, height: 720, theme: 'dark' as const },
  { key: 'hd-light', width: 1920, height: 1080, theme: 'light' as const },
]

async function discardAndClose(app: ElectronApplication): Promise<void> {
  // Edited-but-unsaved files make quitting ask; answer "discard" so the run never blocks.
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 1) as unknown as typeof dialog.showMessageBoxSync
    })
    .catch(() => undefined)
  await closeApp(app)
}

for (const variant of VARIANTS) {
  test.describe(`screenshots ${variant.key}`, () => {
    test.skip(!OUT, 'set QA_SCREENSHOTS_DIR to capture screenshots')

    let repo: string
    let plain: string
    let userData: string

    test.beforeAll(() => {
      mkdirSync(OUT as string, { recursive: true })
      repo = tempDir('aiw-qa-repo-')
      createProjectRepo(repo, { withChanges: true })
      plain = tempDir('aiw-qa-plain-')
      writeFileSync(join(plain, 'notes.txt'), 'scratch notes\n')
      const seed = seedUserData(
        [
          { name: 'Personal Website', root: repo },
          { name: 'API Refactor' },
          { name: 'Notes', root: plain },
        ],
        {
          theme: variant.theme,
          codeSessions: {},
        },
      )
      userData = seed.userData
    })

    test.afterAll(() => {
      rmSync(repo, { recursive: true, force: true })
      rmSync(plain, { recursive: true, force: true })
      rmSync(userData, { recursive: true, force: true })
    })

    const shot = async (page: Page, name: string): Promise<void> => {
      await page.waitForTimeout(700)
      await page.screenshot({ path: join(OUT as string, `${name}-${variant.key}.png`) })
    }

    test('code, quick open, search, terminal, changes, diff, commit box', async () => {
      const { app, page } = await launchApp(userData, { size: { width: variant.width, height: variant.height } })
      try {
        // Open three files through the real UI so tabs exist; make one dirty.
        await page.getByRole('button', { name: '/code' }).click()
        await page.locator('[data-path="src"]').click()
        await page.locator('[data-path="src/lib"]').click()
        for (const path of ['src/components/Nav.tsx', 'README.md', 'src/lib/session.ts']) {
          if (path.startsWith('src/components')) await page.locator('[data-path="src/components"]').click()
          await page.locator(`[data-path="${path}"]`).click()
          await expect(page.locator('.editor-tab.is-active')).toContainText(path.split('/').pop() as string)
        }
        const editor = page.locator('.monaco-editor .view-lines').first()
        await editor.click()
        await page.keyboard.press('Control+Home')
        await page.keyboard.type('// TODO: tighten the expiry check\n')
        await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(1)
        await shot(page, 'code-tabs')

        await page.keyboard.press('Control+p')
        await expect(page.locator('[data-quick-open] input')).toBeFocused()
        await page.keyboard.type('side')
        await shot(page, 'quick-open-partial')
        await page.keyboard.press('Control+a')
        await page.keyboard.type('sess')
        await shot(page, 'quick-open')
        await page.keyboard.press('Escape')

        await page.keyboard.press('Control+Shift+f')
        await expect(page.locator('.search-panel__input')).toBeFocused()
        await page.keyboard.type('isExpired')
        await expect(page.locator('.search-hit').first()).toBeVisible()
        await shot(page, 'text-search')

        await page.keyboard.press('Control+`')
        await expect(page.locator('.xterm')).toBeVisible()
        await expect(page.locator('.xterm-rows')).toContainText(/PS |>|\$/, { timeout: 30_000 })
        await page.locator('.xterm').click()
        await page.keyboard.type('git status -s')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(800)
        await page.keyboard.type(IS_WINDOWS ? 'Get-ChildItem -Name' : 'ls')
        await page.keyboard.press('Enter')
        await page.waitForTimeout(1200)
        await shot(page, 'terminal')
        await page.keyboard.press('Control+`') // hide the panel for the full-width views

        await page.getByRole('button', { name: '/git' }).click()
        await expect(page.locator('.change-row').first()).toBeVisible()
        await shot(page, 'git-status')

        await page.locator('.change-row__main', { hasText: 'greet.js' }).click()
        await expect(page.locator('.diff-viewer .monaco-diff-editor')).toBeVisible()
        await page.waitForTimeout(800)
        await shot(page, 'diff-side-by-side')
        await page.getByRole('button', { name: 'inline' }).click()
        await shot(page, 'diff-inline')

        await page.locator('.change-row__main', { hasText: 'format.ts' }).click()
        await page.waitForTimeout(800)
        await shot(page, 'diff-untracked')

        await page.getByRole('button', { name: 'stage README.md' }).click()
        await expect(page.getByRole('region', { name: 'staged' }).locator('.change-row', { hasText: 'README.md' })).toBeVisible()
        await page.locator('#commit-message').fill('docs: explain how to greet someone\n\nAdds the `npm start -- Ada` example to the README.')
        await shot(page, 'commit-box')

        // Terminal + changes together (panel open on the changes page).
        await page.keyboard.press('Control+`')
        await page.waitForTimeout(500)
        await shot(page, 'git-with-terminal')
      } finally {
        await discardAndClose(app)
      }
    })

    test('empty states: no folder, not a repository', async () => {
      const { app, page } = await launchApp(userData, { size: { width: variant.width, height: variant.height } })
      try {
        await page.locator('.rail__tile', { hasText: /^AR$/ }).click() // API Refactor: no folder
        await expect(page.locator('.topbar__title')).toHaveText('API Refactor')
        await page.getByRole('button', { name: '/code' }).click()
        await expect(page.locator('.workspace-view__page:not([hidden])').getByText('No folder chosen for this workspace')).toBeVisible()
        await shot(page, 'empty-no-folder-code')
        await page.getByRole('button', { name: '/git' }).click()
        await shot(page, 'empty-no-folder-git')
        await page.keyboard.press('Control+`')
        await expect(page.locator('.terminal-stack__empty')).toBeVisible()
        await shot(page, 'empty-no-folder-terminal')
        await page.keyboard.press('Control+`')

        await page.locator('.rail__tile', { hasText: /^NO$/ }).click() // Notes: a plain folder
        await expect(page.locator('.topbar__title')).toHaveText('Notes')
        await page.getByRole('button', { name: '/git' }).click()
        await expect(page.getByText('This folder is not a git repository')).toBeVisible()
        await shot(page, 'empty-not-a-repo')
      } finally {
        await closeApp(app)
      }
    })

    test('git binary missing', async () => {
      test.skip(!IS_WINDOWS, 'PATH stripping is Windows-specific')
      const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
      const bare = `${systemRoot}\\System32;${systemRoot}`
      const { app, page } = await launchApp(userData, { size: { width: variant.width, height: variant.height }, env: { PATH: bare, Path: bare } })
      try {
        await page.locator('.rail__tile', { hasText: /^PW$/ }).click()
        await expect(page.locator('.topbar__title')).toHaveText('Personal Website')
        await page.getByRole('button', { name: '/git' }).click()
        await expect(page.getByText('Git not found')).toBeVisible()
        await shot(page, 'empty-git-not-found')
      } finally {
        await closeApp(app)
      }
    })
  })
}
