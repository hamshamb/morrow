// Screenshot QA against the dev-only mock API (renderer dev server on :5199):
//
//   pnpm --filter @ai-workspace/desktop dev:renderer        # terminal 1
//   node e2e/qa/qa-mock.mjs <outDir> [scenario ...]         # terminal 2
//
// Drives a real Chromium (Electron) window with Playwright. Scenarios are named
// below; with none given, all run. PNGs are written to <outDir>.
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from '@playwright/test'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const electronPath = require('electron')
const outDir = resolve(process.argv[2] ?? join(here, '..', '..', '..', '..', 'qa-out'))
const only = process.argv.slice(3)
mkdirSync(outDir, { recursive: true })

const SIZES = {
  hd: { width: 1920, height: 1080 },
  small: { width: 1280, height: 720 },
}

/** Each scenario: size + theme + a function that drives the page and returns screenshot names. */
const scenarios = {
  'code-tabs': { urlParams: 'tabs=1', run: codeTabs },
  'quick-open': { urlParams: 'tabs=1', run: quickOpen },
  search: { urlParams: 'tabs=1', run: search },
  terminal: { urlParams: 'tabs=1', run: terminal },
  changes: { urlParams: 'tabs=1', run: gitView },
  diff: { urlParams: 'tabs=1', run: diffView },
  commit: { urlParams: 'tabs=1', run: commitBox },
  'empty-no-folder': { urlParams: '', run: noFolder },
  'empty-not-repo': { urlParams: 'repo=none', run: notRepo },
  'empty-vcs-missing': { urlParams: 'repo=missing', run: noGitBinary },
}
const variants = [
  { key: 'hd-dark', size: SIZES.hd, theme: 'dark' },
  { key: 'small-dark', size: SIZES.small, theme: 'dark' },
  { key: 'hd-light', size: SIZES.hd, theme: 'light' },
]

async function settle(page, ms = 900) {
  await page.waitForTimeout(ms)
}

async function openCode(page) {
  await page.getByRole('button', { name: '/code' }).click()
  await page.waitForSelector('.code-view .editor-tab', { timeout: 15000 })
  await page.waitForSelector('.monaco-editor .view-lines', { timeout: 20000 })
  await settle(page, 1200)
}

async function expandTree(page) {
  for (const name of ['src', 'lib', 'auth']) {
    const row = page.locator('.file-tree__row', { hasText: new RegExp(`^\\s*[▸▾]?\\s*${name}$`) }).first()
    if ((await row.count()) > 0) {
      const expanded = await row.getAttribute('aria-expanded')
      if (expanded !== 'true') await row.click()
      await page.waitForTimeout(250)
    }
  }
}

async function codeTabs(page, shot) {
  await openCode(page)
  await expandTree(page)
  // Make the active tab dirty: type at the top of the file.
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.type('// TODO: tighten the expiry check\n')
  await settle(page, 500)
  await shot('code-tabs')
}

async function quickOpen(page, shot) {
  await openCode(page)
  await page.keyboard.press('Control+p')
  await page.waitForSelector('[data-quick-open]')
  await page.keyboard.type('side')
  await settle(page, 500)
  await page.keyboard.press('Control+a')
  await page.keyboard.type('auth sess')
  await settle(page, 400)
  await shot('quick-open')
}

async function search(page, shot) {
  await openCode(page)
  await page.keyboard.press('Control+Shift+f')
  await page.waitForSelector('.search-panel__input')
  await page.keyboard.type('session')
  await page.waitForSelector('.search-hit', { timeout: 5000 })
  await settle(page, 500)
  await shot('text-search')
}

async function terminal(page, shot) {
  await openCode(page)
  await page.keyboard.press('Control+`')
  await page.waitForSelector('.xterm', { timeout: 15000 })
  await settle(page, 900)
  await page.keyboard.type('npm test')
  await page.keyboard.press('Enter')
  await settle(page, 600)
  await page.keyboard.type('ls')
  await page.keyboard.press('Enter')
  await settle(page, 900)
  await shot('terminal')
}

