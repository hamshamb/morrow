import { useEffect, useState } from 'react'
import { useSettings } from './hooks/useSettings'
import { useWorkspaces } from './hooks/useWorkspaces'
import { useProviderConfigs } from './hooks/useProviderConfigs'
import { WorkspaceRail } from './components/shell/WorkspaceRail'
import { WorkspaceView } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'

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

  useEffect(() => {
    if (!settings) return
    document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings])

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
    </div>
  )
}
