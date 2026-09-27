import type { ContextInspectorState, ContextSource } from '@ai-workspace/shared'
import { ChatIcon, FileIcon, PaperclipIcon, SearchIcon } from './icons'

interface Props {
  inspector: ContextInspectorState | null
  loading: boolean
  excludedIds: Set<string>
  onToggle: (sourceId: string) => void
}

function SourceIcon({ type }: { type: ContextSource['type'] }) {
  switch (type) {
    case 'conversation-history':
      return <ChatIcon />
    case 'attachment':
      return <PaperclipIcon />
    case 'workspace-file':
      return <FileIcon />
    case 'retrieval-snippet':
      return <SearchIcon />
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
              <input
                type="checkbox"
                checked={included}
                onChange={() => onToggle(source.id)}
                disabled={source.type === 'conversation-history' && source.characterCount === 0}
              />
              <span className="context-inspector__icon">
                <SourceIcon type={source.type} />
              </span>
              <span className="context-inspector__label">{source.label}</span>
              <span className="context-inspector__detail">{source.detail ?? ''}</span>
              <span className="context-inspector__tokens">
                ~{source.estimatedTokens} tok
                {source.exceedsBudget && included ? ' · over budget' : ''}
              </span>
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
