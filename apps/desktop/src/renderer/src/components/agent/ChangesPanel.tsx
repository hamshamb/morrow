import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import type { AgentFileDiff, AgentRunDetail, ChangedFile, RevertResult } from '@ai-workspace/shared'
import { totalChanges, type LiveAgent } from '../../lib/agent-ui'
import { ConfirmAction } from '../ConfirmAction'
import { DiffChanges } from '../git/DiffChanges'

const DiffViewer = lazy(() => import('../git/DiffViewer'))

interface Props {
  /** Persisted runs of the open conversation, oldest first. */
  runs: AgentRunDetail[]
  /** The run in progress (its edits show up as they happen; it cannot be reverted until it ends). */
  live: LiveAgent | null
  onClose: () => void
  /** Open the file in the code editor. */
  onOpenFile: (path: string) => void
}

interface RunChanges {
  runId: string
  title: string
  active: boolean
  files: ChangedFile[]
}

const runHasEdits = (rows: { toolId: string; status: string }[]): boolean =>
  rows.some((r) => (r.toolId === 'filesystem.write' || r.toolId === 'filesystem.patch') && r.status === 'ok')

/**
 * The Changes view of a conversation's agent runs: every file a run changed with +N -M, its diff (Monaco's diff
 * editor, fed the pre-run text and the file as it is now), `[revert file]` and `[revert all]`. A revert restores the
 * exact bytes from before the run and refuses a file you edited since unless you confirm; the same edits also show up
 * in /git because they are ordinary working-tree changes.
 */
