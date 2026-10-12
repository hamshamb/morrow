import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { GitArea, GitChange, GitDiffResult, GitStatus } from '@ai-workspace/shared'
import type { GitState } from '../../hooks/useGitStatus'
import { useResizablePanel } from '../../hooks/useResizablePanel'
import { ResizeHandle } from '../shell/ResizeHandle'
import { DiffChanges } from './DiffChanges'
import { canCommit, commitBlockedReason, statusLetter, statusWord, totals } from '../../lib/code/git-ui'
import { baseName, dirName, ipcErrorMessage } from '../../lib/code/paths'

const DiffViewer = lazy(() => import('./DiffViewer'))

interface Props {
  workspaceId: string
  rootPath: string | null
  indexing: boolean
  onPickFolder: () => void
  git: GitState
  /** Open the file in the code view. */
  onOpenInEditor: (path: string) => void
  /** Focus the commit message box when this changes (command palette "Commit…"). */
  commitSignal: number
}

interface Selection {
  path: string
  area: GitArea
  origPath: string | null
}

function sameSelection(a: Selection | null, b: Selection | null): boolean {
  return a?.path === b?.path && a?.area === b?.area
}

export function GitView({ workspaceId, rootPath, indexing, onPickFolder, git, onOpenInEditor, commitSignal }: Props) {
  const panel = useResizablePanel({ direction: 'horizontal', initialSize: 360, min: 260, max: 620 })
  const [selected, setSelected] = useState<Selection | null>(null)
  const [diff, setDiff] = useState<GitDiffResult | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [inline, setInline] = useState(false)
  const [message, setMessage] = useState('')
  const [lastCommit, setLastCommit] = useState<string | null>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const { status, busy } = git

  useEffect(() => {
    if (commitSignal > 0) messageRef.current?.focus()
  }, [commitSignal])

  useEffect(() => {
    setSelected(null)
    setDiff(null)
    setLastCommit(null)
  }, [workspaceId])

  const groups = status?.state === 'ok' ? status : null

  // The currently selected change (by path + area) as it exists in the latest status.
  const selectedChange = useMemo<GitChange | null>(() => {
    if (!groups || !selected) return null
    const list = selected.area === 'staged' ? groups.staged : selected.area === 'unstaged' ? groups.unstaged : groups.untracked
    return list.find((c) => c.path === selected.path) ?? null
  }, [groups, selected])

  // When a file moves between lists (stage / unstage), keep following it; drop the selection if it is gone.
  useEffect(() => {
    if (!groups || !selected) return
    if (selectedChange) return
    const follow = (area: GitArea, list: GitChange[]): Selection | null => {
      const hit = list.find((c) => c.path === selected.path)
      return hit ? { path: hit.path, area, origPath: hit.origPath } : null
    }
    const next = follow('staged', groups.staged) ?? follow('unstaged', groups.unstaged) ?? follow('untracked', groups.untracked)
    setSelected(next)
    if (!next) setDiff(null)
  }, [groups, selected, selectedChange])

  // Fetch the diff sides whenever the selection - or that file's own change summary - changes.
  const signature = selectedChange
    ? `${selectedChange.status}:${selectedChange.additions}:${selectedChange.deletions}:${selectedChange.origPath ?? ''}`
    : ''
  useEffect(() => {
    if (!selected || !selectedChange) return
    let cancelled = false
    setDiffLoading(true)
    window.api.git
      .diff({ workspaceId, path: selected.path, area: selected.area, origPath: selected.origPath })
      .then(
        (result) => {
          if (cancelled) return
          setDiff(result)
          setDiffError(null)
        },
        (err: unknown) => {
          if (cancelled) return
          setDiff(null)
          setDiffError(ipcErrorMessage(err))
        },
      )
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands in for selectedChange's relevant fields
  }, [workspaceId, selected?.path, selected?.area, signature])

  async function doCommit(): Promise<void> {
    if (!canCommit(status, message, busy)) return
    const summary = await git.commit(message.trim())
    if (summary) {
      setMessage('')
      setLastCommit(`${summary.shortSha} ${summary.subject}`)
    }
  }

  if (!rootPath) {
    return (
      <div className="git-view git-view--empty">
        <div className="empty-state">
          <p className="empty-state__title">No folder chosen for this workspace</p>
          <p className="empty-state__hint">Choose the repository folder to see its branch, changes and diffs.</p>
          <button type="button" className="link-action link-action--large" onClick={onPickFolder} disabled={indexing}>
            {indexing ? '[indexing…]' : '[choose a folder]'}
          </button>
        </div>
      </div>
    )
  }

  const stateMessage = renderState(status, git)
  if (stateMessage) return <div className="git-view git-view--empty">{stateMessage}</div>

  if (!groups) {
    return (
      <div className="git-view git-view--empty">
        <p className="muted">reading repository…</p>
      </div>
    )
  }

  const stagedTotals = totals(groups.staged)
  const blocked = commitBlockedReason(status, message)
  const clean = groups.staged.length + groups.unstaged.length + groups.untracked.length + groups.conflicted.length === 0

  return (
    <div className="git-view">
      <aside className="git-view__changes" style={{ width: panel.size }}>
        <div className="git-head">
          <div className="git-head__branch">
            <span className="label">branch</span>
            <span className="chip chip--inverted chip--raw" title={groups.branch.upstream ? `tracking ${groups.branch.upstream}` : 'no upstream'}>
              {groups.branch.detached ? 'detached' : (groups.branch.head ?? 'no branch')}
            </span>
            {groups.branch.ahead > 0 && <span className="chip chip--outline">↑{groups.branch.ahead}</span>}
            {groups.branch.behind > 0 && <span className="chip chip--outline">↓{groups.branch.behind}</span>}
            <button type="button" className="link-action git-head__refresh" onClick={() => void git.refresh()} disabled={git.loading}>
              {git.loading ? '[refreshing…]' : '[refresh]'}
            </button>
          </div>
          <div className="git-head__commit" title={groups.commit?.sha ?? undefined}>
            {groups.commit ? (
              <>
                <code className="git-head__sha">{groups.commit.shortSha}</code>
                <span className="git-head__subject">{groups.commit.subject}</span>
              </>
            ) : (
              <span className="muted">no commits yet</span>
            )}
          </div>
        </div>

        <div className="commit-box">
          <label className="label" htmlFor="commit-message">
            commit message
          </label>
          <textarea
            id="commit-message"
            ref={messageRef}
            className="commit-box__input"
            rows={3}
            value={message}
            placeholder={groups.staged.length === 0 ? 'stage changes, then describe them…' : 'describe the staged changes…'}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                void doCommit()
              }
            }}
          />
          <div className="commit-box__actions">
            <button type="button" className="btn btn--primary" disabled={!canCommit(status, message, busy)} title={blocked ?? 'commit the staged changes'} onClick={() => void doCommit()}>
              {busy ? 'working…' : `commit ${groups.staged.length} staged`}
            </button>
            <span className="muted commit-box__hint">
              {blocked ?? (
                <>
                  <kbd>Ctrl Enter</kbd>
                </>
              )}
            </span>
          </div>
          {git.error && (
            <p className="signal commit-box__error" role="alert">
              {git.error}{' '}
              <button type="button" className="link-action" onClick={git.clearError}>
                [dismiss]
              </button>
            </p>
          )}
          {lastCommit && !git.error && <p className="ok commit-box__done">committed {lastCommit}</p>}
        </div>

        <div className="changes-scroll">
          {clean && <p className="muted changes-clean">Working tree clean — nothing to commit.</p>}
          {groups.conflicted.length > 0 && (
            <ChangeGroup title="conflicts" changes={groups.conflicted} area="unstaged" selected={selected} onSelect={setSelected} onOpen={onOpenInEditor} />
          )}
          {groups.staged.length > 0 && (
            <ChangeGroup
              title="staged"
              changes={groups.staged}
              area="staged"
              selected={selected}
              onSelect={setSelected}
              onOpen={onOpenInEditor}
              totalsText={stagedTotals}
              bulkLabel="[unstage all]"
              onBulk={() => void git.unstageAll()}
              rowLabel="[unstage]"
              onRow={(c) => void git.unstage([c])}
              busy={busy}
            />
          )}
          {groups.unstaged.length > 0 && (
            <ChangeGroup
              title="unstaged"
              changes={groups.unstaged}
              area="unstaged"
              selected={selected}
              onSelect={setSelected}
              onOpen={onOpenInEditor}
              totalsText={totals(groups.unstaged)}
              bulkLabel="[stage all]"
              onBulk={() => void git.stageAll()}
              rowLabel="[stage]"
              onRow={(c) => void git.stage([c])}
              busy={busy}
            />
          )}
          {groups.untracked.length > 0 && (
            <ChangeGroup
              title="untracked"
              changes={groups.untracked}
              area="untracked"
              selected={selected}
              onSelect={setSelected}
              onOpen={onOpenInEditor}
              rowLabel="[stage]"
              onRow={(c) => void git.stage([c])}
              busy={busy}
            />
          )}
          {groups.truncated && <p className="muted changes-clean">Very long list - only the first changes are shown.</p>}
        </div>
      </aside>
      <ResizeHandle onMouseDown={panel.onMouseDown} dragging={panel.dragging} ariaLabel="Resize changes list" />

      <section className="git-view__diff">
        {selected && selectedChange ? (
          <>
            <div className="diff-head">
              <div className="diff-head__title">
                <span className={`status-letter status-letter--${selectedChange.status}`}>{statusLetter(selectedChange.status)}</span>
                <span className="diff-head__path" title={selected.path}>
                  {selected.path}
                </span>
                <span className="chip chip--outline">{selected.area}</span>
                <DiffChanges additions={selectedChange.additions} deletions={selectedChange.deletions} binary={selectedChange.binary} variant="bars" />
                {diff?.status === 'ok' && (
                  <span className="muted diff-head__sides">
                    {diff.originalLabel} → {diff.modifiedLabel}
                  </span>
                )}
              </div>
              <div className="diff-head__actions">
                <div className="segmented" role="group" aria-label="Diff layout">
                  <button type="button" className={!inline ? 'is-active' : ''} aria-pressed={!inline} onClick={() => setInline(false)}>
                    side by side
                  </button>
                  <button type="button" className={inline ? 'is-active' : ''} aria-pressed={inline} onClick={() => setInline(true)}>
                    inline
                  </button>
                </div>
                {selectedChange.status !== 'deleted' && !selectedChange.protected && (
                  <button type="button" className="link-action" onClick={() => onOpenInEditor(selected.path)}>
                    [open in editor]
                  </button>
                )}
              </div>
            </div>
            <div className="diff-body">
              {diffError && <p className="signal diff-body__note">{diffError}</p>}
              {!diffError && diff?.status === 'ok' && (
                <Suspense fallback={<p className="muted diff-body__note">loading diff editor…</p>}>
                  <DiffViewer path={selected.path} original={diff.original} modified={diff.modified} inline={inline} />
                </Suspense>
              )}
              {!diffError && diff && diff.status !== 'ok' && (
                <div className="empty-state diff-body__empty">
                  <p className="empty-state__title">{diff.status === 'protected' ? 'Protected file' : diff.status === 'binary' ? 'Binary file' : 'File too large'}</p>
                  <p className="empty-state__hint">{diff.message}</p>
                </div>
              )}
              {!diff && !diffError && diffLoading && <p className="muted diff-body__note">loading diff…</p>}
            </div>
          </>
        ) : (
          <div className="empty-state git-view__diff-empty">
            <p className="empty-state__title">No change selected</p>
            <p className="empty-state__hint">Pick a changed file on the left to compare it with {groups.commit ? 'HEAD' : 'nothing'} — side by side or inline.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function renderState(status: GitStatus | null, git: GitState): React.ReactNode {
  if (status === null) return null
  if (status.state === 'git-missing') {
    return (
      <div className="empty-state">
        <p className="empty-state__title">Git not found</p>
        <p className="empty-state__hint">The git command is not on your PATH. Install git, restart the app, and this view will light up. The editor and terminal work without it.</p>
        <button type="button" className="link-action" onClick={() => void git.refresh()}>
          [check again]
        </button>
      </div>
    )
  }
  if (status.state === 'not-a-repo') {
    return (
      <div className="empty-state">
        <p className="empty-state__title">This folder is not a git repository</p>
        <p className="empty-state__hint">Nothing to show here. Open a folder that has a .git directory (or a subfolder of one).</p>
        <button type="button" className="link-action" onClick={() => void git.refresh()}>
          [check again]
        </button>
      </div>
    )
  }
  if (status.state === 'error') {
    return (
      <div className="empty-state">
        <p className="empty-state__title">Git reported an error</p>
        <p className="empty-state__hint signal">{status.message}</p>
        <button type="button" className="link-action" onClick={() => void git.refresh()}>
          [retry]
        </button>
      </div>
    )
  }
  return null
}

interface GroupProps {
  title: string
  changes: GitChange[]
  area: GitArea
  selected: Selection | null
  onSelect: (selection: Selection) => void
  onOpen: (path: string) => void
  totalsText?: { additions: number; deletions: number }
  bulkLabel?: string
  onBulk?: () => void
  rowLabel?: string
  onRow?: (change: GitChange) => void
  busy?: boolean
}

function ChangeGroup({ title, changes, area, selected, onSelect, onOpen, totalsText, bulkLabel, onBulk, rowLabel, onRow, busy = false }: GroupProps) {
  return (
    <section className="change-group" aria-label={title}>
      <header className="change-group__head">
        <span className="label">
          {title} <span className="change-group__count">{changes.length}</span>
        </span>
        {totalsText && <DiffChanges additions={totalsText.additions} deletions={totalsText.deletions} />}
        {bulkLabel && onBulk && (
          <button type="button" className="link-action" onClick={onBulk} disabled={busy}>
            {bulkLabel}
          </button>
        )}
      </header>
      {changes.map((change) => {
        const dir = dirName(change.path)
        const sel: Selection = { path: change.path, area, origPath: change.origPath }
        const isSelected = sameSelection(selected, sel)
        return (
          <div key={`${area}:${change.path}`} className={`change-row${isSelected ? ' is-selected' : ''}`}>
            <button
              type="button"
              className="change-row__main"
              onClick={() => onSelect(sel)}
              onDoubleClick={() => !change.protected && change.status !== 'deleted' && onOpen(change.path)}
              title={`${change.path} — ${statusWord(change.status)}${change.origPath ? ` (from ${change.origPath})` : ''}${change.protected ? ' — protected, content never shown' : ''}`}
            >
              <span className={`status-letter status-letter--${change.status}`}>{statusLetter(change.status)}</span>
              <span className="change-row__name">{baseName(change.path)}</span>
              {change.protected && <span className="chip chip--outline">protected</span>}
              {dir && <span className="change-row__dir">{dir}</span>}
              <span className="change-row__spacer" />
              <DiffChanges additions={change.additions} deletions={change.deletions} binary={change.binary} />
            </button>
            {rowLabel && onRow && (
              <button type="button" className="link-action change-row__action" onClick={() => onRow(change)} disabled={busy} aria-label={`${rowLabel.replace(/[[\]]/g, '')} ${change.path}`}>
                {rowLabel}
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}
