import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '@ai-workspace/shared'
import type { TerminalsState } from '../../hooks/useTerminals'
import { buildXtermTheme, readThemeTokens } from '../../lib/monaco/theme'
import { subscribeThemeChange } from '../../lib/theme-watch'

interface Props {
  info: TerminalInfo
  terminals: Pick<TerminalsState, 'attach' | 'write' | 'resize'>
  /** The tab is showing; a hidden terminal can't be measured, so it re-fits when it comes back. */
  visible: boolean
  /** Bump to focus the terminal (Ctrl+` or /terminal while the panel is already open). */
  focusSignal: number
}

/**
 * One xterm.js instance bound to one PTY. xterm.js renders and handles
 * keystrokes; every key goes to the PTY over IPC and the PTY's output comes
 * back through `terminals.attach`. Theme, font and size come from the nochan
 * tokens / the fit addon; the app's own shortcuts (Ctrl+` and Ctrl+Shift+P)
 * are not swallowed by the shell.
 */
export default function TerminalView({ info, terminals, visible, focusSignal }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const visibleRef = useRef(visible)
  const apiRef = useRef(terminals)

  useEffect(() => {
    visibleRef.current = visible
    apiRef.current = terminals
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const term = new Terminal({
      fontFamily: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: false,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: false,
      theme: buildXtermTheme(readThemeTokens()),
      // Windows ConPTY reflows on resize itself; this keeps xterm's side consistent.
      ...(navigator.userAgent.includes('Windows') ? { windowsPty: { backend: 'conpty' as const } } : {}),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.ctrlKey || event.metaKey
      // App-level shortcuts pass through to the window listener instead of the shell.
      if (mod && event.key === '`') return false
      if (mod && event.shiftKey && event.key.toLowerCase() === 'p') return false
      // Copy a selection with Ctrl+C; with nothing selected it stays SIGINT.
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined)
        return false
      }
      return true
    })

    const { replay, detach } = apiRef.current.attach(info.id, (data) => term.write(data))
    if (replay) term.write(replay)

    const dataSub = term.onData((data) => apiRef.current.write(info.id, data))
    const resizeSub = term.onResize(({ cols, rows }) => apiRef.current.resize(info.id, cols, rows))

    const doFit = (): void => {
      if (!visibleRef.current || container.clientWidth < 20 || container.clientHeight < 20) return
      try {
        fit.fit()
      } catch {
        // xterm throws if measured while detached; the next observer tick retries
      }
    }
    const observer = new ResizeObserver(doFit)
    observer.observe(container)
    doFit()
    const unsubscribeTheme = subscribeThemeChange(() => {
      term.options.theme = buildXtermTheme(readThemeTokens())
    })

    return () => {
      unsubscribeTheme()
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      detach()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [info.id])

  useEffect(() => {
    if (!visible) return
    const frame = requestAnimationFrame(() => {
      const container = containerRef.current
      if (container && container.clientWidth > 20 && container.clientHeight > 20) {
        try {
          fitRef.current?.fit()
        } catch {
          // retried by the resize observer
        }
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [visible, focusSignal])

  return <div ref={containerRef} className="terminal-view__surface" aria-label={`Terminal ${info.title}`} />
}
