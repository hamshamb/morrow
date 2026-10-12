/**
 * Search-match normalization, adapted from opencode's
 * `dialog-select-model-search.ts` (MIT License,
 * https://github.com/anomalyco/opencode) — see
 * docs/UI_REFERENCE_OPENCODE.md §6 and docs/OPEN_SOURCE_INVENTORY.md. Not a
 * fuzzy-match library: normalized substring matching tried two ways
 * (space-normalized and fully compacted, so e.g. "gpt4o" matches "GPT-4o").
 * Used by the command palette; `lib/model-picker.ts`'s existing filter
 * already independently converged on the same approach for the model
 * picker (confirmed in the research doc — no change needed there).
 */

export function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

export function compactSearch(value: string): string {
  return normalizeSearch(value).replaceAll(' ', '')
}

export function matchesSearch(query: string, values: string[]): boolean {
  const search = normalizeSearch(query)
  if (!search) return true
  const compact = compactSearch(query)
  return values.some(
    (value) => normalizeSearch(value).includes(search) || compactSearch(value).includes(compact),
  )
}
