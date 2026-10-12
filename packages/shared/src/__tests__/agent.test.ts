import { describe, expect, it } from 'vitest'
import {
  AGENT_LIMITS,
  AgentDefinitionSchema,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_FOR_MODE,
  READ_ONLY_TOOLS,
  RespondPermissionInputSchema,
  RunAgentInputSchema,
  TOOL_IDS,
  clampAgentLimits,
  effectiveTools,
  resolveAgents,
  toolSupportOf,
  toolWireName,
  type ToolId,
} from '../agent'

describe('tool wire names', () => {
  it('replaces the dot so Anthropic and OpenAI accept the name', () => {
    for (const id of TOOL_IDS) expect(toolWireName(id)).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(toolWireName('filesystem.read')).toBe('filesystem_read')
    // And the mapping is injective, so a wire name always maps back to one tool.
    expect(new Set(TOOL_IDS.map(toolWireName)).size).toBe(TOOL_IDS.length)
  })
})

describe('agent limits', () => {
  it('uses the defaults for missing or nonsense values', () => {
    expect(clampAgentLimits(undefined)).toEqual({ maxSteps: 25, maxWallSeconds: 1200, commandTimeoutSeconds: 120 })
    expect(clampAgentLimits({ maxSteps: Number.NaN })).toMatchObject({ maxSteps: 25 })
  })

  it('enforces the hard caps and minimums', () => {
    expect(clampAgentLimits({ maxSteps: 100_000 }).maxSteps).toBe(AGENT_LIMITS.maxSteps.hardCap)
    expect(clampAgentLimits({ maxSteps: 0 }).maxSteps).toBe(AGENT_LIMITS.maxSteps.min)
    expect(clampAgentLimits({ maxWallSeconds: 10 ** 9 }).maxWallSeconds).toBe(AGENT_LIMITS.maxWallSeconds.hardCap)
    expect(clampAgentLimits({ commandTimeoutSeconds: 1 }).commandTimeoutSeconds).toBe(AGENT_LIMITS.commandTimeoutSeconds.min)
    expect(clampAgentLimits({ commandTimeoutSeconds: 99999 }).commandTimeoutSeconds).toBe(AGENT_LIMITS.commandTimeoutSeconds.hardCap)
  })
})

describe('built-in agents', () => {
  it('ships the six agents, all valid', () => {
    expect(BUILTIN_AGENTS.map((a) => a.name)).toEqual([
      'General Assistant',
      'Repository Analyst',
      'Planner',
      'Implementer',
      'Reviewer',
      'Test Engineer',
    ])
    for (const agent of BUILTIN_AGENTS) expect(() => AgentDefinitionSchema.parse(agent)).not.toThrow()
    expect(new Set(BUILTIN_AGENTS.map((a) => a.id)).size).toBe(BUILTIN_AGENTS.length)
  })

  it('Planner, Repository Analyst and Reviewer have read-only ceilings and no write/execution tool listed', () => {
    for (const id of ['planner', 'repo-analyst', 'reviewer']) {
      const agent = BUILTIN_AGENTS.find((a) => a.id === id)
      expect(agent?.permissionCeiling).toBe('read-only')
      expect(agent?.allowedTools.every((t) => READ_ONLY_TOOLS.includes(t))).toBe(true)
    }
  })

  it('defaults Plan to the Planner and Build to the Implementer', () => {
    expect(DEFAULT_AGENT_FOR_MODE).toEqual({ plan: 'planner', build: 'implementer' })
  })

  it('merges user overrides over the built-ins without touching tools or ceilings', () => {
    const merged = resolveAgents({
      planner: { instructions: 'Custom.', modelPreference: { providerConfigId: 'p', model: 'm' } },
      // An override cannot raise a ceiling: the schema has no such field, and unknown keys are ignored by resolveAgents.
      reviewer: { instructions: 'x', permissionCeiling: 'build', allowedTools: ['terminal.execute'] } as never,
    })
    const planner = merged.find((a) => a.id === 'planner')
    expect(planner).toMatchObject({ instructions: 'Custom.', modelPreference: { providerConfigId: 'p', model: 'm' } })
    const reviewer = merged.find((a) => a.id === 'reviewer')
    expect(reviewer?.permissionCeiling).toBe('read-only')
    expect(reviewer?.allowedTools).not.toContain('terminal.execute')
  })
})

describe('effectiveTools - what a run may use', () => {
  const agent = (id: string) => BUILTIN_AGENTS.find((a) => a.id === id)!
  const has = (tools: ToolId[], id: ToolId) => tools.includes(id)

  it('Build + a build agent gets every tool', () => {
    expect(effectiveTools(agent('implementer'), 'build')).toEqual([...TOOL_IDS])
  })

  it('Plan gets read tools plus the terminal (which will ask every time) and no file writes', () => {
    const tools = effectiveTools(agent('implementer'), 'plan')
    expect(has(tools, 'terminal.execute')).toBe(true)
    expect(has(tools, 'filesystem.write')).toBe(false)
    expect(has(tools, 'filesystem.patch')).toBe(false)
    expect(has(tools, 'filesystem.read')).toBe(true)
  })

  it('a read-only ceiling never gets a write or execution tool, even in Build mode', () => {
    for (const id of ['planner', 'repo-analyst', 'reviewer']) {
      const tools = effectiveTools(agent(id), 'build')
      expect(tools.sort()).toEqual([...READ_ONLY_TOOLS].sort())
    }
  })

  it('a tool missing from the agent allow-list is never granted by the mode', () => {
    const custom = { allowedTools: ['filesystem.read'] as ToolId[], permissionCeiling: 'build' as const }
    expect(effectiveTools(custom, 'build')).toEqual(['filesystem.read'])
  })
})

describe('model tool support', () => {
  it('blocks only a model that explicitly lacks tool_call; unknown metadata is allowed', () => {
    expect(toolSupportOf({ toolCall: true })).toBe('yes')
    expect(toolSupportOf({ toolCall: false })).toBe('no')
    expect(toolSupportOf(null)).toBe('unknown')
    expect(toolSupportOf(undefined)).toBe('unknown')
  })
})

describe('agent IPC inputs', () => {
  it('accepts a run request and rejects a bad mode / empty content', () => {
    const ok = { runId: 'r1', conversationId: 'c1', content: 'fix it', mode: 'build', providerConfigId: 'p', model: 'm' }
    expect(RunAgentInputSchema.safeParse(ok).success).toBe(true)
    expect(RunAgentInputSchema.safeParse({ ...ok, mode: 'yolo' }).success).toBe(false)
    expect(RunAgentInputSchema.safeParse({ ...ok, content: '' }).success).toBe(false)
  })

  it('a permission response carries only a request id and one of four decisions', () => {
    expect(RespondPermissionInputSchema.safeParse({ requestId: 'x', decision: 'allow_workspace' }).success).toBe(true)
    expect(RespondPermissionInputSchema.safeParse({ requestId: 'x', decision: 'allow_forever' }).success).toBe(false)
    expect(RespondPermissionInputSchema.safeParse({ decision: 'allow_once' }).success).toBe(false)
  })
})
