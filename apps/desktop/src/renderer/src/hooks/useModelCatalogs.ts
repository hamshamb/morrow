import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProviderConfigSummary, ProviderModelCatalog } from '@ai-workspace/shared'

/**
 * Owns the live-fetched (cached) model catalog for every configured
 * provider config, keyed by `providerConfigId`. Owned once by
 * `WorkspaceView` and passed down (composer picker, regenerate-with
 * picker, command palette favorites) — the single-owner pattern from the
 * `useProviderConfigs` fix (commit 28eb009).
 */
export function useModelCatalogs(providerConfigs: ProviderConfigSummary[]) {
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({})
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const refresh = useCallback(async (providerConfigId: string) => {
    setRefreshingIds((prev) => new Set(prev).add(providerConfigId))
    setErrors((prev) => {
      const next = { ...prev }
      delete next[providerConfigId]
      return next
    })
    try {
      const result = await window.api.modelCatalog.refresh(providerConfigId)
      setCatalogs((prev) => ({ ...prev, [providerConfigId]: result.catalog }))
      if (!result.ok) {
        setErrors((prev) => ({ ...prev, [providerConfigId]: result.message ?? 'Refresh failed' }))
      }
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setErrors((prev) => ({ ...prev, [providerConfigId]: message }))
      throw err
    } finally {
      setRefreshingIds((prev) => {
        const next = new Set(prev)
        next.delete(providerConfigId)
        return next
      })
    }
  }, [])

  const configIds = providerConfigs.map((c) => c.id).join(',')
  // Configs already auto-refreshed this session (never more than once).
  const autoRefreshed = useRef<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    for (const config of providerConfigs) {
      void window.api.modelCatalog.list(config.id).then((catalog) => {
        if (cancelled) return
        setCatalogs((prev) => ({ ...prev, [config.id]: catalog }))
        // A catalog that has never been fetched (e.g. a key just added —
        // main's own post-add refresh may still be in flight) gets one
        // automatic refresh, so the picker isn't empty for providers with
        // no static fallback (OpenAI).
        if (catalog.fetchedAt === null && !autoRefreshed.current.has(config.id)) {
          autoRefreshed.current.add(config.id)
          void refresh(config.id).catch(() => undefined)
        }
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- configIds is the intentional dependency; providerConfigs itself is a new array every render
  }, [configIds, refresh])

  return { catalogs, refresh, refreshingIds, errors }
}
