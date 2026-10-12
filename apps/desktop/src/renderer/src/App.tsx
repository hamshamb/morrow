import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  pruneModelRefs,
  pushRecentModel,
  toggleFavoriteModel,
  type LastModelSelection,
  type ModelRef,
  type ProviderConfigSummary,
} from '@ai-workspace/shared'
import { useSettings } from './hooks/useSettings'
import { useWorkspaces } from './hooks/useWorkspaces'
import { useProviderConfigs } from './hooks/useProviderConfigs'
import { WorkspaceRail } from './components/shell/WorkspaceRail'
import { WorkspaceView, type WorkspaceViewHandle } from './components/WorkspaceView'
import { SettingsPanel } from './components/SettingsPanel'
import { CommandPalette, type WorkspaceCommandActions } from './components/CommandPalette'
import { KeyboardSheet } from './components/KeyboardSheet'
import { Onboarding } from './components/Onboarding'
import {
  ProviderRegistryProvider,
  useProviderRegistry,
  useProviderRegistryState,
} from './hooks/useProviderRegistry'
import { pickDefaultModel } from './lib/model-meta'
import { focusComposer, isTypingTarget } from './lib/focus'

export function App() {
  const registry = useProviderRegistryState()
  return (
    <ProviderRegistryProvider value={registry}>
      <AppShell />
    </ProviderRegistryProvider>
  )
}

