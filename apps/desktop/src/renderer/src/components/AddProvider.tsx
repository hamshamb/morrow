import { useCallback, useMemo, useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { KeyEntry } from './KeyEntry'
import { ProviderList } from './ProviderList'

interface Props {
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  onSaved: (created: ProviderConfigSummary) => void
  autoSave: boolean
  autoFocus?: boolean
  /** Providers that already have a key, for the `connected` marker. */
  configs?: ProviderConfigSummary[]
}

/**
 * "Add a provider": the searchable registry list plus the key field. Shared by
 * first-run onboarding and Settings so both cover every provider the app can
 * run (popular first, Ollama with its detection state, the custom endpoint).
 */
export function AddProvider({ add, test, onSaved, autoSave, autoFocus, configs }: Props) {
  const registry = useProviderRegistry()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const selected = useMemo(
    () => registry.entries.find((e) => e.id === selectedId) ?? null,
    [registry.entries, selectedId],
  )
  const connectedIds = useMemo(() => new Set((configs ?? []).map((c) => c.provider)), [configs])
  const handleDetected = useCallback((id: string) => setSelectedId(id), [])

  return (
    <div className="add-provider">
      <ProviderList
        entries={registry.entries}
        local={registry.local}
        detectingLocal={registry.detectingLocal}
        onRecheckLocal={() => void registry.detectLocal()}
        connectedIds={connectedIds}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id)
          // Move on to the key field right after picking a provider.
          requestAnimationFrame(() => document.getElementById('key-entry-input')?.focus())
        }}
        {...(autoFocus ? { autoFocus: true } : {})}
      />
      <KeyEntry
        registry={registry.entries}
        provider={selected}
        onProviderDetected={handleDetected}
        add={add}
        test={test}
        onSaved={onSaved}
        autoSave={autoSave}
      />
    </div>
  )
}
