import { useEffect, useState } from 'react'
import { AGENT_LIMITS, clampAgentLimits, effectiveTools, type AgentDefinition, type AgentLimits } from '@ai-workspace/shared'

interface Props {
  limits: AgentLimits
  onLimitsChange: (limits: AgentLimits) => void
  onAgentsChanged: () => void
}

const LIMIT_ROWS: { key: keyof AgentLimits; label: string; unit: string; spec: { min: number; hardCap: number } }[] = [
  { key: 'maxSteps', label: 'max steps per run', unit: 'model calls', spec: AGENT_LIMITS.maxSteps },
  { key: 'maxWallSeconds', label: 'max time per run', unit: 'seconds', spec: AGENT_LIMITS.maxWallSeconds },
  { key: 'commandTimeoutSeconds', label: 'command timeout', unit: 'seconds', spec: AGENT_LIMITS.commandTimeoutSeconds },
]

/**
 * Settings -> Agents: the limits that bound every run, and the agents themselves (data, not code). Instructions can
 * be edited; the tools and the permission ceiling of a built-in agent cannot - an edit can never raise what an
 * agent is allowed to do, and the safety rules in the base prompt are not part of the editable text.
 */
export function AgentSettings({ limits, onLimitsChange, onAgentsChanged }: Props) {
  const [agents, setAgents] = useState<AgentDefinition[] | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [draftLimits, setDraftLimits] = useState<Record<keyof AgentLimits, string>>({
    maxSteps: String(limits.maxSteps),
    maxWallSeconds: String(limits.maxWallSeconds),
    commandTimeoutSeconds: String(limits.commandTimeoutSeconds),
  })

  useEffect(() => {
    void window.api.agent.listAgents().then(setAgents)
  }, [])

  function saveLimits() {
    const parsed = clampAgentLimits({
      maxSteps: Number(draftLimits.maxSteps),
      maxWallSeconds: Number(draftLimits.maxWallSeconds),
      commandTimeoutSeconds: Number(draftLimits.commandTimeoutSeconds),
    })
    onLimitsChange(parsed)
    setDraftLimits({ maxSteps: String(parsed.maxSteps), maxWallSeconds: String(parsed.maxWallSeconds), commandTimeoutSeconds: String(parsed.commandTimeoutSeconds) })
    setNote('limits saved — they apply to the next run')
  }

  async function saveInstructions(agent: AgentDefinition) {
    const next = await window.api.agent.updateAgent({ agentId: agent.id, override: { instructions: draft } })
    setAgents(next)
    onAgentsChanged()
    setNote(`${agent.name}: instructions saved`)
  }

  async function reset(agent: AgentDefinition) {
    const next = await window.api.agent.updateAgent({ agentId: agent.id, override: null })
    setAgents(next)
    setDraft(next.find((a) => a.id === agent.id)?.instructions ?? '')
    onAgentsChanged()
    setNote(`${agent.name}: back to the built-in instructions`)
  }

  return (
    <>
      <h3 className="section-title">Agents</h3>
      <div className="label">limits</div>
      <p className="settings__note">
        Every Plan / Build run is bounded: it stops at the step limit or the time limit, and a single command is killed at its timeout.
        Each has a hard ceiling that this screen cannot exceed.
      </p>
      <div className="rule-list settings__limits">
        {LIMIT_ROWS.map((row) => (
          <label key={row.key} className="rule-list__row settings__limit">
            <span className="settings__limit-label">{row.label}</span>
            <input
              className="input settings__limit-input"
              type="number"
              inputMode="numeric"
              min={row.spec.min}
              max={row.spec.hardCap}
              value={draftLimits[row.key]}
              onChange={(e) => setDraftLimits((d) => ({ ...d, [row.key]: e.target.value }))}
              aria-label={row.label}
            />
            <span className="muted">
              {row.unit} · {row.spec.min}–{row.spec.hardCap}
            </span>
          </label>
        ))}
      </div>
      <div className="settings__actions">
        <button type="button" className="link-action" onClick={saveLimits}>
          [save limits]
        </button>
        {note && <span className="ok">{note}</span>}
      </div>

      <div className="label settings__add-label">agents</div>
      {agents === null ? (
        <p className="muted">loading…</p>
      ) : (
        <div className="rule-list" role="list">
          {agents.map((agent) => {
            const open = openId === agent.id
            const buildTools = effectiveTools(agent, 'build').length
            return (
              <div key={agent.id} className="agent-def" role="listitem">
                <button
                  type="button"
                  className="rule-list__row agent-def__head"
                  aria-expanded={open}
                  onClick={() => {
                    setOpenId(open ? null : agent.id)
                    setDraft(agent.instructions)
                    setNote(null)
                  }}
                >
                  <span className="agent-def__name">{agent.name}</span>
                  <span className={`chip ${agent.permissionCeiling === 'read-only' ? 'chip--outline' : 'chip--inverted'}`}>{agent.permissionCeiling === 'read-only' ? 'read-only' : 'can edit + run'}</span>
                  <span className="muted agent-def__desc">{agent.description}</span>
                  <span className="agent-row__chevron" aria-hidden="true">
                    {open ? '▾' : '▸'}
                  </span>
                </button>
                {open && (
                  <div className="agent-def__body">
                    <div className="agent-def__facts muted">
                      <span>{buildTools} tools in Build</span>
                      <span>ceiling: {agent.permissionCeiling}</span>
                      <span>context: {agent.contextPolicy === 'conversation' ? 'the conversation so far' : 'this request only'}</span>
                      <span>model: {agent.modelPreference?.model ?? 'whatever the composer has selected'}</span>
                    </div>
                    <div className="label">instructions (added after the app&rsquo;s fixed safety rules)</div>
                    <textarea className="input agent-def__instructions" rows={5} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label={`${agent.name} instructions`} />
                    <div className="settings__actions">
                      <button type="button" className="link-action" onClick={() => void saveInstructions(agent)} disabled={draft === agent.instructions}>
                        [save]
                      </button>
                      <button type="button" className="link-action" onClick={() => void reset(agent)}>
                        [reset to default]
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}
