import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerMode, ModelRef, ProviderId, Workspace, WorkspaceFileIndexEntry } from '@ai-workspace/shared'
import { matchesSearch } from '../lib/search-match'
import { useProviderRegistry } from '../hooks/useProviderRegistry'

export interface WorkspaceCommandActions {
  newConversation: () => void
  openModelPicker: () => void
  /** Opens the composer in a multi-model mode (compare / review / roundtable / auto). */
  openMode: (mode: ComposerMode) => void
  showAgentOutput: () => void
  openContextPanel: () => void
  openFilesPanel: () => void
  addFileToContext: (path: string) => void
  useModel: (ref: ModelRef) => void
  indexedFiles: WorkspaceFileIndexEntry[]
  favorites: FavoriteModelEntry[]
  // --- Phase 4 code workspace
  /** The workspace has a folder (quick open / search / terminal need one). */
  hasFolder: boolean
  openFile: () => void
  searchInFiles: () => void
  showCode: () => void
  toggleTerminal: () => void
  newTerminal: () => void
  showChanges: () => void
  commit: () => void
}

export interface FavoriteModelEntry {
  ref: ModelRef
  name: string
  provider: ProviderId
}

interface Props {
  onClose: () => void
  workspaces: Workspace[]
  activeWorkspaceId: string | null
  onSwitchWorkspace: (id: string) => void
  onOpenSettings: () => void
  onOpenKeyboard: () => void
  workspaceActions: WorkspaceCommandActions | null
}

interface CommandEntry {
  id: string
  group: string
  title: string
  hint?: string
  keys?: string[]
  keywords: string[]
  run: () => void
}

/**
 * Cmd/Ctrl+K (also Cmd/Ctrl+Shift+P). Dialog sizing/anchoring ported from
 * opencode's dialog-command-palette-v2.css (MIT License — 640px max width,
 * 36px rows, anchored near the top); search matching from
 * lib/search-match.ts (adapted from opencode, MIT). Visuals follow nochan
 * (square, rules, uppercase group labels, kbd chips). Wired to real
 * actions only. The "models" group holds the multi-model modes (Phase 6,
 * ADR-027): each entry opens the composer in that mode — the same place the
 * composer's mode chip leads — so the default chat stays uncluttered.
 */
