import { useCallback, useEffect, useState } from 'react'
import type { ProviderConfigSummary, ProviderModelCatalog } from '@ai-workspace/shared'

/**
 * Owns the live-fetched (cached) model catalog for every configured
 * provider config, keyed by `providerConfigId`. A single owner passed down
 * from `ChatPanel` to the model-picker popover — following the
 * single-owner pattern from the `useProviderConfigs` fix (commit 28eb009)
 * rather than the picker fetching its own copy.
 */
export function useModelCatalogs(providerConfigs: ProviderConfigSummary[]) {
  const [catalogs, setCatalogs] = useState<Record<string, ProviderModelCatalog>>({})
  const [refreshingIds, setRefreshingIds] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const configIds = providerConfigs.map((c) => c.id).join(',')

  useEffect(() => {
    let cancelled = false
    for (const config of providerConfigs) {
      void window.api.modelCatalog.list(config.id).then((catalog) => {
        if (cancelled) return
        setCatalogs((prev) => ({ ...prev, [config.id]: catalog }))
      })
    }
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- configIds is the intentional dependency; providerConfigs itself is a new array every render
  }, [configIds])

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

  return { catalogs, refresh, refreshingIds, errors }
}
