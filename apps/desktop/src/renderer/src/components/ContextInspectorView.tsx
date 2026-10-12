import type { ContextInspectorState, ContextSource } from '@ai-workspace/shared'
import { contextBudget, formatTokens, type ContextBudget } from '../lib/model-meta'
import { ChatIcon, FileIcon, PaperclipIcon, SearchIcon } from './icons'

interface Props {
  inspector: ContextInspectorState | null
  loading: boolean
  excludedIds: Set<string>
  onToggle: (sourceId: string) => void
  /** The selected model's context window in tokens (models.dev `limit.context`); null = unknown. */
  contextLimit: number | null
  modelName: string | null
}

function BudgetNote({ budget, modelName }: { budget: ContextBudget; modelName: string | null }) {
  const pct = budget.ratio === null ? null : Math.min(100, Math.round(budget.ratio * 100))
  switch (budget.level) {
    case 'unknown':
      return <>context window unknown{modelName ? ` for ${modelName}` : ''}</>
    case 'over':
      return <>over the window ({pct}%) — the provider will reject this; uncheck sources or start a new session</>
    case 'warn':
      return <>{pct}% of {modelName ?? 'the'} window — close to the limit; uncheck sources to make room</>
    default:
      return <>{pct}% of {modelName ?? 'the model'}&rsquo;s window</>
  }
}

/** Estimated prompt tokens against the model's window — the Context panel's budget. */
function Budget({
  inspector,
  excludedIds,
  contextLimit,
  modelName,
}: {
  inspector: ContextInspectorState | null
  excludedIds: Set<string>
  contextLimit: number | null
  modelName: string | null
}) {
  const used = inspector
    ? inspector.sources.reduce((sum, s) => (excludedIds.has(s.id) ? sum : sum + s.estimatedTokens), 0)
    : 0
  const budget = contextBudget(used, contextLimit)
  const width = budget.ratio === null ? 0 : Math.min(100, Math.max(budget.ratio * 100, used > 0 ? 1 : 0))
  return (
    <div className={`context-budget context-budget--${budget.level}`} role="group" aria-label="Context budget">
      <div className="context-budget__row">
        <span className="label">budget</span>
        <span className="context-budget__figure">{budget.label}</span>
      </div>
      {budget.level !== 'unknown' && (
        <div
          className="context-budget__meter"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={budget.limit ?? 0}
          aria-valuenow={budget.usedTokens}
        >
          <span style={{ width: `${width}%` }} />
        </div>
      )}
      <div className="context-budget__note">
        <BudgetNote budget={budget} modelName={modelName} />
      </div>
    </div>
  )
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
export function ContextInspectorView({ inspector, loading, excludedIds, onToggle, contextLimit, modelName }: Props) {
  if (!inspector) {
    return (
      <div className="context-inspector">
        <Budget inspector={null} excludedIds={excludedIds} contextLimit={contextLimit} modelName={modelName} />
        <p className="context-inspector__empty muted">
          {loading ? 'loading context…' : 'Nothing to send yet. Start typing — history, attachments and relevant files appear here.'}
        </p>
      </div>
    )
  }

  const onlyHistory = inspector.sources.every((s) => s.type === 'conversation-history')

  return (
    <div className="context-inspector">
      <Budget inspector={inspector} excludedIds={excludedIds} contextLimit={contextLimit} modelName={modelName} />
      {onlyHistory && (
        <p className="context-inspector__empty muted">
          Only the conversation history is sent. Attach a file with <kbd>+</kbd>, or add a workspace file,
          and it shows up here — uncheck anything to leave it out.
        </p>
      )}
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
                ~{formatTokens(source.estimatedTokens)} tok
                {source.exceedsBudget && included ? ' · over budget' : ''}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="context-inspector__total">
        {inspector.totalCharacterCount.toLocaleString()} chars · token counts are an estimate (chars ÷ 4), not a
        real tokenizer
      </div>
    </div>
  )
}
