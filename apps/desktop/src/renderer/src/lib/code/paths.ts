/** Small POSIX-path helpers for the workspace-relative paths the code view deals in. */

export function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** '' for a top-level file. */
export function dirName(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Every ancestor directory of a path, shallowest first: 'a/b/c.ts' -> ['a', 'a/b']. */
export function ancestorDirs(path: string): string[] {
  const parts = path.split('/')
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i += 1) dirs.push(parts.slice(0, i).join('/'))
  return dirs
}

export function extension(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/** Strips Electron's "Error invoking remote method 'x': Error: " wrapper so IPC failures read like the message the main process threw. */
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(?:\w+Error|Error):\s*/, '')
}
