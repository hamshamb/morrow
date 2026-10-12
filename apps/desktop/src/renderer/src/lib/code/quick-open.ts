import { compactSearch, normalizeSearch } from '../search-match'
import { baseName } from './paths'

/**
 * Quick open ranking (Ctrl+P). Same normalized-substring approach as the
 * command palette's `matchesSearch` (adapted from opencode, MIT - see
 * lib/search-match.ts), extended with two things a file list needs: every
 * whitespace-separated token of the query must match (so "side tsx" finds
 * `components/Sidebar.tsx`), and results are ordered by where the match lands
 * (file name before directory, start before middle). Not a fuzzy matcher.
 */

export interface QuickOpenResult {
  path: string
  score: number
}

function tokenScore(token: string, compactToken: string, name: string, compactName: string, path: string, compactPath: string): number | null {
  if (name === token || compactName === compactToken) return 0
  if (name.startsWith(token) || compactName.startsWith(compactToken)) return 1
  if (name.includes(token) || compactName.includes(compactToken)) return 2
  if (path.includes(token) || compactPath.includes(compactToken)) return 3
  return null
}

/** Lower is better; null = no match. */
export function scorePath(query: string, path: string): number | null {
  const normalizedQuery = normalizeSearch(query)
  if (!normalizedQuery) return 0
  const name = normalizeSearch(baseName(path))
  const compactName = compactSearch(baseName(path))
  const full = normalizeSearch(path)
  const compactFull = compactSearch(path)
  let total = 0
  for (const token of normalizedQuery.split(' ')) {
    const score = tokenScore(token, token, name, compactName, full, compactFull)
    if (score === null) return null
    total += score
  }
  return total
}

export function rankPaths(paths: readonly string[], query: string, limit = 50): QuickOpenResult[] {
  const results: QuickOpenResult[] = []
  for (const path of paths) {
    const score = scorePath(query, path)
    if (score !== null) results.push({ path, score })
  }
  results.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
  return results.slice(0, limit)
}
