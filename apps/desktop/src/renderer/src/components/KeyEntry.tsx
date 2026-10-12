import { useEffect, useRef, useState } from 'react'
import type {
  AddProviderConfigInput,
  ProviderConfigSummary,
  ProviderRegistryEntry,
  TestProviderConfigInput,
  TestProviderConfigResult,
} from '@ai-workspace/shared'
import { detectProviderFromKey, looksLikeCompleteKey } from '../lib/provider-key'
import { describeProviderError } from '../lib/provider-error'

const AUTO_TEST_DEBOUNCE_MS = 400

type Status =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message?: string; warning?: string }
  | { kind: 'error'; message: string }
  | { kind: 'saving' }

interface Props {
  registry: ProviderRegistryEntry[]
  /** The provider chosen in the list above (or null: not chosen yet). */
  provider: ProviderRegistryEntry | null
  /** A pasted key's prefix identified a provider — the list highlights it. */
  onProviderDetected: (providerId: string) => void
  add: (input: AddProviderConfigInput) => Promise<ProviderConfigSummary>
  test: (input: TestProviderConfigInput) => Promise<TestProviderConfigResult>
  /** Called after the key is saved. */
  onSaved: (created: ProviderConfigSummary) => void
  /** Onboarding saves a *keyed* provider automatically once the test passes
   * (zero detours); Settings shows `connected` and waits for one explicit
   * [save key]. Keyless/local providers always wait for an explicit connect. */
  autoSave: boolean
  autoFocus?: boolean
}

/**
 * Single "paste API key" field. The provider comes from the list above (or is
 * detected from the key prefix via the registry); the connection test runs
 * automatically once the key looks complete and the result is shown inline in
 * plain language. Keyless providers (Ollama, LM Studio, custom endpoints) show a
 * base URL instead of a key and are verified by listing their models. Storage is
 * unchanged — `providerConfigs.add` still encrypts via safeStorage in main.
 */
