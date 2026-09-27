import { useEffect, useRef, useState } from 'react'
import { useSettings } from './hooks/useSettings'
import { useWorkspaces } from './hooks/useWorkspaces'
import { useProviderConfigs } from './hooks/useProviderConfigs'
import { WorkspaceRail } from './components/shell/WorkspaceRail'
import { WorkspaceView, type WorkspaceViewHandle } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { CommandPalette, type WorkspaceCommandActions } from './components/CommandPalette'

export function App() {
  const { settings, update: updateSettings } = useSettings()
  const { workspaces, loading, error, create, rename, remove } = useWorkspaces()
  const {
    configs: providerConfigs,
    add: addProviderConfig,
    remove: removeProviderConfig,
    test: testProviderConfig,
  } = useProviderConfigs()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [workspaceActions, setWorkspaceActions] = useState<WorkspaceCommandActions | null>(null)
  const workspaceViewRef = useRef<WorkspaceViewHandle>(null)

  // Refs can't be read during render (see react-hooks/refs) — snapshot the
  // command actions in an effect right as the palette opens instead.
  useEffect(() => {
    if (commandPaletteOpen) {
      setWorkspaceActions(workspaceViewRef.current?.getCommandActions() ?? null)
    }
  }, [commandPaletteOpen])

  useEffect(() => {
    if (!settings) return
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings])

  // Cmd/Ctrl+K and Cmd/Ctrl+Shift+P both open the command palette (matches
  // opencode's DEFAULT_PALETTE_KEYBIND — see docs/UI_REFERENCE_OPENCODE.md §6).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'k' || (e.shiftKey && key === 'p')) {
        e.preventDefault()
        setCommandPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const activeWorkspace =
    workspaces.find((w) => w.id === settings?.activeWorkspaceId) ?? workspaces[0] ?? null

  useEffect(() => {
    if (!settings || loading) return
    if (!settings.activeWorkspaceId && activeWorkspace) {
      void updateSettings({ activeWorkspaceId: activeWorkspace.id })
    }
  }, [settings, loading, activeWorkspace, updateSettings])

  return (
    <div className="shell">
      <WorkspaceRail
        workspaces={workspaces}
        activeId={activeWorkspace?.id ?? null}
        onSelect={(id) => void updateSettings({ activeWorkspaceId: id })}
        onCreate={async (name) => {
          const created = await create({ name })
          await updateSettings({ activeWorkspaceId: created.id })
        }}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {settingsOpen && settings && (
        <SettingsPanel
          configs={providerConfigs}
          add={addProviderConfig}
          remove={removeProviderConfig}
          test={testProviderConfig}
          theme={settings.theme}
          onThemeChange={(theme) => void updateSettings({ theme })}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <main className="shell__workspace">
        {error && <p className="shell__error">Failed to load workspaces: {error}</p>}
        {!loading && (
          <WorkspaceView
            ref={workspaceViewRef}
            workspace={activeWorkspace}
            providerConfigs={providerConfigs}
            onRename={rename}
            onDelete={async (id) => {
              await remove(id)
              await updateSettings({ activeWorkspaceId: null })
            }}
            lastModelSelection={settings ? settings.lastModelSelection : undefined}
            onLastModelSelectionChange={(selection) =>
              void updateSettings({ lastModelSelection: selection })
            }
          />
        )}
      </main>

      {commandPaletteOpen && (
        <CommandPalette
          onClose={() => setCommandPaletteOpen(false)}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace?.id ?? null}
          onSwitchWorkspace={(id) => void updateSettings({ activeWorkspaceId: id })}
          onOpenSettings={() => setSettingsOpen(true)}
          workspaceActions={workspaceActions}
        />
      )}
    </div>
  )
}
