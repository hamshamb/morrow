import type { AgentRunDetail, PermissionDecision, PermissionRequest, ToolRun } from '@ai-workspace/shared'
import { RUN_STATUS_TEXT, runNeedsAttention, totalChanges, type LiveAgent } from '../../lib/agent-ui'
import { ActivityRow } from './ActivityRow'
import { PermissionPrompt } from './PermissionPrompt'
import { RunReportView } from './RunReportView'

interface CommonProps {
  agentName: (agentId: string) => string
  permissions: PermissionRequest[]
  onRespond: (requestId: string, decision: PermissionDecision) => Promise<unknown>
}

function Rows({ rows, outputs, permissions, onRespond }: { rows: ToolRun[]; outputs: Record<string, string>; permissions: PermissionRequest[]; onRespond: CommonProps['onRespond'] }) {
  return (
    <div className="agent-rows" role="list">
      {rows.map((row) => {
        const prompt = permissions.find((p) => p.toolRunId === row.id)
        return (
          <div key={row.id} role="listitem">
            <ActivityRow row={row} liveOutput={outputs[row.id]} defaultOpen={row.toolId === 'terminal.execute' && row.status === 'running'} />
            {prompt && <PermissionPrompt request={prompt} onRespond={onRespond} />}
          </div>
        )
      })}
    </div>
  )
}

/** The activity of a run in progress: header with the step counter, rows as they happen, prompts inline. */
export function LiveAgentBlock({ live, agentName, permissions, onRespond, onStop }: CommonProps & { live: LiveAgent; onStop: () => void }) {
  return (
    <div className="agent-block agent-block--live">
      <header className="agent-block__head">
        <span className="chip chip--inverted">{live.mode}</span>
        <span className="chip chip--outline">{agentName(live.agentId)}</span>
        <span className="muted agent-block__steps">
          step {Math.max(live.step, 1)}/{live.maxSteps}
        </span>
        <span className="agent-block__spacer" />
        <button type="button" className="link-action link-action--danger" onClick={onStop}>
          [stop ■]
        </button>
      </header>
      <Rows rows={live.toolRuns} outputs={live.outputs} permissions={permissions} onRespond={onRespond} />
    </div>
  )
}

/** A finished run's activity, from the audit log. */
export function FinishedAgentBlock({ run, agentName, permissions, onRespond }: CommonProps & { run: AgentRunDetail }) {
  const changed = run.report?.filesChanged ?? []
  const totals = totalChanges(changed)
  return (
    <div className={`agent-block${runNeedsAttention(run.status) ? ' is-attention' : ''}`} data-run-id={run.id} data-status={run.status}>
      <header className="agent-block__head">
        <span className="chip chip--inverted">{run.mode}</span>
        <span className="chip chip--outline">{agentName(run.agentId)}</span>
        <span className="muted agent-block__steps">
          {run.steps} step{run.steps === 1 ? '' : 's'} · {run.toolRuns.length} tool call{run.toolRuns.length === 1 ? '' : 's'}
          {changed.length > 0 ? ` · ${changed.length} file${changed.length === 1 ? '' : 's'} +${totals.added} -${totals.removed}` : ''}
        </span>
        {run.status !== 'completed' && (
          <span className={`chip chip--outline${runNeedsAttention(run.status) ? ' signal' : ''}`}>{RUN_STATUS_TEXT[run.status]}</span>
        )}
      </header>
      <Rows rows={run.toolRuns} outputs={{}} permissions={permissions} onRespond={onRespond} />
    </div>
  )
}

export function ReportBlock({ run, onOpenChanges }: { run: AgentRunDetail; onOpenChanges?: (() => void) | undefined }) {
  if (!run.report) return null
  return <RunReportView report={run.report} onOpenChanges={onOpenChanges} />
}
