import { useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'
import { AddProvider } from './AddProvider'

interface Props {
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  /** Called once the key is saved — App then fetches the catalog, makes
   * sure a workspace + session exist, and selects a model. */
  onConnected: (created: ProviderConfigSummary) => Promise<void>
}

/**
 * First-run screen shown instead of a disabled composer when no provider
 * key exists yet. Happy path: pick a provider (or just paste a key — the
 * provider is recognised from its prefix) → tested → saved → land in a new
 * session with a model selected. Lists every provider the app can run, plus
 * Ollama and a custom endpoint. No detour through Settings.
 */
export function Onboarding({ add, test, onConnected }: Props) {
  const [finishing, setFinishing] = useState(false)

  return (
    <div className="onboarding">
      <div className="onboarding__inner">
        <h1 className="page-title">Connect a model provider</h1>
        <p className="onboarding__lede">
          Bring your own API key — or run a model locally. Every workspace can use any connected model: switch per
          message, or re-run an answer on another model.
        </p>

        {finishing ? (
          <p className="muted">connected — fetching models and opening a session…</p>
        ) : (
          <AddProvider
            add={add}
            test={test}
            autoSave
            autoFocus
            onSaved={(created) => {
              setFinishing(true)
              void onConnected(created).finally(() => setFinishing(false))
            }}
          />
        )}
      </div>
    </div>
  )
}
