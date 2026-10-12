import { useState, type ReactNode } from 'react'
import { ROLE_LABEL_TEXT, type RoleLabel } from '@ai-workspace/shared'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { describeProviderError } from '../lib/provider-error'
import { replyStats, type ReplyView } from '../lib/orchestration-ui'
import { Markdown } from './Markdown'

/** `SONNET 5 · ANTHROPIC` — the outline chip every reply carries. */
export function ModelChip({ provider, label }: { provider: string | null; label: string }) {
  const registry = useProviderRegistry()
  return (
    <span className="chip chip--outline">
      {label}
      {provider ? ` · ${registry.label(provider)}` : ''}
    </span>
  )
}

/** `PROPOSAL`, `CRITIQUE`, `ALTERNATIVE`, `SYNTHESIS`, `REVIEW`, `REVISED` — outline, uppercase. */
export function RoleChip({ role }: { role: RoleLabel }) {
  return <span className="chip chip--outline chip--role">{ROLE_LABEL_TEXT[role]}</span>
}

/** The reply later turns will continue from (inverted = active, per nochan). */
export function InContextChip() {
  return (
    <span className="chip chip--inverted" title="later turns continue from this reply">
      IN CONTEXT
    </span>
  )
}

export function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="link-action"
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }
    >
      {copied ? '[copied]' : '[copy]'}
    </button>
  )
}

/** Plain-language error with `[retry]` and `[switch model]`. */
export function ErrorLine({
  error,
  onRetry,
  onSwitchModel,
  retryLabel = '[retry]',
}: {
  error: string | null
  onRetry: () => void
  onSwitchModel?: () => void
  retryLabel?: string
}) {
  return (
    <div className="error-line" role="alert">
      <span className="error-line__text">{describeProviderError(error ?? '')}</span>
      <button type="button" className="link-action" onClick={onRetry}>
        {retryLabel}
      </button>
      {onSwitchModel && (
        <button type="button" className="link-action" onClick={onSwitchModel}>
          [switch model]
        </button>
      )}
    </div>
  )
}

/** Body of a reply that may still be streaming: markdown, or the block cursor. */
export function ReplyBody({ view }: { view: ReplyView }) {
  if (view.phase === 'waiting') return <p className="muted reply-body__waiting">waiting for the model…</p>
  if (view.phase === 'streaming') {
    return view.text ? (
      <Markdown streaming>{view.text}</Markdown>
    ) : (
      <div className="prose">
        <span className="stream-cursor" aria-label="generating">
          ▍
        </span>
      </div>
    )
  }
  return view.text ? <Markdown>{view.text}</Markdown> : null
}

/** One muted line: `2.4s · 1.2K in · 340 out · est. $0.0042` (— when the price is unknown). */
export function StatsLine({ view, prefix }: { view: ReplyView; prefix?: ReactNode }) {
  const stats = replyStats(view)
  return (
    <span className="stats-line" title="est. = models.dev price per 1M tokens x the usage the provider reported">
      {prefix}
      {stats}
    </span>
  )
}
