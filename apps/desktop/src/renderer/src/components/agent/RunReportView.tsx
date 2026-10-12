import type { RunReport } from '@ai-workspace/shared'
import { STOPPED_BY_TEXT, formatDuration, reportHasContent, totalChanges } from '../../lib/agent-ui'
import { DiffChanges } from '../git/DiffChanges'

const TEST_CHIP: Record<RunReport['tests']['status'], { text: string; className: string }> = {
  passed: { text: 'PASSED', className: 'chip--inverted' },
  failed: { text: 'FAILED', className: 'chip--outline signal' },
  not_run: { text: 'NOT RUN', className: 'chip--outline' },
  unverified: { text: 'UNVERIFIED', className: 'chip--outline' },
}

/**
 * The run report (ADR-044): facts, built by the app from the audit log and the disk - not written by the model.
 * Each section is a ruled list; the model's own closing remarks are the last section and are labelled as
 * the model's, because nothing there is verified.
 */
export function RunReportView({ report, onOpenChanges }: { report: RunReport; onOpenChanges?: (() => void) | undefined }) {
  if (!reportHasContent(report) && report.tests.status === 'not_run') return null
  const totals = totalChanges(report.filesChanged)
  const test = TEST_CHIP[report.tests.status]
  const testRan = report.tests.status !== 'not_run'

  return (
    <section className="run-report" aria-label="Run report">
      <header className="run-report__head">
        <span className="label">run report</span>
        <span className="muted">
          {report.toolCalls} tool call{report.toolCalls === 1 ? '' : 's'}
          {report.toolErrors > 0 ? ` · ${report.toolErrors} failed` : ''} · {STOPPED_BY_TEXT[report.stoppedBy]}
        </span>
        <span className="muted run-report__source" title="Built by the app from the audit log and the files on disk, not written by the model.">
          from the audit log
        </span>
      </header>

      {report.filesInspected.length > 0 && (
        <div className="run-report__section">
          <span className="label">files inspected</span>
          <span className="run-report__value">{report.filesInspected.join(' · ')}</span>
        </div>
      )}

      {report.filesChanged.length > 0 && (
        <div className="run-report__section">
          <span className="label">files changed</span>
          <div className="run-report__value">
            {report.filesChanged.map((file) => (
              <div className="run-report__line" key={file.path}>
                <span className="run-report__path">{file.path}</span>
                {file.kind === 'created' && <span className="chip chip--outline">new</span>}
                <DiffChanges additions={file.added} deletions={file.removed} />
                {file.reverted ? (
                  <span className="muted">reverted</span>
                ) : file.verified ? (
                  <span className="ok" title="Re-read from disk after the run: it matches the agent's last write.">
                    ✓ verified on disk
                  </span>
                ) : (
                  <span className="signal" title={file.note ?? undefined}>
                    ! not verified{file.note ? ` — ${file.note}` : ''}
                  </span>
                )}
              </div>
            ))}
            <div className="run-report__line muted">
              total +{totals.added} -{totals.removed}
              {onOpenChanges && (
                <button type="button" className="link-action" onClick={onOpenChanges}>
                  [view changes]
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {report.changedByCommands.length > 0 && (
        <div className="run-report__section">
          <span className="label">changed by commands</span>
          <span className="run-report__value">
            {report.changedByCommands.join(' · ')}
            <span className="muted"> — made by a command, not by an edit tool; not tracked for revert (see /git)</span>
          </span>
        </div>
      )}

      {report.commands.length > 0 && (
        <div className="run-report__section">
          <span className="label">commands executed</span>
          <div className="run-report__value">
            {report.commands.map((c, index) => (
              <div className="run-report__line" key={index}>
                <code className="run-report__command">{c.command}</code>
                <span className={c.exitCode === 0 ? 'ok' : c.exitCode === null ? 'muted' : 'signal'}>
                  {c.exitCode === null ? (c.note ?? 'no exit code') : `exit ${c.exitCode}`}
                </span>
                {c.durationMs !== null && <span className="muted">{formatDuration(c.durationMs)}</span>}
                {c.isTest && <span className="chip chip--outline">test</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="run-report__section">
        <span className="label">tests</span>
        <span className="run-report__value">
          <span className={`chip ${test.className}`}>{test.text}</span>{' '}
          <span className={testRan && report.tests.status === 'failed' ? 'signal' : 'muted'}>{report.tests.detail}</span>
          {report.tests.command && <code className="run-report__command"> {report.tests.command}</code>}
        </span>
      </div>

      {report.refused.length > 0 && (
        <div className="run-report__section">
          <span className="label">not done</span>
          <div className="run-report__value">
            {report.refused.map((r, index) => (
              <div className="run-report__line" key={index}>
                <span>{r.label}</span>
                <span className="muted">{r.reason}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="run-report__section run-report__section--model">
        <span className="label" title="Written by the model. The app cannot verify it.">
          remaining concerns · model&rsquo;s words
        </span>
        <span className="run-report__value muted">{report.modelConcerns ?? 'none stated by the model'}</span>
      </div>
    </section>
  )
}