export function ChangesPanel({ runs, live, onClose, onOpenFile }: Props) {
  const [groups, setGroups] = useState<RunChanges[]>([])
  const [selected, setSelected] = useState<{ runId: string; path: string } | null>(null)
  const [diff, setDiff] = useState<AgentFileDiff | null>(null)
  const [note, setNote] = useState<{ tone: 'ok' | 'signal'; text: string } | null>(null)
  const [forceFor, setForceFor] = useState<{ runId: string; path: string | null } | null>(null)
  const [tick, setTick] = useState(0)

  const liveEdits = live ? live.toolRuns.filter((r) => (r.toolId === 'filesystem.write' || r.toolId === 'filesystem.patch') && r.status === 'ok').length : 0
  const runKey = runs.map((r) => `${r.id}:${r.status}:${r.toolRuns.length}`).join('|')

  useEffect(() => {
    let cancelled = false
    const candidates: { id: string; title: string; active: boolean }[] = []
    runs.forEach((run, index) => {
      if (runHasEdits(run.toolRuns)) candidates.push({ id: run.id, title: `run ${index + 1}`, active: false })
    })
    if (live && liveEdits > 0) candidates.push({ id: live.runId, title: 'run in progress', active: true })
    void Promise.all(
      candidates.map(async (c) => ({
        runId: c.id,
        title: c.title,
        active: c.active,
        files: await window.api.agent.changes(c.id).catch(() => [] as ChangedFile[]),
      })),
    ).then((result) => {
      if (!cancelled) setGroups(result.filter((g) => g.files.length > 0))
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runKey/liveEdits/tick summarise the inputs
  }, [runKey, live?.runId, liveEdits, tick])

  useEffect(() => {
    if (!selected) {
      setDiff(null)
      return
    }
    let cancelled = false
    void window.api.agent
      .fileDiff(selected.runId, selected.path)
      .then((result) => {
        if (!cancelled) setDiff(result)
      })
      .catch(() => {
        if (!cancelled) setDiff({ status: 'unavailable', path: selected.path, message: 'Could not load the diff.' })
      })
    return () => {
      cancelled = true
    }
  }, [selected, tick])

  const describe = (result: RevertResult): void => {
    if (result.skipped.length > 0) {
      const first = result.skipped[0]
      setNote({ tone: 'signal', text: `${result.reverted.length} reverted · ${result.skipped.length} left alone: ${first?.path} — ${first?.reason}` })
      const needsForce = result.skipped.filter((s) => s.changedSince)
      if (needsForce.length > 0 && selected) setForceFor({ runId: selected.runId, path: needsForce.length === 1 ? needsForce[0]!.path : null })
    } else {
      setNote({ tone: 'ok', text: result.reverted.length > 0 ? `reverted ${result.reverted.join(', ')}` : 'nothing to revert' })
      setForceFor(null)
    }
    setTick((t) => t + 1)
  }

  const revert = useCallback(
    async (runId: string, path: string | undefined, force = false) => {
      try {
        const result = await window.api.agent.revert({ runId, ...(path ? { path } : {}), ...(force ? { force: true } : {}) })
        if (result.skipped.some((s) => s.changedSince) && !force) {
          const first = result.skipped.find((s) => s.changedSince)
          setForceFor({ runId, path: path ?? first?.path ?? null })
        }
        describe(result)
      } catch (err) {
        setNote({ tone: 'signal', text: err instanceof Error ? err.message : String(err) })
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- describe only closes over setters and `selected`
    [selected],
  )

  return (
    <div className="changes-panel">
      <div className="panel-header">
        <span className="label">changes</span>
        <button type="button" className="link-action" onClick={onClose}>
          [close]
        </button>
      </div>

      {groups.length === 0 ? (
        <div className="empty-state changes-panel__empty">
          <p className="empty-state__title">No agent changes yet</p>
          <p className="empty-state__hint">Files the agent edits in Build mode are listed here, with their diff and a way to revert each one.</p>
        </div>
      ) : (
        <div className="changes-panel__body">
          {groups.map((group) => {
            const totals = totalChanges(group.files)
            return (
              <section key={group.runId} className="changes-group">
                <header className="changes-group__head">
                  <span className="label">{group.title}</span>
                  <span className="muted">
                    {group.files.length} file{group.files.length === 1 ? '' : 's'} · +{totals.added} -{totals.removed}
                  </span>
                  <span className="agent-block__spacer" />
                  {!group.active && group.files.some((f) => !f.reverted) && (
                    <ConfirmAction label="[revert all]" confirmLabel="[confirm revert all]" onConfirm={() => void revert(group.runId, undefined)} title="restore every file this run changed to how it was before" />
                  )}
                </header>
                <div className="rule-list">
                  {group.files.map((file) => {
                    const isSelected = selected?.runId === group.runId && selected.path === file.path
                    return (
                      <div key={file.path} className={`changes-file${isSelected ? ' is-selected' : ''}${file.reverted ? ' is-reverted' : ''}`}>
                        <button
                          type="button"
                          className="changes-file__main"
                          onClick={() => setSelected(isSelected ? null : { runId: group.runId, path: file.path })}
                          aria-pressed={isSelected}
                          title={file.path}
                        >
                          <span className="changes-file__path">{file.path}</span>
                          {file.kind === 'created' && <span className="chip chip--outline">new</span>}
                          {file.changedSince && <span className="chip chip--outline signal" title="edited after the agent wrote it">edited since</span>}
                          {file.reverted ? <span className="muted">reverted</span> : <DiffChanges additions={file.added} deletions={file.removed} />}
                        </button>
                        {!file.reverted && !group.active && (
                          <>
                            {forceFor && forceFor.runId === group.runId && forceFor.path === file.path ? (
                              <button type="button" className="link-action link-action--danger is-armed" onClick={() => void revert(group.runId, file.path, true)} title="discard the newer edits too">
                                [revert anyway]
                              </button>
                            ) : (
                              <button type="button" className="link-action" onClick={() => void revert(group.runId, file.path)}>
                                [revert file]
                              </button>
                            )}
                          </>
                        )}
                        <button type="button" className="link-action" onClick={() => onOpenFile(file.path)} title="open in the code editor">
                          [open]
                        </button>
                      </div>
                    )
                  })}
                </div>
              </section>
            )
          })}
          {note && <p className={`changes-panel__note ${note.tone}`}>{note.text}</p>}
          {forceFor && (
            <p className="changes-panel__note muted">That file was edited after the agent wrote it. [revert anyway] discards those newer edits.</p>
          )}

          {selected && (
            <div className="changes-panel__diff">
              <div className="changes-panel__diff-head">
                <span className="label">diff</span>
                <span className="muted">before the run → now</span>
              </div>
              {diff?.status === 'ok' ? (
                <Suspense fallback={<p className="muted changes-panel__loading">loading diff…</p>}>
                  <DiffViewer path={diff.path} original={diff.original} modified={diff.modified} inline />
                </Suspense>
              ) : (
                <p className="muted changes-panel__loading">{diff ? diff.message : 'loading…'}</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