export function KeyEntry({
  registry,
  provider: chosen,
  onProviderDetected,
  add,
  test,
  onSaved,
  autoSave,
  autoFocus,
}: Props) {
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const runId = useRef(0)

  const detectedId = detectProviderFromKey(apiKey, registry)
  const provider = (detectedId ? registry.find((e) => e.id === detectedId) : null) ?? chosen
  const providerId = provider?.id ?? null
  const keyless = !!provider && !provider.keyRequired
  const isCustom = provider?.kind === 'custom'
  const showBaseUrl = keyless || advanced

  // Tell the list which provider the pasted key belongs to.
  useEffect(() => {
    if (detectedId && detectedId !== chosen?.id) onProviderDetected(detectedId)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- notify only when detection changes
  }, [detectedId])

  // A different provider starts a fresh form: local ones prefill their URL.
  useEffect(() => {
    setBaseUrl(provider?.isLocal ? (provider.defaultBaseUrl ?? '') : '')
    setStatus({ kind: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the provider changes
  }, [providerId])

  function effectiveBaseUrl(): string | null {
    const trimmed = baseUrl.trim()
    if (!trimmed || (provider?.isLocal && trimmed === provider.defaultBaseUrl)) return null
    return trimmed
  }

  async function save() {
    if (!provider) return
    setStatus({ kind: 'saving' })
    try {
      const created = await add({
        provider: provider.id,
        label: label.trim() || provider.name,
        apiKey: apiKey.trim(),
        baseUrl: effectiveBaseUrl(),
      })
      setApiKey('')
      setLabel('')
      setStatus({ kind: 'idle' })
      onSaved(created)
    } catch (err) {
      setStatus({ kind: 'error', message: describeProviderError(err instanceof Error ? err.message : String(err), 'key') })
    }
  }

  // Auto-test once the form is complete enough to be worth a request.
  const readyToTest =
    !!provider && (provider.keyRequired ? looksLikeCompleteKey(apiKey) : !isCustom || baseUrl.trim().length > 0)
  useEffect(() => {
    if (!provider || !readyToTest) {
      setStatus({ kind: 'idle' })
      return
    }
    const id = ++runId.current
    const timer = setTimeout(() => {
      setStatus({ kind: 'testing' })
      test({ provider: provider.id, apiKey: apiKey.trim(), baseUrl: effectiveBaseUrl() })
        .then((result) => {
          if (id !== runId.current) return
          if (!result.ok) {
            setStatus({ kind: 'error', message: describeProviderError(result.message, 'key') })
            return
          }
          // A warning (key works, test model out of quota) waits for the user
          // instead of auto-saving past it unseen.
          if (autoSave && provider.keyRequired && !result.warning) void save()
          else
            setStatus({
              kind: 'ok',
              ...(result.message ? { message: result.message } : {}),
              ...(result.warning ? { warning: result.warning } : {}),
            })
        })
        .catch((err: unknown) => {
          if (id !== runId.current) return
          setStatus({ kind: 'error', message: describeProviderError(err instanceof Error ? err.message : String(err), 'key') })
        })
    }, AUTO_TEST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-test only when the key/provider/base URL change
  }, [apiKey, providerId, baseUrl, readyToTest])

  return (
    <div className="key-entry">
      {!keyless || isCustom ? (
        <>
          <label className="label" htmlFor="key-entry-input">
            {isCustom ? 'api key (optional)' : 'paste api key'}
          </label>
          <input
            id="key-entry-input"
            className="input key-entry__input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={isCustom ? 'leave empty if the server needs no key' : 'sk-ant-…  ·  xai-…  ·  gsk_…  ·  AIza…'}
            value={apiKey}
            autoFocus={autoFocus}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </>
      ) : (
        <div className="label">{provider?.name} runs on this machine — no key needed</div>
      )}

      {showBaseUrl && (
        <>
          <label className="label" htmlFor="key-entry-base-url">
            {isCustom ? 'base url (required)' : 'base url'}
          </label>
          <input
            id="key-entry-base-url"
            className="input"
            placeholder={isCustom ? 'http://localhost:8000/v1' : (provider?.defaultBaseUrl ?? 'https://…')}
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </>
      )}

      <div className="key-entry__status">
        {provider && <span className="chip chip--outline">{provider.name}</span>}
        {status.kind === 'idle' && !provider && (
          <span className="muted">
            Pick a provider above, or paste a key — it is recognised from its prefix. Keys stay encrypted on this device.
          </span>
        )}
        {status.kind === 'idle' && provider && !readyToTest && provider.keyRequired && (
          <span className="muted">paste the {provider.name} key to connect</span>
        )}
        {status.kind === 'testing' && <span className="muted">testing connection…</span>}
        {status.kind === 'saving' && <span className="muted">saving…</span>}
        {status.kind === 'ok' && <span className="ok">connected{status.message ? ` · ${status.message}` : ''}</span>}
        {status.kind === 'error' && <span className="signal">{status.message}</span>}
      </div>
      {status.kind === 'ok' && status.warning && <p className="key-entry__warning">{status.warning}</p>}

      {!provider && looksLikeCompleteKey(apiKey) && (
        <div className="key-entry__choose">
          <span className="muted">
            This key&rsquo;s prefix is shared by several providers — choose one from the list above.
          </span>
        </div>
      )}

      {advanced ? (
        <div className="key-entry__advanced">
          <input
            className="input"
            placeholder={provider ? `label (default: ${provider.name})` : 'label'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
      ) : (
        <button type="button" className="link-action key-entry__advanced-toggle" onClick={() => setAdvanced(true)}>
          [label{keyless ? '' : ' / base url'}]
        </button>
      )}

      {status.kind === 'ok' && provider && (!autoSave || !provider.keyRequired || status.warning) && (
        <div className="key-entry__actions">
          <button type="button" className="btn btn--primary" onClick={() => void save()}>
            {!provider.keyRequired ? 'connect' : autoSave ? 'continue' : 'save key'}
          </button>
        </div>
      )}
    </div>
  )
}
