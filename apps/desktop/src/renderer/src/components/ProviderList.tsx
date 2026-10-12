import { useEffect, useMemo, useRef, useState } from 'react'
import type { LocalProviderStatus, ProviderRegistryEntry } from '@ai-workspace/shared'
import { matchesSearch } from '../lib/search-match'

interface Props {
  entries: ProviderRegistryEntry[]
  local: Record<string, LocalProviderStatus>
  /** True until the registry has been read from the main process. */
  loading?: boolean
  detectingLocal?: boolean
  onRecheckLocal?: () => void
  /** Provider ids that already have a saved key (shown as `connected`). */
  connectedIds?: ReadonlySet<string>
  selectedId: string | null
  onSelect: (id: string) => void
  autoFocus?: boolean
}

function detailFor(entry: ProviderRegistryEntry, status: LocalProviderStatus | undefined): string {
  if (entry.kind === 'custom') return 'any OpenAI-compatible server · you supply the URL'
  if (entry.isLocal) {
    if (status?.running) {
      return `${status.modelCount} model${status.modelCount === 1 ? '' : 's'} installed · no key needed`
    }
    return 'no key needed'
  }
  return entry.modelCount > 0 ? `${entry.modelCount} models` : ''
}

/**
 * Searchable list of every provider the registry can run — popular ones
 * first, then the rest alphabetically, Ollama marked `local · detected` /
 * `local · not running`, and the custom endpoint last. Rules between rows,
 * inverted row for the selection, outline tags (nochan).
 */
export function ProviderList({
  entries,
  local,
  loading,
  detectingLocal,
  onRecheckLocal,
  connectedIds,
  selectedId,
  onSelect,
  autoFocus,
}: Props) {
  const [query, setQuery] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep the chosen provider visible (a pasted key can select a row far down).
  useEffect(() => {
    if (!selectedId) return
    scrollRef.current
      ?.querySelector(`[data-provider="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const { popular, rest, custom } = useMemo(() => {
    const matching = entries.filter((e) => matchesSearch(query, [e.name, e.id]))
    return {
      popular: matching.filter((e) => e.popularRank !== null),
      rest: matching.filter((e) => e.popularRank === null && e.kind !== 'custom'),
      custom: matching.filter((e) => e.kind === 'custom'),
    }
  }, [entries, query])

  const searching = query.trim().length > 0

  function renderRow(entry: ProviderRegistryEntry) {
    const status = local[entry.id]
    const connected = connectedIds?.has(entry.id) ?? false
    return (
      <button
        key={entry.id}
        type="button"
        role="option"
        aria-selected={selectedId === entry.id}
        data-provider={entry.id}
        className={`provider-list__row${selectedId === entry.id ? ' is-active' : ''}`}
        onClick={() => onSelect(entry.id)}
      >
        <span className="provider-list__name">{entry.name}</span>
        {entry.isLocal && (
          <span className={`chip chip--outline provider-list__tag${status?.running ? ' is-ok' : ''}`}>
            {status?.running ? 'local · detected' : 'local · not running'}
          </span>
        )}
        {entry.kind === 'custom' && <span className="chip chip--outline provider-list__tag">custom</span>}
        {connected && <span className="provider-list__connected">connected</span>}
        <span className="provider-list__detail">{detailFor(entry, status)}</span>
      </button>
    )
  }

  const total = popular.length + rest.length + custom.length

  return (
    <div className="provider-list">
      <div className="provider-list__search">
        <input
          type="text"
          className="provider-list__input"
          placeholder={entries.length > 0 ? `search ${entries.length} providers…` : 'search providers…'}
          value={query}
          autoFocus={autoFocus}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search providers"
        />
        {onRecheckLocal && (
          <button type="button" className="link-action" onClick={onRecheckLocal} disabled={detectingLocal}>
            {detectingLocal ? '[checking…]' : '[recheck local]'}
          </button>
        )}
      </div>
      <div className="provider-list__scroll" role="listbox" aria-label="Providers" ref={scrollRef}>
        {total === 0 && loading && <p className="muted provider-list__empty">loading providers…</p>}
        {total === 0 && !loading && (
          <p className="muted provider-list__empty">no provider matches &ldquo;{query}&rdquo;</p>
        )}
        {popular.length > 0 && (
          <>
            {!searching && <div className="label provider-list__group">popular</div>}
            {popular.map(renderRow)}
          </>
        )}
        {rest.length > 0 && (
          <>
            {!searching && <div className="label provider-list__group">all providers</div>}
            {rest.map(renderRow)}
          </>
        )}
        {custom.length > 0 && (
          <>
            {!searching && <div className="label provider-list__group">other</div>}
            {custom.map(renderRow)}
          </>
        )}
      </div>
    </div>
  )
}
