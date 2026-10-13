import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: true,
    commandLine: { hasSwitch: vi.fn(() => false) },
    getPath: vi.fn(() => 'C:\\Users\\u\\AppData\\Roaming'),
    setPath: vi.fn(),
  },
}))
vi.mock('electron', () => electron)

const { packagedUserDataDir } = await import('../app-paths')
// Captured right after import: vitest clears mock call records before each test.
const setPathCallsOnImport = [...electron.app.setPath.mock.calls]

describe('packagedUserDataDir', () => {
  const appDataDir = join('C:', 'Users', 'u', 'AppData', 'Roaming')

  it('gives the installed app its own Morrow folder, not the dev builds one', () => {
    expect(packagedUserDataDir({ isPackaged: true, hasUserDataDirSwitch: false, appDataDir })).toBe(
      join(appDataDir, 'Morrow'),
    )
  })

  it('leaves dev builds on their existing folder', () => {
    expect(packagedUserDataDir({ isPackaged: false, hasUserDataDirSwitch: false, appDataDir })).toBeNull()
  })

  it('never overrides an explicit --user-data-dir', () => {
    expect(packagedUserDataDir({ isPackaged: true, hasUserDataDirSwitch: true, appDataDir })).toBeNull()
  })

  it('applies the folder on import, before anything else reads userData', () => {
    expect(setPathCallsOnImport).toEqual([['userData', join('C:\\Users\\u\\AppData\\Roaming', 'Morrow')]])
  })
})
