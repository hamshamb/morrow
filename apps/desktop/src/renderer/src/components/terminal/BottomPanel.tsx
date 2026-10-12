import { lazy, Suspense, useEffect, useRef } from 'react'
import type { TerminalsState } from '../../hooks/useTerminals'
import type { OutputLog } from '../../hooks/useOutputLog'
import type { AgentOutputEntry } from '../../lib/agent-ui'

const TerminalView = lazy(() => import('./TerminalView'))

export type BottomTab = 'terminal' | 'output' | 'agent'

interface Props {
  visible: boolean
  height: number
  tab: BottomTab
  onTabChange: (tab: BottomTab) => void
  onHide: () => void
  terminals: TerminalsState
  output: OutputLog
  /** Output of the commands the agent ran (live while they run). */
  agentOutput: AgentOutputEntry[]
  onClearAgentOutput: () => void
  hasRoot: boolean
  onPickFolder: () => void
  /** Bump to focus the active terminal. */
  focusSignal: number
}

function time(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false })
}

/**
 * The bottom panel: `terminal | output`. Terminals are real PTYs (xterm.js in
 * the renderer, node-pty in the main process) that start only when the user
 * asks for one - [+ new terminal], or the first Ctrl+` / /terminal. The panel
 * stays mounted while hidden so a running shell keeps its screen.
 */
