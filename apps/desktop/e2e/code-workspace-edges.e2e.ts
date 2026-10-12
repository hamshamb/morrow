/// <reference lib="dom" />
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { RendererApi } from '@ai-workspace/shared'
import { IS_WINDOWS, closeApp, createProjectRepo, launchApp, seedUserData, tempDir } from './helpers'

/**
 * Edge states and the security boundary, exercised through the real preload
 * bridge (window.api) of the production build.
 */

test.describe('IPC boundary - path safety through the real app', () => {
  test('absolute paths, traversal, secrets and writes outside the root are refused', async () => {
    const repo = tempDir('aiw-e2e-edge-repo-')
    const outside = tempDir('aiw-e2e-edge-outside-')
    createProjectRepo(repo)
    writeFileSync(join(repo, '.env'), 'API_KEY=hunter2\n')
    writeFileSync(join(outside, 'secret.txt'), 'top secret')
    const seed = seedUserData([{ name: 'edge', root: repo }])
    const workspaceId = seed.workspaceIds[0] as string
    const { app, page } = await launchApp(seed.userData)
    try {
      const result = await page.evaluate(
        async ([id, absolute]) => {
          const api = (window as unknown as { api: RendererApi }).api
          const attempt = async (fn: () => Promise<unknown>): Promise<string> => {
            try {
              const value = await fn()
              return `ok:${JSON.stringify(value).slice(0, 80)}`
            } catch (err) {
              return `rejected:${err instanceof Error ? err.message : String(err)}`
            }
          }
          return {
            absolute: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: absolute as string })),
            traversal: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: '../aiw-e2e-edge-outside/secret.txt' })),
            env: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: '.env' })),
            gitDir: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: '.git/config' })),
            writeOutside: await attempt(() => api.fs.writeFile({ workspaceId: id as string, relativePath: '../escape.txt', content: 'x', expectedHash: null })),
            writeEnv: await attempt(() => api.fs.writeFile({ workspaceId: id as string, relativePath: '.env', content: 'x', expectedHash: null })),
            listOutside: await attempt(() => api.fs.listDir({ workspaceId: id as string, relativePath: '..' })),
            stageTraversal: await attempt(() => api.git.stage({ workspaceId: id as string, paths: ['../x'] })),
            badInput: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: 42 as unknown as string })),
            terminalBadSize: await attempt(() => api.terminal.create({ workspaceId: id as string, cols: -1, rows: 24 })),
            normal: await attempt(() => api.fs.readFile({ workspaceId: id as string, relativePath: 'README.md' })),
          }
        },
        [workspaceId, join(outside, 'secret.txt')],
      )
      expect(result.absolute).toMatch(/^rejected:.*Absolute paths are not allowed/)
      expect(result.traversal).toMatch(/^rejected:.*traversal/i)
      expect(result.env).toMatch(/^ok:.*"status":"denied"/)
      expect(result.env).not.toContain('hunter2')
      expect(result.gitDir).toMatch(/^ok:.*"status":"denied"/)
      expect(result.writeOutside).toMatch(/^rejected:/)
      expect(result.writeEnv).toMatch(/^rejected:.*blocked/)
      expect(result.listOutside).toMatch(/^rejected:/)
      expect(result.stageTraversal).toMatch(/^rejected:/)
      expect(result.badInput).toMatch(/^rejected:/)
      expect(result.terminalBadSize).toMatch(/^rejected:/)
      expect(result.normal).toMatch(/^ok:.*"status":"ok"/)
      // Nothing was written anywhere it shouldn't be.
      expect(() => writeFileSync(join(repo, '..', 'check-not-created'), '')).not.toThrow()
      rmSync(join(repo, '..', 'check-not-created'), { force: true })
    } finally {
      await closeApp(app)
      rmSync(repo, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
      rmSync(seed.userData, { recursive: true, force: true })
    }
  })
})

