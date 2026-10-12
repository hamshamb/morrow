import { subscribeThemeChange } from '../theme-watch'
import { buildMonacoTheme, readThemeTokens } from './theme'

type MonacoModule = typeof import('./monaco-setup')
export type MonacoApi = MonacoModule['monaco']

const THEME_NAME = 'nochan'

let loading: Promise<MonacoApi> | null = null

/**
 * Loads Monaco the first time something needs an editor (a dynamic import, so
 * it is its own chunk) and keeps its theme in step with the nochan tokens.
 */
export function loadMonaco(): Promise<MonacoApi> {
  loading ??= import('./monaco-setup').then(({ monaco }) => {
    const apply = (): void => {
      monaco.editor.defineTheme(THEME_NAME, buildMonacoTheme(readThemeTokens()))
      monaco.editor.setTheme(THEME_NAME)
    }
    apply()
    subscribeThemeChange(apply)
    return monaco
  })
  loading.catch(() => {
    loading = null
  })
  return loading
}

export { THEME_NAME }
