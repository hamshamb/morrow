import { diffBars } from '../../lib/code/git-ui'

interface Props {
  additions: number | null
  deletions: number | null
  binary?: boolean
  /** "default" = `+12 -4`; "bars" adds the five-block proportion bar. */
  variant?: 'default' | 'bars'
}

/**
 * The compact `+N -M` change summary shown on every changed file and in the
 * diff header. Adapted from opencode's `diff-changes.tsx` (MIT License,
 * https://github.com/anomalyco/opencode, Copyright (c) 2025 opencode): the two
 * variants (plain counts, proportional bars) and the add/delete coloring. Our
 * additions: nochan tokens (`--ok` / `--signal`, never a fill beyond the bar
 * blocks), binary and unknown states. See docs/OPEN_SOURCE_INVENTORY.md.
 */
export function DiffChanges({ additions, deletions, binary = false, variant = 'default' }: Props) {
  if (binary) return <span className="diff-changes diff-changes--muted">binary</span>
  if (additions === null || deletions === null) return <span className="diff-changes diff-changes--muted">—</span>
  return (
    <span className="diff-changes" aria-label={`${additions} added, ${deletions} removed`}>
      {variant === 'bars' && (
        <span className="diff-changes__bars" aria-hidden="true">
          {diffBars(additions, deletions).map((block, i) => (
            <span key={i} className={`diff-changes__block diff-changes__block--${block}`} />
          ))}
        </span>
      )}
      <span className="diff-changes__add">+{additions}</span>
      <span className="diff-changes__del">-{deletions}</span>
    </span>
  )
}