test.describe('empty and error states in the real app', () => {
  test('a workspace without a folder offers one action: choose a folder', async () => {
    const seed = seedUserData([{ name: 'no folder' }])
    const { app, page } = await launchApp(seed.userData)
    try {
      for (const nav of ['/code', '/git']) {
        await page.getByRole('button', { name: nav }).click()
        const visiblePage = page.locator('.workspace-view__page:not([hidden])')
        await expect(visiblePage.getByText('No folder chosen for this workspace')).toBeVisible()
        await expect(visiblePage.getByRole('button', { name: '[choose a folder]' })).toBeVisible()
      }
      // The terminal panel can't start a shell without a folder either.
      await page.keyboard.press('Control+`')
      await expect(page.locator('.terminal-stack__empty')).toContainText('No folder chosen')
      expect(await page.locator('.xterm').count()).toBe(0)
    } finally {
      await closeApp(app)
      rmSync(seed.userData, { recursive: true, force: true })
    }
  })

  test('a folder that is not a repository says so and does not offer to initialize one', async () => {
    const plain = tempDir('aiw-e2e-plain-')
    writeFileSync(join(plain, 'notes.txt'), 'just a folder\n')
    const seed = seedUserData([{ name: 'plain', root: plain }])
    const { app, page } = await launchApp(seed.userData)
    try {
      await page.getByRole('button', { name: '/git' }).click()
      await expect(page.getByText('This folder is not a git repository')).toBeVisible()
      await expect(page.getByRole('button', { name: /init/i })).toHaveCount(0)
      // The editor still works on a plain folder.
      await page.getByRole('button', { name: '/code' }).click()
      await expect(page.locator('[data-path="notes.txt"]')).toBeVisible()
    } finally {
      await closeApp(app)
      rmSync(plain, { recursive: true, force: true })
      rmSync(seed.userData, { recursive: true, force: true })
    }
  })

  test('without git on PATH the changes view shows "Git not found" instead of crashing', async () => {
    test.skip(!IS_WINDOWS, 'the PATH-stripping trick used here is Windows-specific')
    const repo = tempDir('aiw-e2e-nogit-')
    createProjectRepo(repo)
    const seed = seedUserData([{ name: 'no git', root: repo }])
    const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
    const { app, page } = await launchApp(seed.userData, { env: { PATH: `${systemRoot}\\System32;${systemRoot}`, Path: `${systemRoot}\\System32;${systemRoot}` } })
    try {
      await page.getByRole('button', { name: '/git' }).click()
      await expect(page.getByText('Git not found')).toBeVisible()
      // The rest of the app is unaffected.
      await page.getByRole('button', { name: '/code' }).click()
      await expect(page.locator('[data-path="README.md"]')).toBeVisible()
    } finally {
      await closeApp(app)
      rmSync(repo, { recursive: true, force: true })
      rmSync(seed.userData, { recursive: true, force: true })
    }
  })
})

test.describe('unsaved changes when closing the window', () => {
  test('closing with unsaved edits asks first; "keep editing" keeps the window, "discard" closes it', async () => {
    const repo = tempDir('aiw-e2e-dirty-')
    createProjectRepo(repo)
    const seed = seedUserData([{ name: 'dirty', root: repo }])
    const { app, page } = await launchApp(seed.userData, { size: { width: 1200, height: 800 } })
    try {
      await page.getByRole('button', { name: '/code' }).click()
      await page.locator('[data-path="README.md"]').click()
      const editor = page.locator('.monaco-editor .view-lines').first()
      await expect(editor).toContainText('Demo project')
      await editor.click()
      await page.keyboard.type('unsaved')
      await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(1)

      // Answer the native confirm without a human: first "Keep editing" (0)...
      await app.evaluate(({ dialog, BrowserWindow }) => {
        const state = globalThis as unknown as { __asked: number }
        state.__asked = 0
        dialog.showMessageBoxSync = (() => {
          state.__asked += 1
          return 0
        }) as unknown as typeof dialog.showMessageBoxSync
        BrowserWindow.getAllWindows()[0]?.close()
      })
      await page.waitForTimeout(800)
      const afterKeep = await app.evaluate(({ BrowserWindow }) => ({
        windows: BrowserWindow.getAllWindows().length,
        asked: (globalThis as unknown as { __asked: number }).__asked,
      }))
      expect(afterKeep).toEqual({ windows: 1, asked: 1 })
      await expect(page.locator('.editor-tab.is-dirty')).toHaveCount(1) // still there, still dirty

      // ...then "Discard changes and close" (1).
      await app.evaluate(({ dialog, BrowserWindow }) => {
        dialog.showMessageBoxSync = (() => 1) as unknown as typeof dialog.showMessageBoxSync
        BrowserWindow.getAllWindows()[0]?.close()
      })
      await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(0)
      // Nothing was written to the file.
      expect(readFileSync(join(repo, 'README.md'), 'utf8')).not.toContain('unsaved')
    } finally {
      await closeApp(app)
      rmSync(repo, { recursive: true, force: true })
      rmSync(seed.userData, { recursive: true, force: true })
    }
  })
})
