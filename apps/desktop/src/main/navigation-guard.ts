/**
 * Links in chat replies come from model output, which is untrusted. Only
 * plain web links may be handed to the OS — `file:`, `javascript:`, custom
 * protocol handlers (e.g. `ms-msdt:`, `search-ms:`) and anything else can
 * open local programs or files when passed to `shell.openExternal`.
 */
export function isSafeExternalUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname !== ''
}

/**
 * The app is a single page: the main window may only ever (re)load its own
 * renderer. Anything else — a dropped file, a link that navigates in place —
 * is refused, so the window can never be turned into a `file://` viewer or a
 * remote page with the preload bridge attached.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  let target: URL
  let app: URL
  try {
    target = new URL(url)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return target.protocol === 'file:' && target.pathname === app.pathname
  return target.origin === app.origin
}
