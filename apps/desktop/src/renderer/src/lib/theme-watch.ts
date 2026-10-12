/**
 * Calls `listener` whenever the app theme may have changed: the `data-theme`
 * attribute on <html> (Settings) or the OS color scheme (the `system`
 * setting). Fires on the next frame, after the new CSS custom properties are
 * live, so `getComputedStyle` reads the new tokens. Used to re-theme Monaco
 * and xterm.js, which cache their colors.
 */
export function subscribeThemeChange(listener: () => void): () => void {
  const fire = (): void => {
    requestAnimationFrame(listener)
  }
  const observer = new MutationObserver(fire)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', fire)
  return () => {
    observer.disconnect()
    media.removeEventListener('change', fire)
  }
}
