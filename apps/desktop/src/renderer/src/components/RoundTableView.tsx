import { totalEstimatedCost, type ReplyView } from '../lib/orchestration-ui'
import { CopyAction, InContextChip, ModelChip, ReplyBody, RoleChip, StatsLine } from './ReplyParts'

interface Props {
  turns: ReplyView[]
  /** Rounds the table was set up with (the header shows `round n/N`). */
  rounds: number
  /** Planned number of turns; undefined for a finished, persisted table. */
  totalSteps?: number
  live: boolean
  modelName: (modelId: string) => string
  onChoose: (messageId: string) => void
  onStop: () => void
}

/**
 * ROUND TABLE: a vertical transcript of labelled turns (PROPOSAL, CRITIQUE,
 * ALTERNATIVE, SYNTHESIS). The header names the participants in turn order and
 * the round counter; `[stop]` ends the whole table. The turn later messages
 * continue from (the synthesis, else the last turn) carries IN CONTEXT.
 */
export function RoundTableView({ turns, rounds, totalSteps, live, modelName, onChoose, onStop }: Props) {
  const participants: { key: string; provider: string | null; model: string | null }[] = []
  for (const turn of turns) {
    if (turn.roleLabel === 'synthesis') continue
    const key = `${turn.provider}:${turn.model}`
    if (!participants.some((p) => p.key === key)) participants.push({ key, provider: turn.provider, model: turn.model })
  }
  const currentRound = turns.reduce((max, t) => Math.max(max, t.round ?? 0), 0)
  const shownRound = Math.min(Math.max(currentRound, 1), rounds)
  const synth = turns.find((t) => t.roleLabel === 'synthesis')

  return (
    <section className="round-table" aria-label="Round table">
      <header className="round-table__bar">
        <span className="label">round table</span>
        <span className="round-table__people">
          {participants.map((p, index) => (
            <span key={p.key} className="round-table__person">
              {index > 0 && <span className="round-table__arrow">→</span>}
              <ModelChip provider={p.provider} label={p.model ? modelName(p.model) : 'unknown'} />
            </span>
          ))}
          {synth && (
            <span className="round-table__person">
              <span className="round-table__arrow">⇒</span>
              <ModelChip provider={synth.provider} label={synth.model ? modelName(synth.model) : 'unknown'} />
            </span>
          )}
        </span>
        <span className="compare__bar-spacer" />
        <span className="muted">
          round {shownRound}/{rounds}
          {totalSteps ? ` · turn ${Math.min(turns.length, totalSteps)}/${totalSteps}` : ''}
        </span>
        <span className="muted">{totalEstimatedCost(turns)}</span>
        {live && (
          <button type="button" className="link-action" onClick={onStop}>
            [stop]
          </button>
        )}
      </header>
      <ol className="round-table__turns">
        {turns.map((turn) => (
          <li key={turn.key} className={`rt-turn${turn.inContext ? ' is-chosen' : ''}`}>
            <header className="rt-turn__head">
              {turn.roleLabel && <RoleChip role={turn.roleLabel} />}
              <ModelChip provider={turn.provider} label={turn.model ? modelName(turn.model) : 'unknown'} />
              {turn.round !== null && turn.roleLabel !== 'synthesis' && <span className="muted">round {turn.round}</span>}
              {turn.phase === 'done' && <StatsLine view={turn} />}
              {turn.phase === 'streaming' && <span className="muted">writing…</span>}
              {turn.phase === 'cancelled' && <span className="muted">stopped</span>}
              {turn.inContext && turn.phase !== 'streaming' && <InContextChip />}
            </header>
            {turn.phase === 'error' ? (
              <p className="signal">{turn.errorText ?? 'The request failed.'} The table stopped here.</p>
            ) : (
              <ReplyBody view={turn} />
            )}
            {!live && turn.messageId && turn.phase !== 'error' && turn.text && (
              <div className="rt-turn__actions">
                {!turn.inContext && (
                  <button type="button" className="link-action" onClick={() => onChoose(turn.messageId as string)}>
                    [continue with this]
                  </button>
                )}
                <CopyAction text={turn.text} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  )
}
