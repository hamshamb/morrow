import { useEffect, useRef, useState } from 'react'
import {
  isReasoningCapableModel,
  type LastModelSelection,
  type ModelRef,
  type ProviderConfigSummary,
  type ProviderModelCatalog,
  type ReasoningEffort,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { findDisplayName, shortModelName } from '../lib/model-label'
import { ModelPicker } from './ModelPicker'
import { focusComposer } from '../lib/focus'

interface Props {
  configs: ProviderConfigSummary[]
  catalogs: Record<string, ProviderModelCatalog>
  providerConfigId: string | null
  model: string | null
  effort: ReasoningEffort | null
  onChange: (providerConfigId: string, model: string, effort: ReasoningEffort | null) => void
  onRefreshModels: (providerConfigId: string) => void
  refreshingIds: Set<string>
  favorites: ModelRef[]
  recents: LastModelSelection[]
  onToggleFavorite: (ref: ModelRef) => void
  /** Incrementing this (command palette "switch model", Ctrl+M) opens the
   * popover programmatically. */
  externalOpenSignal?: number
}

/**
 * The composer's model chip — always shows provider + model (+ effort when
 * set) — and its popover. All picker behavior lives in `ModelPicker`.
 */
export function ModelSelector({
  configs,
  catalogs,
  providerConfigId,
  model,
  effort,
  onChange,
  onRefreshModels,
  refreshingIds,
  favorites,
  recents,
  onToggleFavorite,
  externalOpenSignal,
}: Props) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Compares against the last *seen* value (not a "first render" guard) so
  // React StrictMode's dev double effect invocation can't misfire this —
  // a first-render guard opened the popover on every page load.
  const lastOpenSignalRef = useRef(externalOpenSignal)
  useEffect(() => {
    if (externalOpenSignal !== undefined && externalOpenSignal !== lastOpenSignalRef.current) {
      lastOpenSignalRef.current = externalOpenSignal
      setOpen(true)
    }
  }, [externalOpenSignal])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function close() {
    setOpen(false)
    focusComposer()
  }

  if (configs.length === 0) return null

  const activeConfig = configs.find((c) => c.id === providerConfigId) ?? configs[0] ?? null
  const supportsEffort = activeConfig && model ? isReasoningCapableModel(activeConfig.provider, model) : false
  const name = model ? shortModelName(model, findDisplayName(catalogs, model)) : 'choose model'

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        type="button"
        className="chip chip--outline model-selector__trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${activeConfig ? PROVIDER_LABELS[activeConfig.provider] : ''} ${model ?? ''} — switch model (Ctrl+M)`}
      >
        <span className="model-selector__name">{name}</span>
        {activeConfig && <span className="model-selector__provider">· {PROVIDER_LABELS[activeConfig.provider]}</span>}
        {effort && supportsEffort && <span className="model-selector__effort">· {effort}</span>}
        <span className="model-selector__caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div className="popover popover--above">
          <ModelPicker
            configs={configs}
            catalogs={catalogs}
            selected={activeConfig && model ? { providerConfigId: activeConfig.id, model } : null}
            favorites={favorites}
            recents={recents}
            onToggleFavorite={onToggleFavorite}
            onClose={close}
            onSelect={(option) => {
              const nextEffort = isReasoningCapableModel(option.provider, option.modelId) ? effort : null
              onChange(option.providerConfigId, option.modelId, nextEffort)
              close()
            }}
            effort={effort}
            onEffortChange={(next) => activeConfig && model && onChange(activeConfig.id, model, next)}
            onCustomModel={(id) => {
              const target = activeConfig ?? configs[0]
              if (!target) return
              onChange(target.id, id, isReasoningCapableModel(target.provider, id) ? effort : null)
              close()
            }}
            onRefreshModels={onRefreshModels}
            refreshingIds={refreshingIds}
          />
        </div>
      )}
    </div>
  )
}
