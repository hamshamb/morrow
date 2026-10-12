import type { PtySpawn } from './terminal-manager'

/**
 * Loads the native PTY lazily (ADR-037): `@lydell/node-pty` ships prebuilt
 * binaries per platform as optional dependencies, so there is no toolchain
 * step, and nothing native is touched until the user opens a terminal - a
 * missing or broken binary produces a readable terminal error, never a crash
 * at app start. electron-vite externalizes it (it is a `dependency`), so the
 * `.node` file resolves from node_modules at runtime.
 */
let cached: Promise<PtySpawn> | null = null

export function loadNativeSpawn(): Promise<PtySpawn> {
  cached ??= import('@lydell/node-pty').then(
    (pty) => (file, args, options) =>
      pty.spawn(file, args, {
        name: options.name,
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: options.env,
      }),
    (err: unknown) => {
      cached = null
      throw new Error(`The terminal backend could not be loaded: ${err instanceof Error ? err.message : String(err)}`)
    },
  )
  return cached
}
