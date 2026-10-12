import { useEffect, useMemo, useRef, useState } from 'react'
import {
  isFavoriteModel,
  isReasoningCapableModel,
  REASONING_EFFORT_VALUES,
  type LastModelSelection,
  type ModelRef,
  type ProviderConfigSummary,
  type ProviderModelCatalog,
  type ReasoningEffort,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { buildModelPickerOptions, filterModelPickerOptions, type ModelPickerOption } from '../lib/model-picker'

const EFFORT_LABELS: Record<ReasoningEffort, string> = { low: 'low', medium: 'medium', high: 'high' }

interface Group {
  key: string
  label: string
  options: ModelPickerOption[]
}

export interface ModelPickerProps {
  configs: ProviderConfigSummary[]
  catalogs: Record<string, ProviderModelCatalog>
  selected: ModelRef | null
  favorites: ModelRef[]
  recents: LastModelSelection[]
  onToggleFavorite: (ref: ModelRef) => void
  onSelect: (option: ModelPickerOption) => void
  onClose: () => void
  /** Optional header, e.g. "regenerate with" — shown as a small label. */
  title?: string
  /** Composer mode only: effort control, custom model id, refresh. */
  effort?: ReasoningEffort | null
  onEffortChange?: (effort: ReasoningEffort | null) => void
  onCustomModel?: (modelId: string) => void
  onRefreshModels?: (providerConfigId: string) => void
  refreshingIds?: Set<string>
}

/**
 * The searchable model list popover, shared by the composer's model chip
 * and the message "[regenerate with…]" action. Groups: Favorites (starred),
 * Recent (last used), then one group per configured provider key. A query
 * flattens to a ranked list (`filterModelPickerOptions`, unchanged).
 * Arrow keys / Enter / Esc; the star toggles a favorite without selecting.
 */
export function ModelPicker({
  configs,
  catalogs,
  selected,
  favorites,
  recents,
  onToggleFavorite,
  onSelect,
  onClose,
  title,
  effort,
  onEffortChange,
  onCustomModel,
  onRefreshModels,
  refreshingIds,
}: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [customModelId, setCustomModelId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  const options = useMemo(() => buildModelPickerOptions(configs, catalogs), [configs, catalogs])

  const groups = useMemo<Group[]>(() => {
    if (query.trim()) {
      return [{ key: 'results', label: 'results', options: filterModelPickerOptions(options, query) }]
    }
    const find = (ref: ModelRef) =>
      options.find((o) => o.providerConfigId === ref.providerConfigId && o.modelId === ref.model)
    const favoriteOptions = favorites.map(find).filter((o): o is ModelPickerOption => !!o)
    const recentOptions = recents
      .map(find)
      .filter((o): o is ModelPickerOption => !!o && !isFavoriteModel(favorites, toRef(o)))
    const result: Group[] = []
    if (favoriteOptions.length > 0) result.push({ key: 'fav', label: 'favorites', options: favoriteOptions })
    if (recentOptions.length > 0) result.push({ key: 'recent', label: 'recent', options: recentOptions })
    for (const config of configs) {
      result.push({
        key: config.id,
        label: `${PROVIDER_LABELS[config.provider]} · ${config.label}`,
        options: options.filter((o) => o.providerConfigId === config.id),
      })
    }
    return result
  }, [query, options, favorites, recents, configs])

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups])

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${highlighted}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(flat.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const option = flat[highlighted]
      if (option) onSelect(option)
    }
  }

  const activeConfig = configs.find((c) => c.id === selected?.providerConfigId) ?? null
  const showEffort =
    !!onEffortChange && !!activeConfig && !!selected && isReasoningCapableModel(activeConfig.provider, selected.model)

  let index = -1
  return (
    <div className="model-picker" role="dialog" aria-label={title ?? 'Choose a model'}>
      {title && <div className="model-picker__title">{title}</div>}
      <input
        ref={inputRef}
        type="text"
        className="model-picker__search"
        placeholder="search models…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="model-picker__list" ref={listRef} role="listbox">
        {groups.map((group) => (
          <div key={group.key} className="model-picker__group">
            <div className="label model-picker__group-label">{group.label}</div>
            {group.options.length === 0 && (
              <div className="model-picker__empty">
                {group.key === 'results' ? `no models match "${query}"` : 'no models cached — [refresh] below'}
              </div>
            )}
            {group.options.map((option) => {
              index += 1
              const i = index
              const ref = toRef(option)
              const isSelected =
                selected?.providerConfigId === option.providerConfigId && selected.model === option.modelId
              const starred = isFavoriteModel(favorites, ref)
              return (
                <div
                  key={`${group.key}:${option.providerConfigId}:${option.modelId}`}
                  data-index={i}
                  role="option"
                  aria-selected={isSelected}
                  className={`model-picker__row${i === highlighted ? ' is-highlighted' : ''}${isSelected ? ' is-selected' : ''}`}
                  onMouseEnter={() => setHighlighted(i)}
                  onClick={() => onSelect(option)}
                >
                  <span className="model-picker__row-name">{option.label}</span>
                  <span className="model-picker__row-meta">
                    {group.key === 'fav' || group.key === 'recent' || group.key === 'results'
                      ? PROVIDER_LABELS[option.provider]
                      : option.modelId !== option.label
                        ? option.modelId
                        : ''}
                  </span>
                  <button
                    type="button"
                    className={`model-picker__star${starred ? ' is-starred' : ''}`}
                    aria-label={starred ? `Unstar ${option.label}` : `Star ${option.label}`}
                    title={starred ? 'remove from favorites' : 'add to favorites'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onToggleFavorite(ref)
                    }}
                  >
                    {starred ? '★' : '☆'}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {showEffort && onEffortChange && (
        <div className="model-picker__section">
          <div className="label">thinking effort</div>
          <div className="segmented">
            <button
              type="button"
              className={effort === null ? 'is-active' : ''}
              onClick={() => onEffortChange(null)}
            >
              off
            </button>
            {REASONING_EFFORT_VALUES.map((value) => (
              <button
                key={value}
                type="button"
                className={effort === value ? 'is-active' : ''}
                onClick={() => onEffortChange(value)}
              >
                {EFFORT_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      )}

      {onCustomModel && (
        <div className="model-picker__section model-picker__custom">
          <input
            type="text"
            placeholder="custom model id…"
            value={customModelId}
            onChange={(e) => setCustomModelId(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customModelId.trim()) {
                e.preventDefault()
                onCustomModel(customModelId.trim())
              }
              if (e.key === 'Escape') onClose()
            }}
          />
          <button
            type="button"
            className="link-action"
            disabled={!customModelId.trim()}
            onClick={() => onCustomModel(customModelId.trim())}
          >
            [use]
          </button>
          {activeConfig && onRefreshModels && (
            <button
              type="button"
              className="link-action"
              disabled={refreshingIds?.has(activeConfig.id)}
              onClick={() => onRefreshModels(activeConfig.id)}
            >
              {refreshingIds?.has(activeConfig.id) ? '[refreshing…]' : '[refresh]'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function toRef(option: ModelPickerOption): ModelRef {
  return { providerConfigId: option.providerConfigId, model: option.modelId }
}
