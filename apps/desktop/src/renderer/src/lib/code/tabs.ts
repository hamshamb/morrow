/** Pure tab-strip state for the editor: which files are open and which one is active. */

export interface TabsState {
  tabs: string[]
  active: string | null
}

export const EMPTY_TABS: TabsState = { tabs: [], active: null }

/** Opens `path` (appended after the active tab when new) and makes it active. */
export function openTab(state: TabsState, path: string): TabsState {
  if (state.tabs.includes(path)) return state.active === path ? state : { ...state, active: path }
  const at = state.active === null ? -1 : state.tabs.indexOf(state.active)
  const tabs = at === -1 ? [...state.tabs, path] : [...state.tabs.slice(0, at + 1), path, ...state.tabs.slice(at + 1)]
  return { tabs, active: path }
}

/** Closes a tab; when it was active, the tab to its right (else left) takes over. */
export function closeTab(state: TabsState, path: string): TabsState {
  const index = state.tabs.indexOf(path)
  if (index === -1) return state
  const tabs = state.tabs.filter((t) => t !== path)
  if (state.active !== path) return { ...state, tabs }
  return { tabs, active: tabs[index] ?? tabs[index - 1] ?? null }
}

/** Ctrl+Tab style cycling. */
export function cycleTab(state: TabsState, direction: 1 | -1): TabsState {
  if (state.tabs.length < 2 || state.active === null) return state
  const index = state.tabs.indexOf(state.active)
  const next = (index + direction + state.tabs.length) % state.tabs.length
  return { ...state, active: state.tabs[next] ?? state.active }
}

/** Keeps only restorable paths (drops duplicates), and an active tab that is actually open. */
export function sanitizeSession(tabs: readonly string[], active: string | null): TabsState {
  const unique = [...new Set(tabs)]
  return { tabs: unique, active: active !== null && unique.includes(active) ? active : (unique[0] ?? null) }
}
