import { useEffect, useRef, useState } from 'react'
import {
  AUTO_PREFERENCES,
  DEFAULT_AGENT_FOR_MODE,
  effectiveTools,
  COMPARE_MAX_MODELS,
  COMPOSER_MODES,
  COMPOSER_MODE_LABELS,
  ROLE_LABEL_TEXT,
  ROUND_TABLE_MAX_PARTICIPANTS,
  ROUND_TABLE_MAX_ROUNDS,
  type AgentDefinition,
  type AutoPreference,
  type ComposerMode,
  type LastModelSelection,
  type ModelRef,
  type ProviderConfigSummary,
  type ProviderModelCatalog,
} from '@ai-workspace/shared'
import { useProviderRegistry } from '../hooks/useProviderRegistry'
import { findDisplayName, shortModelName } from '../lib/model-label'
import {
  defaultRoleAt,
  moveSlot,
  nextRole,
  type ModeConfig,
  type ModelSlot,
  type RoundTableSlot,
} from '../lib/orchestration-ui'
import { ModelPicker } from './ModelPicker'
import { focusComposer } from '../lib/focus'

const MODE_BLURBS: Record<ComposerMode, string> = {
  chat: 'one model — the default',
  plan: 'read-only agent: inspect and plan',
  build: 'agent edits and runs, you approve',
  compare: '2–4 models, side by side',
  review: 'a second model reviews',
  roundtable: 'propose, critique, synthesize',
  auto: 'the app picks, by readable rules',
}

interface ModeChipProps {
  mode: ComposerMode
  onChange: (mode: ComposerMode) => void
  disabled: boolean
  /** Incrementing opens the menu (palette / shortcut). */
  openSignal: number
  /** Does the selected model support tool calls? Plan and Build need it (models.dev `tool_call`). */
  toolSupport: 'yes' | 'no' | 'unknown'
}

const AGENT_MODES: ComposerMode[] = ['plan', 'build']

/**
 * The composer's one small mode chip — `chat ▾` — next to the model chip.
 * The other four modes live behind it (and in the command palette); picking
 * one reveals only that mode's controls. Arrow keys / Enter / Esc.
 */
