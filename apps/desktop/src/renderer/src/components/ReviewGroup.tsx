import { formatRelativeTime } from '../lib/time'
import type { ReplyView } from '../lib/orchestration-ui'
import { CopyAction, ErrorLine, InContextChip, ModelChip, ReplyBody, RoleChip, StatsLine } from './ReplyParts'

interface Props {
  /** The primary model's answer — shown exactly as written. */
  primary: ReplyView | null
  reviews: ReplyView[]
  /** `[apply suggestions]` results: new sibling replies, never edits. */
  revisions: ReplyView[]
  modelName: (modelId: string) => string
  /** Timestamp of the primary answer, for the meta line. */
  primaryCreatedAt: number | null
  /** The review (or revision) currently being written, if any. */
  liveBlock: ReplyView | null
  busy: boolean
  onChoose: (messageId: string) => void
  onApplySuggestions: (reviewMessageId: string) => void
  onRetryReview: () => void
  onStop: () => void
}

/**
 * REVIEW: the answer, then a ruled-off, labelled block with the reviewer's
 * report. The answer above is never rewritten; `[apply suggestions]` asks the
 * primary model for a revision that arrives as its own block below.
 */
export function ReviewGroup({
  primary,
  reviews,
  revisions,
  modelName,
  primaryCreatedAt,
  liveBlock,
  busy,
  onChoose,
  onApplySuggestions,
  onRetryReview,
  onStop,
}: Props) {
  return (
    <div className="review-group">
      {primary && (
        <article className="assistant-message">
          <header className="assistant-message__meta">
            <ModelChip provider={primary.provider} label={primary.model ? modelName(primary.model) : 'unknown'} />
            {primaryCreatedAt !== null && (
              <span className="assistant-message__time">{formatRelativeTime(primaryCreatedAt)}</span>
            )}
            {primary.phase === 'streaming' && <span className="assistant-message__time">writing…</span>}
            {primary.phase === 'cancelled' && <span className="assistant-message__status">stopped</span>}
            {primary.inContext && primary.phase !== 'streaming' && <InContextChip />}
          </header>
          {primary.phase === 'error' ? (
            <p className="signal">{primary.errorText ?? 'The request failed.'}</p>
          ) : (
            <ReplyBody view={primary} />
          )}
          {primary.phase !== 'streaming' && primary.text && (
            <div className="message-actions is-pinned">
              <CopyAction text={primary.text} />
            </div>
          )}
        </article>
      )}

      {reviews.map((review) => (
        <ReviewBlock
          key={review.key}
          view={review}
          label="review"
          modelName={modelName}
          note="the answer above is unchanged"
          actions={
            review.phase === 'done' && review.messageId ? (
              <>
                <button
                  type="button"
                  className="link-action"
                  disabled={busy}
                  onClick={() => onApplySuggestions(review.messageId as string)}
                  title="ask the answering model for a revised answer, added below as a new reply"
                >
                  [apply suggestions]
                </button>
                <CopyAction text={review.text} />
              </>
            ) : null
          }
          error={
            review.phase === 'error' || review.phase === 'cancelled' ? (
              <ErrorLine
                error={review.phase === 'cancelled' ? 'The review was stopped.' : review.errorText}
                onRetry={onRetryReview}
                retryLabel="[retry review]"
              />
            ) : null
          }
        />
      ))}

      {revisions.map((revision) => (
        <ReviewBlock
          key={revision.key}
          view={revision}
          label="revision"
          modelName={modelName}
          note="a new reply — the original answer is untouched"
          actions={
            revision.messageId && revision.phase === 'done' ? (
              <>
                {!revision.inContext && (
                  <button type="button" className="link-action" onClick={() => onChoose(revision.messageId as string)}>
                    [continue with this]
                  </button>
                )}
                <CopyAction text={revision.text} />
              </>
            ) : null
          }
          error={revision.phase === 'error' ? <p className="signal">{revision.errorText ?? 'The request failed.'}</p> : null}
        />
      ))}

      {liveBlock && (
        <ReviewBlock
          view={liveBlock}
          label={liveBlock.roleLabel === 'revision' ? 'revision' : 'review'}
          modelName={modelName}
          note={liveBlock.roleLabel === 'revision' ? 'a new reply — the original answer is untouched' : 'the answer above is unchanged'}
          actions={
            <button type="button" className="link-action" onClick={onStop}>
              [stop]
            </button>
          }
          error={null}
        />
      )}
    </div>
  )
}

function ReviewBlock({
  view,
  label,
  modelName,
  note,
  actions,
  error,
}: {
  view: ReplyView
  label: 'review' | 'revision'
  modelName: (modelId: string) => string
  note: string
  actions: React.ReactNode
  error: React.ReactNode
}) {
  return (
    <section className={`review-block review-block--${label}`} aria-label={label === 'review' ? 'Review' : 'Revised answer'}>
      <header className="review-block__head">
        <RoleChip role={label === 'review' ? 'review' : 'revision'} />
        <ModelChip provider={view.provider} label={view.model ? modelName(view.model) : 'unknown'} />
        {view.phase === 'done' && <StatsLine view={view} />}
        {view.phase === 'streaming' && <span className="muted">writing…</span>}
        {view.inContext && view.phase === 'done' && <InContextChip />}
      </header>
      <p className="review-block__note">{note}</p>
      {view.phase !== 'error' && <ReplyBody view={view} />}
      {error}
      {actions && <div className="review-block__actions">{actions}</div>}
    </section>
  )
}
