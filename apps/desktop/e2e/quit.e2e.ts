import { expect, test } from '@playwright/test'
import type { RendererApi } from '@ai-workspace/shared'
import { closeApp, launchApp, listTerminals, processAlive, processesWithArg, seedUserData, tempDir } from './helpers'

/**
 * The app always exits (ADR-052). A main process that does not exit keeps the single-instance lock, so the user
 * could not reopen the app. Two causes are covered: closing a busy ConPTY on Windows (it blocked the main thread
 * until output nobody read any more was flushed), and anything else that gets stuck once the quit is final (the
 * watchdog).
 */

const FLOOD = process.platform === 'win32' ? "while ($true) { 'x' * 300 }\r" : 'yes xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\r'

test('quitting while terminals are printing exits promptly and leaves no shell behind', async () => {
  test.setTimeout(180_000)
  for (let round = 1; round <= 3; round += 1) {
    const seed = seedUserData([{ name: 'Quit', root: tempDir('aiw-e2e-quit-') }])
    const workspaceId = seed.workspaceIds[0] as string
    const { app, page } = await launchApp(seed.userData)
    const mainPid = app.process().pid ?? 0
    for (let i = 0; i < 3; i += 1) {
      const info = await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.terminal.create({ workspaceId: id, cols: 120, rows: 30 }), workspaceId)
      await expect.poll(async () => (await page.evaluate((id) => (window as unknown as { api: RendererApi }).api.terminal.getBuffer(id), info.id)).length, { timeout: 30_000 }).toBeGreaterThan(0)
      await page.evaluate(([id, data]) => (window as unknown as { api: RendererApi }).api.terminal.write(id as string, data as string), [info.id, FLOOD])
    }
    await page.waitForTimeout(1500)
    const shells = (await listTerminals(page, workspaceId)).map((t) => t.pid ?? 0).filter((pid) => pid > 0)
    expect(shells.length, `round ${round}`).toBe(3)

    const started = Date.now()
    expect(await closeApp(app, 15_000), `round ${round}: the app must quit on its own`).toBe('closed')
    expect(Date.now() - started, `round ${round}: quit took too long`).toBeLessThan(8_000)
    expect(processAlive(mainPid)).toBe(false)
    // Every Electron process of this profile (the real main process may be a child of the launcher Playwright reports).
    await expect.poll(() => processesWithArg(seed.userData), { timeout: 10_000 }).toEqual([])
    for (const pid of shells) await expect.poll(() => processAlive(pid), { timeout: 10_000 }).toBe(false)
  }
})

test('a quit that gets stuck is ended by the watchdog', async () => {
  test.setTimeout(90_000)
  const seed = seedUserData([{ name: 'Stuck quit' }])
  const { app } = await launchApp(seed.userData)
  const mainPid = app.process().pid ?? 0
  // Simulates any cleanup that never returns: it blocks the main thread, so only another thread can end the process.
  await app.evaluate(({ app: electronApp }) => {
    electronApp.on('will-quit', () => {
      for (;;) {
        /* stuck */
      }
    })
  })
  const started = Date.now()
  expect(await closeApp(app, 30_000)).toBe('closed')
  const took = Date.now() - started
  expect(took).toBeGreaterThan(8_000) // it really was stuck until the watchdog fired (10 s)
  expect(took).toBeLessThan(25_000)
  expect(processAlive(mainPid)).toBe(false)
  await expect.poll(() => processesWithArg(seed.userData), { timeout: 10_000 }).toEqual([])
})