export function ModeChip({ mode, onChange, disabled, openSignal, toolSupport }: ModeChipProps) {
  const blocked = (m: ComposerMode): boolean => AGENT_MODES.includes(m) && toolSupport === 'no'
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const lastSignal = useRef(openSignal)
  useEffect(() => {
    if (openSignal !== lastSignal.current) {
      lastSignal.current = openSignal
      setHighlighted(Math.max(COMPOSER_MODES.indexOf(mode), 0))
      setOpen(true)
    }
  }, [openSignal, mode])

  useEffect(() => {
    if (!open) return
    menuRef.current?.focus()
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  function pick(next: ComposerMode) {
    if (blocked(next)) return
    setOpen(false)
    onChange(next)
    focusComposer()
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      focusComposer()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlighted((h) => Math.min(h + 1, COMPOSER_MODES.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlighted((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const next = COMPOSER_MODES[highlighted]
      if (next) pick(next)
    }
  }

  return (
    <div className="mode-chip" ref={containerRef}>
      <button
        type="button"
        className={`chip mode-chip__trigger ${mode === 'chat' ? 'chip--outline' : 'chip--inverted'}`}
        onClick={() => {
          setHighlighted(Math.max(COMPOSER_MODES.indexOf(mode), 0))
          setOpen((v) => !v)
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="mode: chat, plan, build, compare, review, round table, auto (Ctrl+Shift+M)"
      >
        {COMPOSER_MODE_LABELS[mode]}
        <span className="mode-chip__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div
          className="popover popover--above mode-menu"
          role="menu"
          aria-label="Composer mode"
          tabIndex={-1}
          ref={menuRef}
          onKeyDown={onKeyDown}
        >
          <div className="label mode-menu__title">mode</div>
          {COMPOSER_MODES.map((m, index) => (
            <button
              key={m}
              type="button"
              role="menuitemradio"
              aria-checked={m === mode}
              aria-disabled={blocked(m) || undefined}
              className={`mode-menu__item${index === highlighted ? ' is-highlighted' : ''}${m === mode ? ' is-selected' : ''}${blocked(m) ? ' is-disabled' : ''}`}
              onMouseEnter={() => setHighlighted(index)}
              onClick={() => pick(m)}
              title={blocked(m) ? 'This model has no tool support, so it cannot run Plan or Build.' : undefined}
            >
              <span className="mode-menu__name">{COMPOSER_MODE_LABELS[m]}</span>
              <span className="mode-menu__blurb">{blocked(m) ? 'this model has no tool support — pick another model' : MODE_BLURBS[m]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type PickerTarget =
  | { kind: 'compare-add' }
  | { kind: 'compare'; index: number }
  | { kind: 'reviewer' }
  | { kind: 'rt-add' }
  | { kind: 'rt'; index: number }
  | { kind: 'synth' }

interface ModeControlsProps {
  /** The built-in agents (merged with the user's edits), for the Plan / Build agent picker. */
  agents: AgentDefinition[]
  config: ModeConfig
  onChange: (next: ModeConfig) => void
  configs: ProviderConfigSummary[]
  catalogs: Record<string, ProviderModelCatalog>
  favorites: ModelRef[]
  recents: LastModelSelection[]
  onToggleFavorite: (ref: ModelRef) => void
  /** Review: the composer's own model is the one that answers. */
  primaryLabel: string | null
  autoPreference: AutoPreference
  onAutoPreferenceChange: (preference: AutoPreference) => void
  /** Why Send is disabled in this mode (null = ready). */
  problem: string | null
}

/** The extra controls of the active mode — nothing renders in `chat`. */
export function ModeControls({
  agents,
  config,
  onChange,
  configs,
  catalogs,
  favorites,
  recents,
  onToggleFavorite,
  primaryLabel,
  autoPreference,
  onAutoPreferenceChange,
  problem,
}: ModeControlsProps) {
  const registry = useProviderRegistry()
  const [picker, setPicker] = useState<PickerTarget | null>(null)

  if (config.mode === 'chat') return null
  const agentMode = config.mode === 'plan' || config.mode === 'build' ? config.mode : null
  const chosenAgentId = config.agentId ?? (agentMode ? DEFAULT_AGENT_FOR_MODE[agentMode] : null)
  const chosenAgent = agents.find((a) => a.id === chosenAgentId) ?? null

  const nameOf = (ref: ModelRef): string => shortModelName(ref.model, findDisplayName(catalogs, ref.model))
  const providerOf = (ref: ModelRef): string => {
    const cfg = configs.find((c) => c.id === ref.providerConfigId)
    return cfg ? registry.label(cfg.provider) : ''
  }
  const toSlot = (option: { providerConfigId: string; modelId: string }): ModelSlot => ({
    providerConfigId: option.providerConfigId,
    model: option.modelId,
    effort: null,
  })

  function closePicker() {
    setPicker(null)
    focusComposer()
  }

  function applyPick(option: { providerConfigId: string; modelId: string }) {
    if (!picker) return
    const slot = toSlot(option)
    switch (picker.kind) {
      case 'compare-add':
        onChange({ ...config, compare: [...config.compare, slot].slice(0, COMPARE_MAX_MODELS) })
        break
      case 'compare':
        onChange({ ...config, compare: config.compare.map((s, i) => (i === picker.index ? slot : s)) })
        break
      case 'reviewer':
        onChange({ ...config, reviewer: slot })
        break
      case 'rt-add': {
        const role = defaultRoleAt(config.roundTable.length)
        onChange({ ...config, roundTable: [...config.roundTable, { ...slot, role }].slice(0, ROUND_TABLE_MAX_PARTICIPANTS) })
        break
      }
      case 'rt':
        onChange({
          ...config,
          roundTable: config.roundTable.map((s, i) => (i === picker.index ? { ...slot, role: s.role } : s)),
        })
        break
      case 'synth':
        onChange({ ...config, synthesizer: slot })
        break
    }
    closePicker()
  }

  const selectedForPicker = ((): ModelRef | null => {
    if (!picker) return null
    switch (picker.kind) {
      case 'compare':
        return config.compare[picker.index] ?? null
      case 'reviewer':
        return config.reviewer
      case 'rt':
        return config.roundTable[picker.index] ?? null
      case 'synth':
        return config.synthesizer
      default:
        return null
    }
  })()

  const slotChip = (slot: ModelSlot, target: PickerTarget, onRemove?: () => void, extraClass = '') => (
    <span className={`slot-chip ${extraClass}`} key={`${slot.providerConfigId}:${slot.model}:${JSON.stringify(target)}`}>
      <button
        type="button"
        className="chip chip--outline slot-chip__button"
        onClick={() => setPicker(target)}
        title="change model"
      >
        {nameOf(slot)} · {providerOf(slot)}
        <span className="mode-chip__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {onRemove && (
        <button type="button" className="link-action slot-chip__remove" onClick={onRemove} aria-label={`Remove ${nameOf(slot)}`}>
          [x]
        </button>
      )}
    </span>
  )

  const addButton = (label: string, target: PickerTarget) => (
    <button type="button" className="link-action" onClick={() => setPicker(target)}>
      {label}
    </button>
  )

  return (
    <div className="mode-row" role="group" aria-label={`${COMPOSER_MODE_LABELS[config.mode]} options`}>
      {agentMode && (
        <div className="mode-row__line">
          <span className="label mode-row__label">{agentMode}</span>
          <label className="mode-row__text">
            <span className="muted">agent</span>{' '}
            <select
              className="agent-select"
              value={chosenAgentId ?? ''}
              onChange={(e) => onChange({ ...config, agentId: e.target.value === DEFAULT_AGENT_FOR_MODE[agentMode] ? null : e.target.value })}
              aria-label="Agent"
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.permissionCeiling === 'read-only' ? ' · read-only' : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="mode-row__hint">
            {chosenAgent
              ? `${effectiveTools(chosenAgent, agentMode).length} tools · ${
                  agentMode === 'plan' ? 'cannot change files' : chosenAgent.permissionCeiling === 'read-only' ? 'read-only agent: no edits, no commands' : 'every edit and command asks you first'
                }`
              : ''}
          </span>
        </div>
      )}

      {config.mode === 'compare' && (
        <div className="mode-row__line">
          <span className="label mode-row__label">compare</span>
          <div className="mode-row__slots">
            {config.compare.map((slot, i) =>
              slotChip(slot, { kind: 'compare', index: i }, config.compare.length > 2 ? () => onChange({ ...config, compare: config.compare.filter((_, j) => j !== i) }) : undefined, i === 0 ? 'is-first' : ''),
            )}
            {config.compare.length < COMPARE_MAX_MODELS && addButton('[+ add model]', { kind: 'compare-add' })}
          </div>
          <span className="mode-row__hint">{config.compare.length}/{COMPARE_MAX_MODELS} · the first column is used for context unless you pick another</span>
        </div>
      )}

      {config.mode === 'review' && (
        <div className="mode-row__line">
          <span className="label mode-row__label">review</span>
          <span className="mode-row__text">
            <span className="muted">answers</span> {primaryLabel ?? '—'} <span className="muted">→ reviewer</span>
          </span>
          <div className="mode-row__slots">
            {config.reviewer ? slotChip(config.reviewer, { kind: 'reviewer' }) : addButton('[choose a reviewer]', { kind: 'reviewer' })}
          </div>
          <span className="mode-row__hint">the answer is never rewritten; the review is a separate block</span>
        </div>
      )}

      {config.mode === 'roundtable' && (
        <div className="mode-row__table">
          <div className="mode-row__line">
            <span className="label mode-row__label">round table</span>
            <span className="mode-row__hint">turns run in this order · hard cap {ROUND_TABLE_MAX_ROUNDS} rounds</span>
          </div>
          {config.roundTable.map((turn: RoundTableSlot, i) => (
            <div className="mode-row__turn" key={`${i}:${turn.providerConfigId}:${turn.model}`}>
              <span className="mode-row__turn-index">{i + 1}</span>
              <button
                type="button"
                className="chip chip--outline chip--role slot-role"
                disabled={i === 0}
                onClick={() =>
                  onChange({ ...config, roundTable: config.roundTable.map((s, j) => (j === i ? { ...s, role: nextRole(s.role) } : s)) })
                }
                title={i === 0 ? 'the first turn is always the proposal' : 'click to change the role'}
              >
                {ROLE_LABEL_TEXT[turn.role]}
              </button>
              {slotChip(turn, { kind: 'rt', index: i })}
              <span className="mode-row__turn-tools">
                <button type="button" className="link-action" disabled={i <= 1} onClick={() => onChange({ ...config, roundTable: moveSlot(config.roundTable, i, -1) })} aria-label="Move earlier">
                  [↑]
                </button>
                <button type="button" className="link-action" disabled={i === 0 || i === config.roundTable.length - 1} onClick={() => onChange({ ...config, roundTable: moveSlot(config.roundTable, i, 1) })} aria-label="Move later">
                  [↓]
                </button>
                {config.roundTable.length > 2 && i > 0 && (
                  <button type="button" className="link-action" onClick={() => onChange({ ...config, roundTable: config.roundTable.filter((_, j) => j !== i) })} aria-label="Remove turn">
                    [x]
                  </button>
                )}
              </span>
            </div>
          ))}
          <div className="mode-row__line">
            {config.roundTable.length < ROUND_TABLE_MAX_PARTICIPANTS && addButton('[+ add turn]', { kind: 'rt-add' })}
            <span className="mode-row__text">
              <span className="muted">synthesizer</span>{' '}
              {config.synthesizer ? (
                <>
                  {slotChip(config.synthesizer, { kind: 'synth' }, () => onChange({ ...config, synthesizer: null }))}
                </>
              ) : (
                addButton('[+ add]', { kind: 'synth' })
              )}
            </span>
            <span className="mode-row__text">
              <span className="muted">rounds</span>{' '}
              <button type="button" className="link-action" disabled={config.rounds <= 1} onClick={() => onChange({ ...config, rounds: config.rounds - 1 })} aria-label="Fewer rounds">
                [−]
              </button>{' '}
              <strong>
                {config.rounds}/{ROUND_TABLE_MAX_ROUNDS}
              </strong>{' '}
              <button type="button" className="link-action" disabled={config.rounds >= ROUND_TABLE_MAX_ROUNDS} onClick={() => onChange({ ...config, rounds: config.rounds + 1 })} aria-label="More rounds">
                [+]
              </button>
            </span>
          </div>
        </div>
      )}

      {config.mode === 'auto' && (
        <div className="mode-row__line">
          <span className="label mode-row__label">auto</span>
          <div className="segmented" role="radiogroup" aria-label="Auto preference">
            {AUTO_PREFERENCES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={p === autoPreference}
                className={p === autoPreference ? 'is-active' : ''}
                onClick={() => onAutoPreferenceChange(p)}
              >
                {p}
              </button>
            ))}
          </div>
          <span className="mode-row__hint">
            picks from the models you have keys for — vision, context size, price and reasoning decide; the reason is shown on the reply
          </span>
        </div>
      )}

      {problem && <p className="mode-row__problem">{problem}</p>}

      {picker && (
        <div className="popover popover--above mode-row__picker">
          <ModelPicker
            title={pickerTitle(picker)}
            configs={configs}
            catalogs={catalogs}
            selected={selectedForPicker}
            favorites={favorites}
            recents={recents}
            onToggleFavorite={onToggleFavorite}
            onClose={closePicker}
            onSelect={(option) => applyPick(option)}
          />
        </div>
      )}
    </div>
  )
}

function pickerTitle(target: PickerTarget): string {
  switch (target.kind) {
    case 'compare-add':
      return 'add a model to compare'
    case 'compare':
      return 'change this column'
    case 'reviewer':
      return 'reviewer'
    case 'rt-add':
      return 'add a turn'
    case 'rt':
      return 'change this turn'
    case 'synth':
      return 'synthesizer'
  }
}
