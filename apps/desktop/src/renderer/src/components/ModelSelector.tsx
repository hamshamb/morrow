import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isReasoningCapableModel,
  REASONING_EFFORT_VALUES,
  type ProviderConfigSummary,
  type ProviderModelCatalog,
  type ReasoningEffort,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { buildModelPickerOptions, filterModelPickerOptions, type ModelPickerOption } from '../lib/model-picker'

interface Props {
  configs: ProviderConfigSummary[]
  catalogs: Record<string, ProviderModelCatalog>
  providerConfigId: string | null
  model: string | null
  effort: ReasoningEffort | null
  onChange: (providerConfigId: string, model: string, effort: ReasoningEffort | null) => void
  onRefreshModels: (providerConfigId: string) => void
  refreshingIds: Set<string>
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}

export function ModelSelector({
  configs,
  catalogs,
  providerConfigId,
  model,
  effort,
  onChange,
  onRefreshModels,
  refreshingIds,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [customModelId, setCustomModelId] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const options = useMemo(() => buildModelPickerOptions(configs, catalogs), [configs, catalogs])
  const filtered = useMemo(() => filterModelPickerOptions(options, query), [options, query])

  const activeConfig = configs.find((c) => c.id === providerConfigId) ?? configs[0] ?? null
  const activeOption = options.find(
    (o) => o.providerConfigId === providerConfigId && o.modelId === model,
  )
  const activeModelLabel = activeOption?.label ?? model ?? ''
  const modelSupportsEffort =
    activeConfig && model ? isReasoningCapableModel(activeConfig.provider, model) : false

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function openPopover() {
    setQuery('')
    setOpen(true)
    // Wait a tick for the input to mount before focusing it.
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function selectOption(option: ModelPickerOption) {
    const nextEffort = isReasoningCapableModel(option.provider, option.modelId) ? effort : null
    onChange(option.providerConfigId, option.modelId, nextEffort)
    setOpen(false)
    setQuery('')
  }

  function applyCustomModel() {
    const trimmed = customModelId.trim()
    const targetConfig = activeConfig ?? configs[0]
    if (!trimmed || !targetConfig) return
    const nextEffort = isReasoningCapableModel(targetConfig.provider, trimmed) ? effort : null
    onChange(targetConfig.id, trimmed, nextEffort)
    setCustomModelId('')
    setOpen(false)
    setQuery('')
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const option = filtered[highlighted]
      if (option) selectOption(option)
      return
    }
  }

  if (configs.length === 0) {
    return <span className="model-selector__empty">No providers configured</span>
  }

  return (
    <div className="model-selector" ref={containerRef}>
      <button
        type="button"
        className="model-selector__trigger"
        onClick={() => (open ? setOpen(false) : openPopover())}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="model-selector__trigger-provider">
          {activeConfig ? PROVIDER_LABELS[activeConfig.provider] : ''}
        </span>
        <span className="model-selector__trigger-model">{activeModelLabel || 'Choose a model…'}</span>
        {effort && modelSupportsEffort && (
          <span className="model-selector__trigger-effort">{EFFORT_LABELS[effort]}</span>
        )}
        <span className="model-selector__trigger-caret">▾</span>
      </button>

      {open && (
        <div className="model-selector__popover" role="dialog" aria-label="Choose a model">
          <input
            ref={inputRef}
            type="text"
            className="model-selector__search"
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />

          <ul className="model-selector__options" role="listbox">
            {filtered.map((option, index) => {
              const isSelected =
                option.providerConfigId === providerConfigId && option.modelId === model
              return (
                <li
                  key={`${option.providerConfigId}:${option.modelId}`}
                  role="option"
                  aria-selected={isSelected}
                  className={`model-selector__option${index === highlighted ? ' is-highlighted' : ''}${isSelected ? ' is-selected' : ''}`}
                >
                  <button type="button" onClick={() => selectOption(option)} onMouseEnter={() => setHighlighted(index)}>
                    <span className="model-selector__option-label">{option.label}</span>
                    <span className="model-selector__option-meta">
                      {option.configLabel} · {PROVIDER_LABELS[option.provider]}
                    </span>
                  </button>
                </li>
              )
            })}
            {filtered.length === 0 && (
              <li className="model-selector__empty-results">No models match "{query}".</li>
            )}
          </ul>

          {modelSupportsEffort && (
            <div className="model-selector__effort">
              <span className="model-selector__effort-label">Thinking effort</span>
              <div className="model-selector__effort-options">
                <button
                  type="button"
                  className={`model-selector__effort-btn${effort === null ? ' is-active' : ''}`}
                  onClick={() => activeConfig && model && onChange(activeConfig.id, model, null)}
                >
                  Off
                </button>
                {REASONING_EFFORT_VALUES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={`model-selector__effort-btn${effort === value ? ' is-active' : ''}`}
                    onClick={() => activeConfig && model && onChange(activeConfig.id, model, value)}
                  >
                    {EFFORT_LABELS[value]}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="model-selector__custom">
            <input
              type="text"
              placeholder="Custom model id…"
              value={customModelId}
              onChange={(e) => setCustomModelId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  applyCustomModel()
                }
              }}
            />
            <button type="button" onClick={applyCustomModel} disabled={!customModelId.trim()}>
              Use
            </button>
          </div>

          {activeConfig && (
            <button
              type="button"
              className="model-selector__refresh"
              disabled={refreshingIds.has(activeConfig.id)}
              onClick={() => onRefreshModels(activeConfig.id)}
            >
              {refreshingIds.has(activeConfig.id) ? 'Refreshing…' : 'Refresh models'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