export function BottomPanel({ visible, height, tab, onTabChange, onHide, terminals, output, agentOutput, onClearAgentOutput, hasRoot, onPickFolder, focusSignal }: Props) {
  const { terminals: list, activeId, setActiveId } = terminals
  const outputEndRef = useRef<HTMLDivElement>(null)

  const agentEndRef = useRef<HTMLDivElement>(null)
  const agentRunning = agentOutput.some((e) => e.status === 'running' || e.status === 'pending')

  useEffect(() => {
    if (tab === 'output') outputEndRef.current?.scrollIntoView({ block: 'end' })
  }, [tab, output.lines, visible])

  useEffect(() => {
    if (tab === 'agent') agentEndRef.current?.scrollIntoView({ block: 'end' })
  }, [tab, agentOutput, visible])

  return (
    <section className="bottom-panel" style={{ height }} hidden={!visible} aria-label="Panel">
      <header className="bottom-panel__head">
        <div className="bottom-panel__tabs" role="tablist" aria-label="Panel">
          <button type="button" role="tab" aria-selected={tab === 'terminal'} className={`panel-tab${tab === 'terminal' ? ' is-active' : ''}`} onClick={() => onTabChange('terminal')}>
            terminal
          </button>
          <button type="button" role="tab" aria-selected={tab === 'output'} className={`panel-tab${tab === 'output' ? ' is-active' : ''}`} onClick={() => onTabChange('output')}>
            output{output.lines.some((l) => l.level === 'error') ? ' •' : ''}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'agent'} className={`panel-tab${tab === 'agent' ? ' is-active' : ''}`} onClick={() => onTabChange('agent')}>
            agent{agentRunning ? ' •' : ''}
          </button>
        </div>

        {tab === 'terminal' && (
          <div className="bottom-panel__terminals" role="tablist" aria-label="Terminals">
            {list.map((t, index) => (
              <div key={t.id} role="tab" aria-selected={t.id === activeId} className={`term-tab${t.id === activeId ? ' is-active' : ''}${t.status === 'exited' ? ' is-exited' : ''}`}>
                <button type="button" className="term-tab__label" onClick={() => setActiveId(t.id)} title={`${t.title} — ${t.cwd}`}>
                  {index + 1} {t.title}
                  {t.status === 'exited' ? ` (exit ${t.exitCode ?? '?'})` : ''}
                </button>
                <button type="button" className="term-tab__close" aria-label={`Close terminal ${index + 1}`} onClick={() => void terminals.close(t.id)}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="link-action" onClick={() => void terminals.create()} disabled={!hasRoot} title="start a shell in the workspace folder">
              [+ new terminal]
            </button>
          </div>
        )}
        {tab === 'output' && (
          <button type="button" className="link-action" onClick={output.clear}>
            [clear]
          </button>
        )}
        {tab === 'agent' && (
          <button type="button" className="link-action" onClick={onClearAgentOutput}>
            [clear]
          </button>
        )}

        <span className="bottom-panel__spacer" />
        <button type="button" className="link-action" onClick={onHide}>
          [hide] <kbd>Ctrl `</kbd>
        </button>
      </header>

      <div className="bottom-panel__body">
        {tab === 'terminal' && (
          <div className="terminal-stack">
            {terminals.error && (
              <p className="signal terminal-stack__note" role="alert">
                {terminals.error}
              </p>
            )}
            {list.length === 0 && !terminals.error && (
              <div className="empty-state terminal-stack__empty">
                <p className="empty-state__title">{hasRoot ? 'No terminal running' : 'No folder chosen for this workspace'}</p>
                <p className="empty-state__hint">
                  {hasRoot ? 'A terminal starts a shell in the workspace folder. Nothing runs until you start one.' : 'Choose a folder first - terminals open there.'}
                </p>
                {hasRoot ? (
                  <button type="button" className="link-action link-action--large" onClick={() => void terminals.create()}>
                    [+ new terminal]
                  </button>
                ) : (
                  <button type="button" className="link-action link-action--large" onClick={onPickFolder}>
                    [choose a folder]
                  </button>
                )}
              </div>
            )}
            {list.map((t) => (
              <div key={t.id} className="terminal-view" hidden={t.id !== activeId}>
                <Suspense fallback={<p className="muted terminal-stack__note">loading terminal…</p>}>
                  <TerminalView info={t} terminals={terminals} visible={visible && tab === 'terminal' && t.id === activeId} focusSignal={focusSignal} />
                </Suspense>
                {t.status === 'exited' && (
                  <div className="strip strip--warn terminal-view__exit" role="status">
                    <span>
                      Process exited{t.exitCode !== null ? ` with code ${t.exitCode}` : ''}.
                    </span>
                    <button type="button" className="link-action" onClick={() => void terminals.restart(t.id)}>
                      [restart]
                    </button>
                    <button type="button" className="link-action" onClick={() => void terminals.close(t.id)}>
                      [close]
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        {tab === 'agent' && (
          <div className="output-log agent-output-log" role="log" aria-label="Agent command output">
            {agentOutput.length === 0 && <p className="muted output-log__empty">Nothing yet. Commands the agent runs in Build mode stream their output here as they run.</p>}
            {agentOutput.map((entry) => (
              <div key={entry.toolRunId} className={`agent-output-entry is-${entry.status}`}>
                <div className="agent-output-entry__head">
                  <span className="output-line__time">{time(entry.at)}</span>
                  <span className="agent-output-entry__label">$ {entry.label.replace(/^run /, '')}</span>
                  <span className={entry.status === 'error' || entry.status === 'denied' ? 'signal' : entry.status === 'ok' ? 'ok' : 'muted'}>
                    {entry.status === 'running' || entry.status === 'pending' ? 'running…' : entry.status}
                  </span>
                </div>
                {entry.text !== '' && <pre className="agent-output-entry__text">{entry.text}</pre>}
              </div>
            ))}
            <div ref={agentEndRef} />
          </div>
        )}
        {tab === 'output' && (
          <div className="output-log" role="log" aria-label="Output">
            {output.lines.length === 0 && <p className="muted output-log__empty">Nothing yet. Saves, git actions and terminal starts are logged here.</p>}
            {output.lines.map((line) => (
              <div key={line.id} className={`output-line${line.level === 'error' ? ' is-error' : ''}`}>
                <span className="output-line__time">{time(line.at)}</span>
                <span className="output-line__text">{line.text}</span>
              </div>
            ))}
            <div ref={outputEndRef} />
          </div>
        )}
      </div>
    </section>
  )
}