function AppShell() {
  const registry = useProviderRegistry()
  const { settings, update: updateSettings } = useSettings()
  const { workspaces, loading, error, create, rename, remove } = useWorkspaces()
  const {
    configs: providerConfigs,
    loading: providersLoading,
    add: addProviderConfig,
    remove: removeProviderConfig,
    test: testProviderConfig,
  } = useProviderConfigs()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [keyboardOpen, setKeyboardOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [workspaceActions, setWorkspaceActions] = useState<WorkspaceCommandActions | null>(null)
  const [workspaceViewKey, setWorkspaceViewKey] = useState(0)
  const [version, setVersion] = useState<string | null>(null)
  const workspaceViewRef = useRef<WorkspaceViewHandle>(null)
  const overlayOpen = settingsOpen || keyboardOpen || commandPaletteOpen

  useEffect(() => {
    void window.api.app.getVersion().then(setVersion).catch(() => setVersion(null))
  }, [])

  useEffect(() => {
    if (settings) document.documentElement.setAttribute('data-theme', settings.theme)
  }, [settings])

  // Refs can't be read during render (react-hooks/refs) — snapshot the
  // command actions in an effect right as the palette opens.
  useEffect(() => {
    if (commandPaletteOpen) setWorkspaceActions(workspaceViewRef.current?.getCommandActions() ?? null)
  }, [commandPaletteOpen])

  const activeWorkspace = workspaces.find((w) => w.id === settings?.activeWorkspaceId) ?? workspaces[0] ?? null

  useEffect(() => {
    if (!settings || loading) return
    if (!settings.activeWorkspaceId && activeWorkspace) void updateSettings({ activeWorkspaceId: activeWorkspace.id })
  }, [settings, loading, activeWorkspace, updateSettings])

  const needsOnboarding = !providersLoading && providerConfigs.length === 0

  // Keyboard model (see KeyboardSheet). Overlays handle their own Esc and
  // mark it defaultPrevented; whatever's left closes the context panel and
  // returns focus to the composer.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()
      if (mod && (key === 'k' || (e.shiftKey && key === 'p'))) {
        e.preventDefault()
        setCommandPaletteOpen((v) => !v)
        return
      }
      if (overlayOpen || needsOnboarding) return
      if (mod && !e.shiftKey && key === 'n') {
        e.preventDefault()
        workspaceViewRef.current?.newSession()
      } else if (mod && !e.shiftKey && key === 'm') {
        e.preventDefault()
        workspaceViewRef.current?.openModelPicker()
      } else if (!mod && !e.altKey && key === 'c' && !isTypingTarget(e.target)) {
        e.preventDefault()
        workspaceViewRef.current?.newSession()
      } else if (e.key === 'Escape' && !e.defaultPrevented) {
        if (!workspaceViewRef.current?.dismissPanels()) focusComposer()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [overlayOpen, needsOnboarding])

  const configIds = useMemo(() => providerConfigs.map((c) => c.id), [providerConfigs])
  const favorites = useMemo(
    () => pruneModelRefs(settings?.favoriteModels ?? [], configIds),
    [settings?.favoriteModels, configIds],
  )
  const recents = useMemo(
    () => pruneModelRefs(settings?.recentModels ?? [], configIds),
    [settings?.recentModels, configIds],
  )

  const handleModelUsed = useCallback(
    (selection: LastModelSelection, setAsDefault: boolean) => {
      void updateSettings({
        ...(setAsDefault ? { lastModelSelection: selection } : {}),
        recentModels: pushRecentModel(recents, selection),
      })
    },
    [updateSettings, recents],
  )

  const handleToggleFavorite = useCallback(
    (ref: ModelRef) => void updateSettings({ favoriteModels: toggleFavoriteModel(favorites, ref) }),
    [updateSettings, favorites],
  )

  /** First-run happy path: key saved → fetch its catalog → make sure a
   * workspace and a fresh session exist → select the first model. */
  async function handleConnected(created: ProviderConfigSummary) {
    // The refresh joins the key's live list with models.dev; if it fails the
    // models.dev list for the provider is still there.
    const refreshed = await window.api.modelCatalog.refresh(created.id).catch(() => null)
    const catalog = refreshed?.catalog ?? (await window.api.modelCatalog.list(created.id).catch(() => null))
    const firstModel = pickDefaultModel(catalog?.models ?? [])
    let workspaceId = activeWorkspace?.id ?? null
    if (!workspaceId) {
      const ws = await create({ name: 'My workspace' })
      workspaceId = ws.id
    }
    await window.api.conversations.create({ workspaceId })
    const selection = firstModel ? { providerConfigId: created.id, model: firstModel, effort: null } : null
    await updateSettings({
      activeWorkspaceId: workspaceId,
      ...(selection ? { lastModelSelection: selection, recentModels: pushRecentModel([], selection) } : {}),
    })
    // Remount so the workspace view picks up the new session + selection.
    setWorkspaceViewKey((k) => k + 1)
    focusComposer()
  }

  return (
    <div className="shell">
      <WorkspaceRail
        workspaces={workspaces}
        activeId={activeWorkspace?.id ?? null}
        onSelect={(id) => {
          void updateSettings({ activeWorkspaceId: id })
          focusComposer()
        }}
        onCreate={async (name) => {
          const created = await create({ name })
          await updateSettings({ activeWorkspaceId: created.id })
        }}
      />

      <main className="shell__main">
        {error && <p className="signal shell__error">Failed to load workspaces: {error}</p>}
        {needsOnboarding ? (
          <Onboarding add={addProviderConfig} test={testProviderConfig} onConnected={handleConnected} />
        ) : (
          !loading &&
          !providersLoading && (
            <WorkspaceView
              key={workspaceViewKey}
              ref={workspaceViewRef}
              workspace={activeWorkspace}
              providerConfigs={providerConfigs}
              onRename={rename}
              onDelete={async (id) => {
                await remove(id)
                await updateSettings({ activeWorkspaceId: null })
              }}
              lastModelSelection={settings ? settings.lastModelSelection : undefined}
              onModelUsed={handleModelUsed}
              favorites={favorites}
              recents={recents}
              onToggleFavorite={handleToggleFavorite}
              onOpenKeyboard={() => setKeyboardOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              version={version}
            />
          )
        )}
      </main>

      {settingsOpen && settings && (
        <SettingsPanel
          configs={providerConfigs}
          add={addProviderConfig}
          remove={removeProviderConfig}
          test={testProviderConfig}
          theme={settings.theme}
          onThemeChange={(theme) => void updateSettings({ theme })}
          modelsDevFetchEnabled={settings.modelsDevFetchEnabled}
          onModelsDevFetchChange={(enabled) =>
            void updateSettings({ modelsDevFetchEnabled: enabled }).then(() => registry.refreshStatus())
          }
          onClose={() => {
            setSettingsOpen(false)
            focusComposer()
          }}
        />
      )}

      {keyboardOpen && (
        <KeyboardSheet
          onClose={() => {
            setKeyboardOpen(false)
            focusComposer()
          }}
        />
      )}

      {commandPaletteOpen && (
        <CommandPalette
          onClose={() => {
            setCommandPaletteOpen(false)
            focusComposer()
          }}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace?.id ?? null}
          onSwitchWorkspace={(id) => void updateSettings({ activeWorkspaceId: id })}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenKeyboard={() => setKeyboardOpen(true)}
          workspaceActions={workspaceActions}
        />
      )}
    </div>
  )
}
