import { useEffect, useRef, useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  ProviderId,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'
import { PROVIDER_LABELS } from '../lib/models'
import { detectProviderFromKey, looksLikeCompleteKey } from '../lib/provider-key'
import { describeProviderError } from '../lib/provider-error'

const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'google']
const AUTO_TEST_DEBOUNCE_MS = 400

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'saving' }

interface Props {
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  /** Called after the key is saved. */
  onSaved: (created: ProviderConfigSummary) => void
  /** Onboarding saves automatically once the test passes (zero detours);
   * Settings shows `connected` and waits for one explicit [save]. */
  autoSave: boolean
  /** Provider the user already picked (e.g. clicked in the onboarding
   * list) — used when the key prefix is unknown. */
  preferredProvider?: ProviderId | null
  autoFocus?: boolean
}

/**
 * Single "paste API key" field. The provider is detected from the key
 * prefix (`detectProviderFromKey`); if ambiguous, a one-row chooser
 * appears. The connection test runs automatically once the key looks
 * complete, and the result is shown inline in plain language. Storage is
 * unchanged — `providerConfigs.add` still encrypts via safeStorage in main.
 */
export function KeyEntry({ add, test, onSaved, autoSave, preferredProvider = null, autoFocus }: Props) {
  const [apiKey, setApiKey] = useState('')
  const [chosenProvider, setChosenProvider] = useState<ProviderId | null>(preferredProvider)
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const runId = useRef(0)

  useEffect(() => {
    if (preferredProvider) setChosenProvider(preferredProvider)
  }, [preferredProvider])

  const detected = detectProviderFromKey(apiKey)
  const provider = detected ?? chosenProvider
  const needsProviderChoice = looksLikeCompleteKey(apiKey) && !detected

  async function save(forProvider: ProviderId) {
    setStatus({ kind: 'saving' })
    try {
      const created = await add({
        provider: forProvider,
        label: label.trim() || PROVIDER_LABELS[forProvider],
        apiKey: apiKey.trim(),
        baseUrl: baseUrl.trim() || null,
      })
      setApiKey('')
      setLabel('')
      setBaseUrl('')
      setStatus({ kind: 'idle' })
      onSaved(created)
    } catch (err) {
      setStatus({ kind: 'error', message: describeProviderError(err instanceof Error ? err.message : String(err), 'key') })
    }
  }

  // Auto-test once the key looks complete and the provider is known.
  useEffect(() => {
    if (!provider || !looksLikeCompleteKey(apiKey)) {
      setStatus({ kind: 'idle' })
      return
    }
    const id = ++runId.current
    const timer = setTimeout(() => {
      setStatus({ kind: 'testing' })
      test({ provider, apiKey: apiKey.trim(), baseUrl: baseUrl.trim() || null })
        .then((result) => {
          if (id !== runId.current) return
          if (!result.ok) {
            setStatus({ kind: 'error', message: describeProviderError(result.message, 'key') })
            return
          }
          if (autoSave) void save(provider)
          else setStatus({ kind: 'ok' })
        })
        .catch((err: unknown) => {
          if (id !== runId.current) return
          setStatus({ kind: 'error', message: describeProviderError(err instanceof Error ? err.message : String(err), 'key') })
        })
    }, AUTO_TEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-test only when the key/provider/base URL change
  }, [apiKey, provider, baseUrl])

  return (
    <div className="key-entry">
      <label className="label" htmlFor="key-entry-input">
        paste api key
      </label>
      <input
        id="key-entry-input"
        className="input key-entry__input"
        type="password"
        autoComplete="off"
        spellCheck={false}
        placeholder="sk-ant-…  ·  sk-…  ·  AIza…"
        value={apiKey}
        autoFocus={autoFocus}
        onChange={(e) => setApiKey(e.target.value)}
      />

      <div className="key-entry__status">
        {detected && <span className="chip chip--outline">{PROVIDER_LABELS[detected]}</span>}
        {status.kind === 'idle' && !apiKey && (
          <span className="muted">The provider is detected from the key. Keys stay encrypted on this device.</span>
        )}
        {status.kind === 'testing' && <span className="muted">testing connection…</span>}
        {status.kind === 'saving' && <span className="muted">saving…</span>}
        {status.kind === 'ok' && <span className="ok">connected</span>}
        {status.kind === 'error' && <span className="signal">{status.message}</span>}
      </div>

      {needsProviderChoice && (
        <div className="key-entry__choose">
          <span className="muted">which provider is this key for?</span>
          <div className="segmented">
            {PROVIDERS.map((p) => (
              <button
                key={p}
                type="button"
                className={chosenProvider === p ? 'is-active' : ''}
                onClick={() => setChosenProvider(p)}
              >
                {PROVIDER_LABELS[p].toLowerCase()}
              </button>
            ))}
          </div>
        </div>
      )}

      {advanced ? (
        <div className="key-entry__advanced">
          <input
            className="input"
            placeholder={provider ? `label (default: ${PROVIDER_LABELS[provider]})` : 'label'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <input
            className="input"
            placeholder="custom base url (optional)"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </div>
      ) : (
        <button type="button" className="link-action key-entry__advanced-toggle" onClick={() => setAdvanced(true)}>
          [label / base url]
        </button>
      )}

      {!autoSave && status.kind === 'ok' && provider && (
        <div className="key-entry__actions">
          <button type="button" className="btn btn--primary" onClick={() => void save(provider)}>
            save key
          </button>
        </div>
      )}
    </div>
  )
}