async function gitView(page, shot) {
  await page.getByRole('button', { name: '/git' }).click()
  await page.waitForSelector('.change-row', { timeout: 10000 })
  await settle(page, 600)
  await shot('git-status')
}

async function diffView(page, shot) {
  await page.getByRole('button', { name: '/git' }).click()
  await page.waitForSelector('.change-row', { timeout: 10000 })
  await page.locator('.change-row__main', { hasText: 'refresh-middleware.ts' }).click()
  await page.waitForSelector('.diff-viewer .monaco-diff-editor', { timeout: 20000 })
  await settle(page, 1500)
  await shot('diff-side-by-side')
  await page.getByRole('button', { name: 'inline' }).click()
  await settle(page, 900)
  await shot('diff-inline')
}

async function commitBox(page, shot) {
  await page.getByRole('button', { name: '/git' }).click()
  await page.waitForSelector('.change-row', { timeout: 10000 })
  await page.locator('.change-row__main', { hasText: 'README.md' }).click()
  await page.getByRole('button', { name: /^\[stage\]/ }).first().click().catch(() => undefined)
  await settle(page, 500)
  await page.locator('#commit-message').fill('feat: refresh the session before it expires\n\nAdds a five minute refresh window to the middleware.')
  await settle(page, 700)
  await shot('commit-box')
}

async function noFolder(page, shot) {
  // The second workspace has no folder: switch to it in the rail.
  await page.locator('.rail__tile').nth(1).click()
  await settle(page, 700)
  await page.getByRole('button', { name: '/code' }).click()
  await settle(page, 700)
  await shot('empty-no-folder-code')
  await page.getByRole('button', { name: '/git' }).click()
  await settle(page, 500)
  await shot('empty-no-folder-git')
}

async function notRepo(page, shot) {
  await page.getByRole('button', { name: '/git' }).click()
  await page.waitForSelector('.empty-state', { timeout: 10000 })
  await settle(page, 500)
  await shot('empty-not-repo')
}

async function noGitBinary(page, shot) {
  await page.getByRole('button', { name: '/git' }).click()
  await page.waitForSelector('.empty-state', { timeout: 10000 })
  await settle(page, 500)
  await shot('empty-vcs-missing')
}

const names = only.length > 0 ? only : Object.keys(scenarios)
const failures = []
for (const name of names) {
  const scenario = scenarios[name]
  if (!scenario) {
    console.error(`unknown scenario ${name}`)
    process.exitCode = 1
    continue
  }
  for (const variant of variants) {
    // The empty states and a couple of dense views are only needed in one or two variants.
    const app = await electron.launch({
      executablePath: electronPath,
      args: [join(here, 'mock-main.cjs')],
      env: {
        ...process.env,
        QA_WIDTH: String(variant.size.width),
        QA_HEIGHT: String(variant.size.height),
        QA_URL: `http://127.0.0.1:5199/?theme=${variant.theme}${scenario.urlParams ? `&${scenario.urlParams}` : ''}`,
      },
    })
    try {
      const page = await app.firstWindow()
      const errors = []
      page.on('pageerror', (e) => errors.push(String(e)))
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      await page.waitForSelector('.topbar', { timeout: 30000 })
      await settle(page, 600)
      await scenario.run(page, async (label) => {
        const file = join(outDir, `${label}-${variant.key}.png`)
        await page.screenshot({ path: file })
        console.log('wrote', file)
      })
      if (errors.length > 0) console.warn(`[${name}/${variant.key}] console errors:\n  ${errors.slice(0, 5).join('\n  ')}`)
    } catch (err) {
      failures.push(`${name}/${variant.key}: ${err.message}`)
      console.error(`FAILED ${name}/${variant.key}: ${err.message}`)
    } finally {
      await app.close().catch(() => undefined)
    }
  }
}
if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s)`)
  process.exitCode = 1
}