export function CommandPalette({
  onClose,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onOpenSettings,
  onOpenKeyboard,
  workspaceActions,
}: Props) {
  const { label } = useProviderRegistry()
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const entries = useMemo<CommandEntry[]>(() => {
    const list: CommandEntry[] = []
    if (workspaceActions) {
      list.push(
        {
          id: 'new',
          group: 'actions',
          title: 'New session',
          keys: ['c'],
          keywords: ['new', 'conversation', 'chat', 'session'],
          run: workspaceActions.newConversation,
        },
        {
          id: 'model',
          group: 'actions',
          title: 'Switch model',
          keys: ['Ctrl', 'M'],
          keywords: ['model', 'provider', 'switch', 'change'],
          run: workspaceActions.openModelPicker,
        },
        {
          id: 'context',
          group: 'actions',
          title: 'Open context panel',
          hint: "what's sent with the next message",
          keywords: ['context', 'inspector', 'sources'],
          run: workspaceActions.openContextPanel,
        },
        {
          id: 'files',
          group: 'actions',
          title: 'Workspace files…',
          hint: 'choose or reindex the folder',
          keywords: ['files', 'folder', 'index', 'root'],
          run: workspaceActions.openFilesPanel,
        },
      )
    }
    list.push(
      {
        id: 'settings',
        group: 'actions',
        title: 'Settings',
        hint: 'providers, models, appearance',
        keywords: ['settings', 'preferences', 'providers', 'keys', 'theme'],
        run: onOpenSettings,
      },
      {
        id: 'keyboard',
        group: 'actions',
        title: 'Keyboard shortcuts',
        keywords: ['keyboard', 'shortcuts', 'keys', 'help'],
        run: onOpenKeyboard,
      },
    )
    // Groups render in insertion order — keep every "actions" entry above.
    if (workspaceActions) {
      list.push(
        {
          id: 'code:open-file',
          group: 'code',
          title: 'Open file…',
          hint: workspaceActions.hasFolder ? 'find a file by name' : 'choose a folder first',
          keys: ['Ctrl', 'P'],
          keywords: ['open', 'file', 'quick open', 'go to file', 'code', 'editor'],
          run: workspaceActions.openFile,
        },
        {
          id: 'code:search',
          group: 'code',
          title: 'Search in files…',
          hint: 'text search across the folder',
          keys: ['Ctrl', 'Shift', 'F'],
          keywords: ['search', 'find', 'grep', 'text', 'code'],
          run: workspaceActions.searchInFiles,
        },
        {
          id: 'code:show',
          group: 'code',
          title: 'Show code',
          hint: 'files and editor',
          keywords: ['code', 'editor', 'files', 'tree', 'explorer'],
          run: workspaceActions.showCode,
        },
        {
          id: 'code:terminal',
          group: 'code',
          title: 'Toggle terminal',
          hint: 'bottom panel',
          keys: ['Ctrl', '`'],
          keywords: ['terminal', 'shell', 'console', 'panel', 'toggle'],
          run: workspaceActions.toggleTerminal,
        },
        {
          id: 'code:new-terminal',
          group: 'code',
          title: 'New terminal',
          hint: 'starts a shell in the workspace folder',
          keywords: ['terminal', 'shell', 'new', 'powershell', 'bash'],
          run: workspaceActions.newTerminal,
        },
        {
          id: 'code:changes',
          group: 'code',
          title: 'Show changes',
          hint: 'branch, staged and unstaged files, diffs',
          keywords: ['changes', 'git', 'diff', 'status', 'staged', 'branch'],
          run: workspaceActions.showChanges,
        },
        {
          id: 'code:commit',
          group: 'code',
          title: 'Commit…',
          hint: 'write a message for the staged changes',
          keywords: ['commit', 'git', 'message', 'stage'],
          run: workspaceActions.commit,
        },
      )
    }
    if (workspaceActions) {
      list.push(
        {
          id: 'mode:plan',
          group: 'models',
          title: 'Plan with the agent…',
          hint: 'read-only: inspect the workspace and plan',
          keywords: ['plan', 'agent', 'investigate', 'read-only', 'analyse', 'analyze'],
          run: () => workspaceActions.openMode('plan'),
        },
        {
          id: 'mode:build',
          group: 'models',
          title: 'Build with the agent…',
          hint: 'the agent edits files and runs commands — you approve each',
          keywords: ['build', 'agent', 'implement', 'fix', 'code', 'edit', 'tools'],
          run: () => workspaceActions.openMode('build'),
        },
        {
          id: 'agent:output',
          group: 'models',
          title: 'Show agent command output',
          hint: 'live output of commands the agent runs',
          keywords: ['agent', 'output', 'commands', 'log'],
          run: workspaceActions.showAgentOutput,
        },
        {
          id: 'mode:compare',
          group: 'models',
          title: 'Compare models…',
          hint: 'one prompt, 2–4 models side by side',
          keywords: ['compare', 'side by side', 'columns', 'models', 'multi'],
          run: () => workspaceActions.openMode('compare'),
        },
        {
          id: 'mode:review',
          group: 'models',
          title: 'Review with…',
          hint: 'a second model reviews the answer',
          keywords: ['review', 'critic', 'second opinion', 'check'],
          run: () => workspaceActions.openMode('review'),
        },
        {
          id: 'mode:roundtable',
          group: 'models',
          title: 'Round table…',
          hint: 'propose, critique, alternative, synthesis',
          keywords: ['round table', 'roundtable', 'debate', 'discuss', 'panel'],
          run: () => workspaceActions.openMode('roundtable'),
        },
        {
          id: 'mode:auto',
          group: 'models',
          title: 'Auto-pick model',
          hint: 'the app chooses, by rules you can read',
          keywords: ['auto', 'automatic', 'router', 'pick', 'cheapest', 'best'],
          run: () => workspaceActions.openMode('auto'),
        },
      )
      for (const fav of workspaceActions.favorites) {
        list.push({
          id: `fav:${fav.ref.providerConfigId}:${fav.ref.model}`,
          group: 'models',
          title: `Use ${fav.name}`,
          hint: `★ ${label(fav.provider)}`,
          keywords: ['model', 'use', fav.name, fav.ref.model, label(fav.provider)],
          run: () => workspaceActions.useModel(fav.ref),
        })
      }
    }
    for (const workspace of workspaces) {
      if (workspace.id === activeWorkspaceId) continue
      list.push({
        id: `ws:${workspace.id}`,
        group: 'workspaces',
        title: workspace.name,
        hint: 'switch workspace',
        keywords: ['workspace', 'switch', workspace.name],
        run: () => onSwitchWorkspace(workspace.id),
      })
    }
    if (workspaceActions) {
      for (const file of workspaceActions.indexedFiles.slice(0, 50)) {
        list.push({
          id: `file:${file.relativePath}`,
          group: 'add file to context',
          title: file.relativePath.split(/[\\/]/).pop() ?? file.relativePath,
          hint: file.relativePath,
          keywords: ['file', file.relativePath],
          run: () => workspaceActions.addFileToContext(file.relativePath),
        })
      }
    }
    return list
  }, [workspaceActions, onOpenSettings, onOpenKeyboard, workspaces, activeWorkspaceId, onSwitchWorkspace, label])

  const filtered = useMemo(
    () => (query.trim() ? entries.filter((e) => matchesSearch(query, [e.title, ...e.keywords])) : entries),
    [entries, query],
  )

  useEffect(() => {
    setHighlighted(0)
  }, [query])

  useEffect(() => {
    listRef.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  function run(entry: CommandEntry) {
    onClose()
    entry.run()
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, Math.max(filtered.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = filtered[highlighted]
      if (entry) run(entry)
    }
  }

  let lastGroup = ''
  return (
    <div className="overlay overlay--top" onMouseDown={onClose}>
      <div
        className="command-palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-palette__input"
          placeholder="type a command, a model, a workspace or a file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <div className="command-palette__list" ref={listRef}>
          {filtered.length === 0 && <p className="command-palette__empty muted">no matching commands</p>}
          {filtered.map((entry, index) => {
            const showGroup = entry.group !== lastGroup
            lastGroup = entry.group
            return (
              <div key={entry.id}>
                {showGroup && <div className="label command-palette__group">{entry.group}</div>}
                <button
                  type="button"
                  className="command-palette__row"
                  data-active={index === highlighted || undefined}
                  onMouseEnter={() => setHighlighted(index)}
                  onClick={() => run(entry)}
                >
                  <span className="command-palette__title">{entry.title}</span>
                  {entry.hint && <span className="command-palette__hint">{entry.hint}</span>}
                  {entry.keys && (
                    <span className="command-palette__keys">
                      {entry.keys.map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
