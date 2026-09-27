import type { ContextInspectorState, ContextSource } from '@ai-workspace/shared'

interface Props {
  inspector: ContextInspectorState | null
  loading: boolean
  excludedIds: Set<string>
  onToggle: (sourceId: string) => void
}

function sourceIcon(type: ContextSource['type']): string {
  switch (type) {
    case 'conversation-history':
      return '💬'
    case 'attachment':
      return '📎'
    case 'workspace-file':
      return '📄'
    case 'retrieval-snippet':
      return '🔎'
  }
}

/**
 * Pure presentational view of "what will actually be sent to the provider
 * for the next message" — the Context Inspector required by Phase 3. Every
 * source is individually toggleable; `ChatPanel` resolves the final
 * `ContextSelection` sent with the message from exactly this toggle state,
 * so this panel gates the request rather than just describing it.
 */
export function ContextInspectorView({ inspector, loading, excludedIds, onToggle }: Props) {
  if (!inspector) {
    return <p className="context-inspector__empty">{loading ? 'Loading context…' : 'No context yet.'}</p>
  }

  return (
    <div className="context-inspector">
      <ul className="context-inspector__sources">
        {inspector.sources.map((source) => {
          const included = !excludedIds.has(source.id)
          return (
            <li key={source.id} className="context-inspector__source">
              <label>
                <input
                  type="checkbox"
                  checked={included}
                  onChange={() => onToggle(source.id)}
                  disabled={source.type === 'conversation-history' && source.characterCount === 0}
                />
                <span className="context-inspector__icon">{sourceIcon(source.type)}</span>
                <span className="context-inspector__label">{source.label}</span>
                {source.detail && <span className="context-inspector__detail"> — {source.detail}</span>}
                <span className="context-inspector__tokens">
                  ~{source.estimatedTokens} tok
                  {source.exceedsBudget && included ? ' (over budget, may be dropped)' : ''}
                </span>
              </label>
            </li>
          )
        })}
      </ul>
      <div className="context-inspector__total">
        Estimated total: ~{inspector.totalEstimatedTokens} tokens ({inspector.totalCharacterCount.toLocaleString()}{' '}
        chars) — estimate only (chars ÷ 4), not a real tokenizer.
      </div>
    </div>
  )
}
