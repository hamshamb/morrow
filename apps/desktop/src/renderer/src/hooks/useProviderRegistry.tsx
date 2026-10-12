import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type {
  LocalProviderStatus,
  ModelsMetadataStatus,
  ProviderId,
  ProviderRegistryEntry,
  RefreshModelsMetadataResult,
} from '@ai-workspace/shared'

export interface ProviderRegistryValue {
  /** Every provider the app can run, popular first (data-driven: models.dev + Ollama + custom). */
  entries: ProviderRegistryEntry[]
  loaded: boolean
  byId: (id: ProviderId) => ProviderRegistryEntry | undefined
  /** Display name for a provider id; falls back to the id for unknown ones. */
  label: (id: ProviderId) => string
  /** Local servers (Ollama, LM Studio…) found on this machine, by provider id. */
  local: Record<string, LocalProviderStatus>
  detectingLocal: boolean
  detectLocal: () => Promise<void>
  /** Where the models.dev catalog comes from + whether the download is enabled. */
  metadataStatus: ModelsMetadataStatus | null
  refreshMetadata: () => Promise<RefreshModelsMetadataResult>
  /** Re-reads the status only (e.g. after the opt-out was toggled). */
  refreshStatus: () => Promise<void>
  /** Bumps whenever the catalog was replaced; model lists re-read on change. */
  metadataVersion: number
}

const ProviderRegistryContext = createContext<ProviderRegistryValue | null>(null)

/**
 * Owns the provider registry, local-server detection and the models.dev
 * status once for the whole app (the single-owner pattern used elsewhere in
 * the renderer) and shares them through context so labels and metadata do
 * not have to be threaded through every component.
 */
export function useProviderRegistryState(): ProviderRegistryValue {
  const [entries, setEntries] = useState<ProviderRegistryEntry[]>([])
  const [loaded, setLoaded] = useState(false)
  const [local, setLocal] = useState<Record<string, LocalProviderStatus>>({})
  const [detectingLocal, setDetectingLocal] = useState(false)
  const [metadataStatus, setMetadataStatus] = useState<ModelsMetadataStatus | null>(null)
  const [metadataVersion, setMetadataVersion] = useState(0)

  const reload = useCallback(async () => {
    const [registry, status] = await Promise.all([
      window.api.providers.registry(),
      window.api.modelsMetadata.status(),
    ])
    setEntries(registry)
    setMetadataStatus(status)
    setLoaded(true)
  }, [])

  const detectLocal = useCallback(async () => {
    setDetectingLocal(true)
    try {
      const statuses = await window.api.providers.detectLocal()
      setLocal(Object.fromEntries(statuses.map((s) => [s.id, s])))
    } catch {
      setLocal({})
    } finally {
      setDetectingLocal(false)
    }
  }, [])

  useEffect(() => {
    void reload().catch(() => setLoaded(true))
    void detectLocal()
    return window.api.modelsMetadata.onChange(() => {
      void reload().then(() => setMetadataVersion((v) => v + 1))
    })
  }, [reload, detectLocal])

  const refreshMetadata = useCallback(async () => {
    const result = await window.api.modelsMetadata.refresh()
    setMetadataStatus(result.status)
    if (result.ok) {
      await reload()
      setMetadataVersion((v) => v + 1)
    }
    return result
  }, [reload])

  const refreshStatus = useCallback(async () => {
    setMetadataStatus(await window.api.modelsMetadata.status())
  }, [])

  const index = useMemo(() => new Map(entries.map((e) => [e.id, e])), [entries])
  const byId = useCallback((id: ProviderId) => index.get(id), [index])
  const label = useCallback((id: ProviderId) => index.get(id)?.name ?? id, [index])

  return useMemo(
    () => ({
      entries,
      loaded,
      byId,
      label,
      local,
      detectingLocal,
      detectLocal,
      metadataStatus,
      refreshMetadata,
      refreshStatus,
      metadataVersion,
    }),
    [
      entries,
      loaded,
      byId,
      label,
      local,
      detectingLocal,
      detectLocal,
      metadataStatus,
      refreshMetadata,
      refreshStatus,
      metadataVersion,
    ],
  )
}

export function ProviderRegistryProvider({ value, children }: { value: ProviderRegistryValue; children: ReactNode }) {
  return <ProviderRegistryContext.Provider value={value}>{children}</ProviderRegistryContext.Provider>
}

export function useProviderRegistry(): ProviderRegistryValue {
  const value = useContext(ProviderRegistryContext)
  if (!value) throw new Error('useProviderRegistry must be used inside <ProviderRegistryProvider>')
  return value
}
