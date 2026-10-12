import type { ProviderModelCatalog } from '@ai-workspace/shared'

/**
 * Short model name for attribution chips (e.g. "Sonnet 5" for
 * claude-sonnet-5 / "Claude Sonnet 5"). Prefers the provider's own display
 * name from the cached catalog; falls back to the raw id. Drops a leading
 * "Claude " since the provider is shown next to it anyway.
 */
export function shortModelName(modelId: string, displayName?: string | null): string {
  const base = (displayName ?? '').trim() || modelId.trim()
  return base.replace(/^claude[\s-]+/i, '')
}

/** Looks a model's display name up across every cached catalog. */
export function findDisplayName(
  catalogs: Record<string, ProviderModelCatalog>,
  modelId: string,
): string | null {
  for (const catalog of Object.values(catalogs)) {
    const hit = catalog.models.find((m) => m.id === modelId)
    if (hit?.displayName) return hit.displayName
  }
  return null
}
