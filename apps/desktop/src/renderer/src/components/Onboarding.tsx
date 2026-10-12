import { useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  ProviderId,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { KeyEntry } from './KeyEntry'

const PROVIDER_BLURBS: Record<ProviderId, string> = {
  anthropic: 'Claude models. Keys start with sk-ant-.',
  openai: 'GPT and o-series models. Keys start with sk-.',
  google: 'Gemini models. Keys start with AIza.',
}

interface Props {
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  /** Called once the key is saved — App then fetches the catalog, makes
   * sure a workspace + session exist, and selects a model. */
  onConnected: (created: ProviderConfigSummary) => Promise<void>
}

/**
 * First-run screen shown instead of a disabled composer when no provider
 * key exists yet. Happy path: paste a key → provider detected → tested →
 * saved → land in a new session with a model selected. No detour through
 * Settings.
 */
export function Onboarding({ add, test, onConnected }: Props) {
  const [preferred, setPreferred] = useState<ProviderId | null>(null)
  const [finishing, setFinishing] = useState(false)

  return (
    <div className="onboarding">
      <div className="onboarding__inner">
        <h1 className="page-title">Connect a model provider</h1>
        <p className="onboarding__lede">
          Bring your own API key. Every workspace can use any connected model — switch per message,
          or re-run an answer on another model.
        </p>

        <div className="rule-list onboarding__providers">
          {(Object.keys(PROVIDER_BLURBS) as ProviderId[]).map((provider) => (
            <button
              key={provider}
              type="button"
              className={`rule-list__row onboarding__provider${preferred === provider ? ' is-active' : ''}`}
              onClick={() => {
                setPreferred(provider)
                document.getElementById('key-entry-input')?.focus()
              }}
            >
              <span className="onboarding__provider-name">{PROVIDER_LABELS[provider]}</span>
              <span className="muted">{PROVIDER_BLURBS[provider]}</span>
            </button>
          ))}
        </div>

        {finishing ? (
          <p className="muted">connected — fetching models and opening a session…</p>
        ) : (
          <KeyEntry
            add={add}
            test={test}
            autoSave
            autoFocus
            preferredProvider={preferred}
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
