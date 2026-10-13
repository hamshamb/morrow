import { app } from 'electron'
import { join } from 'node:path'

/** Folder name under %APPDATA% (or the platform equivalent) for the installed app's data. */
export const PACKAGED_DATA_DIR_NAME = 'Morrow'

/**
 * Where the installed app keeps its data, or null to keep Electron's default.
 *
 * Electron derives userData from package.json `name` (`@ai-workspace/desktop`), which is also what
 * dev builds use, so an installed copy would open the developer's workspaces and history. The
 * installed app gets its own folder named after the product instead. An explicit
 * `--user-data-dir` (E2E tests, demo profiles) always wins, and dev builds keep their folder.
 */
export function packagedUserDataDir(opts: {
  isPackaged: boolean
  hasUserDataDirSwitch: boolean
  appDataDir: string
}): string | null {
  if (!opts.isPackaged || opts.hasUserDataDirSwitch) return null
  return join(opts.appDataDir, PACKAGED_DATA_DIR_NAME)
}

// Runs on import: index.ts imports this module first, before anything reads userData and before
// the single-instance lock (which is keyed by the userData folder).
const dir = packagedUserDataDir({
  isPackaged: app.isPackaged,
  hasUserDataDirSwitch: app.commandLine.hasSwitch('user-data-dir'),
  appDataDir: app.getPath('appData'),
})
if (dir) app.setPath('userData', dir)
