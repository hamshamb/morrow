import { Worker } from 'node:worker_threads'

/** How long a quit may take, once it is final, before the watchdog ends the process. */
export const QUIT_WATCHDOG_MS = 10_000

/**
 * The last line of defence for "the app does not exit" (ADR-052). A stuck main process keeps the single-instance
 * lock, so the user could not even reopen the app. Armed on `will-quit` - the quit is final by then; `before-quit`
 * can still be cancelled by the unsaved-changes dialog. It runs on its own thread because the thing it guards
 * against is the main thread being blocked (a timer there would never fire). It is unref'd, so a normal exit
 * never waits for it. SQLite is in WAL mode, so ending the process cannot corrupt the database.
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads')
setTimeout(() => {
  try { process.kill(workerData.pid, 'SIGKILL') } catch {}
}, workerData.ms)
`

let armed = false

export function armQuitWatchdog(ms: number = QUIT_WATCHDOG_MS): void {
  if (armed) return
  armed = true
  try {
    new Worker(WORKER_SOURCE, { eval: true, workerData: { pid: process.pid, ms } }).unref()
  } catch (err) {
    console.error('quit watchdog could not start:', err instanceof Error ? err.message : String(err))
  }
}
