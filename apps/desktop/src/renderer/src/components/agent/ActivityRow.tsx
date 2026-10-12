import { useEffect, useRef, useState } from 'react'
import type { ToolRun } from '@ai-workspace/shared'
import { RISK_TEXT, decisionText, diffLineKind, formatDuration, rowGlyph, rowHasDetails, splitLabel } from '../../lib/agent-ui'

/** A unified diff, one line per row, added/removed tinted (the diff the agent made or is asking to make). */
export function DiffText({ diff, maxHeight }: { diff: string; maxHeight?: number }) {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  return (
    <pre className="agent-diff" style={maxHeight ? { maxHeight } : undefined} aria-label="Diff">
      {lines.map((line, index) => (
        <span key={index} className={`agent-diff__line agent-diff__line--${diffLineKind(line)}`}>
          {line === '' ? ' ' : line}
        </span>
      ))}
    </pre>
  )
}

interface Props {
  row: ToolRun
  /** Output streamed so far (commands only); stored detail is used once it finishes. */
  liveOutput?: string | undefined
  /** Open by default (a running command shows its output). */
  defaultOpen?: boolean
}

/**
 * One compact activity row (OpenCode's tool-row pattern, in nochan's mono language):
 *   ● read src/x.ts            12 lines
 *   ● patch src/x.ts           +12 -4        [details]
 *   ✓ run pnpm test            exit 0 · 4.3s
 * Closed by default; a row that has a diff, command output or a reason expands. The
 * model's raw tool JSON is never shown.
 */
export function ActivityRow({ row, liveOutput, defaultOpen = false }: Props) {
  const [open, setOpen] = useState(defaultOpen)
  const { title, subtitle } = splitLabel(row)
  const { glyph, tone } = rowGlyph(row)
  const expandable = rowHasDetails(row, liveOutput)
  const running = row.status === 'running' || row.status === 'pending'
  const isCommand = row.toolId === 'terminal.execute'
  // A command that starts running opens itself once, so its output is visible as it arrives (you can still close it).
  const autoOpened = useRef(false)
  useEffect(() => {
    if (isCommand && row.status === 'running' && !autoOpened.current) {
      autoOpened.current = true
      setOpen(true)
    }
  }, [isCommand, row.status])
  const body = isCommand ? (liveOutput && running ? liveOutput : (row.detail ?? liveOutput ?? '')) : (row.detail ?? '')
  const isDiff = row.toolId === 'filesystem.patch' || row.toolId === 'filesystem.write' || row.toolId === 'git.diff'

  return (
    <div className={`agent-row agent-row--${tone}${open ? ' is-open' : ''}`} data-tool-id={row.toolId} data-status={row.status}>
      <button
        type="button"
        className="agent-row__line"
        onClick={() => expandable && setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        title={row.label}
      >
        <span className={`agent-row__glyph${running ? ' is-pulsing' : ''}`} aria-hidden="true">
          {glyph}
        </span>
        <span className="agent-row__title">{title}</span>
        <span className="agent-row__subtitle">{subtitle}</span>
        <span className="agent-row__summary">{row.summary}</span>
        {expandable && (
          <span className="agent-row__chevron" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        )}
      </button>
      {open && expandable && (
        <div className="agent-row__details">
          <div className="agent-row__meta">
            <span className="chip chip--outline">{RISK_TEXT[row.risk]}</span>
            {row.decisionSource && <span>{decisionText(row.decisionSource)}</span>}
            {row.durationMs !== null && <span>{formatDuration(row.durationMs)}</span>}
          </div>
          {body !== '' &&
            (isDiff ? (
              <DiffText diff={body} maxHeight={320} />
            ) : (
              <pre className="agent-output" aria-label="Output">
                {body}
              </pre>
            ))}
          {body === '' && (row.status === 'denied' || row.status === 'error') && <p className="agent-row__reason">{row.summary}</p>}
        </div>
      )}
    </div>
  )
}
