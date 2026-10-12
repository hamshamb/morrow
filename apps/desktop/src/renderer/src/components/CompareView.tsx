import type { ReactNode } from 'react'
import { totalEstimatedCost, replyStats, type ReplyView } from '../lib/orchestration-ui'
import { CopyAction, ErrorLine, InContextChip, ModelChip, ReplyBody } from './ReplyParts'

export interface CompareColumn extends ReplyView {
  /** Present while the column is live: its own stream / cancel key. */
  requestId?: string
}

interface Props {
  columns: CompareColumn[]
  /** The compare call is still running. */
  live: boolean
  modelName: (modelId: string) => string
  onChoose: (messageId: string) => void
  onRetry: (messageId: string) => void
  onSwitchModel: (messageId: string) => void
  onCancelColumn: (requestId: string) => void
  onStopAll: () => void
  /** A model picker opened by a column's `[switch model]`. */
  columnPicker: { messageId: string; node: ReactNode } | null
}

function statusOf(column: CompareColumn): { text: string; tone: 'muted' | 'signal' } {
  switch (column.phase) {
    case 'waiting':
      return { text: 'waiting…', tone: 'muted' }
    case 'streaming':
      return { text: 'streaming…', tone: 'muted' }
    case 'error':
      return { text: 'failed', tone: 'signal' }
    case 'cancelled':
      return { text: ['stopped', replyStats(column)].filter(Boolean).join(' · '), tone: 'muted' }
    case 'done':
      return { text: replyStats(column), tone: 'muted' }
  }
}

/**
 * COMPARE: one prompt, 2-4 models, side by side. Equal-width columns that
 * scroll independently; each header carries the model chip and status (latency,
 * usage, estimated cost); the column later turns continue from wears an
 * inverted IN CONTEXT chip and the others are dimmed with `[continue with this]`.
 * Rules, not cards: a heavy top rule, hairlines between columns.
 */
export function CompareView({
  columns,
  live,
  modelName,
  onChoose,
  onRetry,
  onSwitchModel,
  onCancelColumn,
  onStopAll,
  columnPicker,
}: Props) {
  const anyInContext = columns.some((c) => c.inContext)
  return (
    <section className="compare" aria-label="Model comparison">
      <header className="compare__bar">
        <span className="label">compare</span>
        <span className="muted">{columns.length} models</span>
        <span className="compare__bar-spacer" />
        <span className="muted" title="sum of the estimates that have a price">
          {totalEstimatedCost(columns)}
        </span>
        {live && (
          <button type="button" className="link-action" onClick={onStopAll}>
            [stop all]
          </button>
        )}
      </header>
      <div className="compare__grid" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(var(--compare-col-min), 1fr))` }}>
        {columns.map((column) => {
          const status = statusOf(column)
          const chosen = column.inContext
          const failed = column.phase === 'error'
          const running = column.phase === 'streaming' || column.phase === 'waiting'
          return (
            <article
              key={column.key}
              className={`compare-col${chosen ? ' is-chosen' : ''}${anyInContext && !chosen ? ' is-dim' : ''}${failed ? ' is-failed' : ''}`}
            >
              <header className="compare-col__head">
                <ModelChip provider={column.provider} label={column.model ? modelName(column.model) : 'unknown'} />
                {chosen && <InContextChip />}
              </header>
              <div className={`compare-col__status${status.tone === 'signal' ? ' signal' : ''}`}>
                <span>{status.text}</span>
                {live && running && column.requestId && (
                  <button type="button" className="link-action" onClick={() => onCancelColumn(column.requestId as string)}>
                    [stop]
                  </button>
                )}
              </div>
              <div className="compare-col__body">
                {failed ? (
                  column.messageId ? (
                    <>
                      {column.text && <ReplyBody view={column} />}
                      <ErrorLine
                        error={column.errorText}
                        onRetry={() => onRetry(column.messageId as string)}
                        onSwitchModel={() => onSwitchModel(column.messageId as string)}
                      />
                      {columnPicker?.messageId === column.messageId && columnPicker.node}
                    </>
                  ) : (
                    <p className="signal compare-col__error">{column.errorText ?? 'The request failed.'}</p>
                  )
                ) : (
                  <ReplyBody view={column} />
                )}
              </div>
              {!live && !failed && column.messageId && (
                <footer className="compare-col__actions">
                  {!chosen && (
                    <button type="button" className="link-action" onClick={() => onChoose(column.messageId as string)}>
                      [continue with this]
                    </button>
                  )}
                  <CopyAction text={column.text} />
                </footer>
              )}
            </article>
          )
        })}
      </div>
      {!live && !anyInContext && (
        <p className="compare__note muted">
          No column is in the context — pick one with [continue with this], or retry a failed column.
        </p>
      )}
    </section>
  )
}
