import { beforeEach, describe, expect, it } from 'vitest'
import { AgentRepository, ConversationRepository, WorkspaceRepository, openDatabase, type AppDatabase } from '@ai-workspace/storage'
import type { AgentEvent, PermissionDecision, PermissionRequest } from '@ai-workspace/shared'
import { PermissionEngine, type PermissionSubject } from '../agent/permission-engine'

let db: AppDatabase
let repo: AgentRepository
let events: AgentEvent[]
let engine: PermissionEngine
let ws1: string
let ws2: string
let conv1: string
let conv2: string
let counter: number

function makeEngine(): PermissionEngine {
  return new PermissionEngine({ grants: repo, emit: (e) => events.push(e), newId: () => `id-${++counter}` })
}

beforeEach(() => {
  db = openDatabase(':memory:')
  repo = new AgentRepository(db)
  events = []
  counter = 0
  const workspaces = new WorkspaceRepository(db)
  ws1 = workspaces.create({ name: 'one' }).id
  ws2 = workspaces.create({ name: 'two' }).id
  const conversations = new ConversationRepository(db)
  conv1 = conversations.create({ workspaceId: ws1, title: 'c1' }).id
  conv2 = conversations.create({ workspaceId: ws1, title: 'c2' }).id
  engine = makeEngine()
})

function subject(overrides: Partial<PermissionSubject> = {}): PermissionSubject {
  return {
    runId: 'run-1',
    toolRunId: 'tr-1',
    workspaceId: ws1,
    conversationId: conv1,
    toolId: 'filesystem.patch',
    risk: 'write',
    command: null,
    noGrant: false,
    grantScopeNote: 'any file in this workspace',
    preview: { kind: 'patch', path: 'a.ts', diff: '@@', added: 1, removed: 1 },
    ...overrides,
  }
}
const command = (text: string, overrides: Partial<PermissionSubject> = {}): PermissionSubject =>
  subject({
    toolId: 'terminal.execute',
    risk: 'execution',
    command: text,
    grantScopeNote: 'this exact command',
    preview: { kind: 'command', command: text, cwd: '/w', shell: 'bash', timeoutSeconds: 120, reasons: [] },
    ...overrides,
  })

/** Asks, answers, and returns the outcome. */
async function askAndAnswer(s: PermissionSubject, decision: PermissionDecision) {
  const promise = engine.ask(s)
  const request = engine.pendingRequests().at(-1) as PermissionRequest
  const result = engine.respond({ requestId: request.requestId, decision })
  return { outcome: await promise, result, request }
}

describe('default policy', () => {
  it('safe tools never ask; everything else asks by default', () => {
    expect(engine.gate(subject({ toolId: 'filesystem.read', risk: 'safe' }))).toEqual({ kind: 'allow', source: 'default-safe' })
    for (const risk of ['write', 'execution', 'network', 'destructive'] as const) {
      expect(engine.gate(subject({ risk }))).toEqual({ kind: 'ask' })
    }
  })

  it('a safe call flagged noGrant still asks', () => {
    expect(engine.gate(subject({ risk: 'safe', noGrant: true }))).toEqual({ kind: 'ask' })
  })
})

describe('asking and answering', () => {
  it('emits a request carrying exactly what will happen, then resolves on the answer', async () => {
    const s = command('pnpm test')
    const promise = engine.ask(s)
    const emitted = events.find((e) => e.type === 'permission-request')
    expect(emitted).toBeDefined()
    const request = (emitted as { request: PermissionRequest }).request
    expect(request).toMatchObject({
      requestId: 'id-1',
      runId: 'run-1',
      toolId: 'terminal.execute',
      risk: 'execution',
      preview: { kind: 'command', command: 'pnpm test', cwd: '/w' },
      allowedDecisions: ['allow_once', 'allow_session', 'allow_workspace', 'deny'],
      grantScopeNote: 'this exact command',
    })
    expect(engine.respond({ requestId: request.requestId, decision: 'allow_once' })).toEqual({ ok: true, reason: null })
    expect(await promise).toEqual({ decision: 'allow_once', source: 'prompt-once' })
    expect(events.some((e) => e.type === 'permission-resolved' && e.requestId === request.requestId)).toBe(true)
    expect(engine.pendingRequests()).toEqual([])
  })

  it('allow once does not remember anything', async () => {
    await askAndAnswer(subject(), 'allow_once')
    expect(engine.gate(subject())).toEqual({ kind: 'ask' })
    expect(repo.listGrants(ws1)).toEqual([])
  })

  it('deny resolves as a denial and remembers nothing', async () => {
    const { outcome } = await askAndAnswer(subject(), 'deny')
    expect(outcome).toEqual({ decision: 'deny', source: 'prompt-deny' })
    expect(engine.gate(subject())).toEqual({ kind: 'ask' })
  })

  it('a pending request holds up only its own call: a second ask is independent', async () => {
    const first = engine.ask(subject({ toolRunId: 'a' }))
    const second = engine.ask(subject({ toolRunId: 'b' }))
    const [r1, r2] = engine.pendingRequests() as [PermissionRequest, PermissionRequest]
    expect(r1.requestId).not.toBe(r2.requestId)
    engine.respond({ requestId: r2.requestId, decision: 'deny' })
    expect(await second).toMatchObject({ decision: 'deny' })
    engine.respond({ requestId: r1.requestId, decision: 'allow_once' })
    expect(await first).toMatchObject({ decision: 'allow_once' })
  })
})

describe('grant scopes', () => {
  it('allow for this session: honoured in that conversation only, in memory only', async () => {
    await askAndAnswer(subject(), 'allow_session')
    expect(engine.gate(subject())).toMatchObject({ kind: 'allow', source: 'session-grant' })
    expect(engine.gate(subject({ conversationId: conv2 }))).toEqual({ kind: 'ask' })
    expect(repo.listGrants(ws1)).toEqual([]) // nothing persisted
    // A new engine (an app restart) has forgotten it.
    expect(makeEngine().gate(subject())).toEqual({ kind: 'ask' })
  })

  it('allow for this workspace: persisted, honoured by every conversation in that workspace, not by another workspace', async () => {
    await askAndAnswer(subject(), 'allow_workspace')
    expect(engine.gate(subject())).toMatchObject({ kind: 'allow', source: 'workspace-grant' })
    expect(engine.gate(subject({ conversationId: conv2 }))).toMatchObject({ kind: 'allow', source: 'workspace-grant' })
    expect(engine.gate(subject({ workspaceId: ws2 }))).toEqual({ kind: 'ask' })
    expect(repo.listGrants(ws1)).toHaveLength(1)
    // Survives a restart.
    expect(makeEngine().gate(subject())).toMatchObject({ kind: 'allow', source: 'workspace-grant' })
  })

  it('a grant is keyed by tool AND risk: a patch grant does not cover write, nor the terminal', async () => {
    await askAndAnswer(subject({ toolId: 'filesystem.patch' }), 'allow_workspace')
    expect(engine.gate(subject({ toolId: 'filesystem.write' }))).toEqual({ kind: 'ask' })
    expect(engine.gate(command('pnpm test'))).toEqual({ kind: 'ask' })
    expect(engine.gate(subject({ toolId: 'filesystem.patch', risk: 'network' }))).toEqual({ kind: 'ask' })
  })

  it('a terminal grant covers the exact command only', async () => {
    await askAndAnswer(command('pnpm test'), 'allow_workspace')
    expect(engine.gate(command('pnpm test'))).toMatchObject({ kind: 'allow' })
    expect(engine.gate(command('pnpm test --watch'))).toEqual({ kind: 'ask' })
    expect(engine.gate(command('pnpm test '))).toEqual({ kind: 'ask' })
    expect(engine.gate(command('pnpm lint'))).toEqual({ kind: 'ask' })
    // Session scope is exact-command too.
    await askAndAnswer(command('pnpm build'), 'allow_session')
    expect(engine.gate(command('pnpm build'))).toMatchObject({ kind: 'allow', source: 'session-grant' })
    expect(engine.gate(command('pnpm build && rm -rf x'))).toEqual({ kind: 'ask' })
  })

  it('a grant made for "execution" does not cover the same command when it is classified differently later', async () => {
    await askAndAnswer(command('curl x'), 'allow_workspace')
    expect(engine.gate(command('curl x', { risk: 'network' }))).toEqual({ kind: 'ask' })
    expect(engine.gate(command('curl x', { risk: 'destructive' }))).toEqual({ kind: 'ask' })
  })

  it('revoking removes the grant at once, for both scopes', async () => {
    await askAndAnswer(subject({ toolId: 'filesystem.write' }), 'allow_workspace')
    await askAndAnswer(subject({ toolId: 'filesystem.patch' }), 'allow_session')
    const grants = engine.listGrants(ws1)
    expect(grants.map((g) => g.scope).sort()).toEqual(['session', 'workspace'])
    for (const g of grants) engine.revokeGrant(g.id)
    expect(engine.listGrants(ws1)).toEqual([])
    expect(engine.gate(subject({ toolId: 'filesystem.write' }))).toEqual({ kind: 'ask' })
    expect(engine.gate(subject({ toolId: 'filesystem.patch' }))).toEqual({ kind: 'ask' })
  })
})

describe('what can never be granted', () => {
  it('destructive: only allow-once or deny is offered, and nothing else is accepted', async () => {
    const s = command('rm -rf build', { risk: 'destructive', noGrant: true })
    const promise = engine.ask(s)
    const request = engine.pendingRequests()[0] as PermissionRequest
    expect(request.allowedDecisions).toEqual(['allow_once', 'deny'])
    expect(request.grantScopeNote).toBeNull()

    for (const decision of ['allow_session', 'allow_workspace'] as const) {
      const attempt = engine.respond({ requestId: request.requestId, decision })
      expect(attempt.ok).toBe(false)
    }
    // The rejected attempts neither resolved the request nor created a grant.
    expect(engine.pendingRequests()).toHaveLength(1)
    expect(repo.listGrants(ws1)).toEqual([])
    expect(engine.listGrants(ws1)).toEqual([])

    expect(engine.respond({ requestId: request.requestId, decision: 'allow_once' }).ok).toBe(true)
    expect(await promise).toMatchObject({ decision: 'allow_once' })
    // ...and the next identical call asks again.
    expect(engine.gate(s)).toEqual({ kind: 'ask' })
  })

  it('a pre-existing grant cannot be used to run a destructive command', () => {
    repo.addGrant({ workspaceId: ws1, toolId: 'terminal.execute', risk: 'destructive', command: 'rm -rf build' })
    expect(engine.gate(command('rm -rf build', { risk: 'destructive', noGrant: true }))).toEqual({ kind: 'ask' })
    expect(engine.gate(command('rm -rf build', { risk: 'destructive' }))).toEqual({ kind: 'ask' })
  })

  it('an AI commit (noGrant) asks every single time, even with a stored grant for the same command', async () => {
    const commit = command('git commit -m "x"', { noGrant: true })
    repo.addGrant({ workspaceId: ws1, toolId: 'terminal.execute', risk: 'execution', command: 'git commit -m "x"' })
    expect(engine.gate(commit)).toEqual({ kind: 'ask' })
    const promise = engine.ask(commit)
    const request = engine.pendingRequests()[0] as PermissionRequest
    expect(request.allowedDecisions).toEqual(['allow_once', 'deny'])
    expect(engine.respond({ requestId: request.requestId, decision: 'allow_workspace' }).ok).toBe(false)
    engine.respond({ requestId: request.requestId, decision: 'deny' })
    await promise
  })

  it('Plan mode: a terminal command (flagged noGrant by the run) ignores grants made in Build mode', () => {
    repo.addGrant({ workspaceId: ws1, toolId: 'terminal.execute', risk: 'execution', command: 'pnpm test' })
    expect(engine.gate(command('pnpm test'))).toMatchObject({ kind: 'allow' })
    expect(engine.gate(command('pnpm test', { noGrant: true }))).toEqual({ kind: 'ask' })
  })
})

describe('forged, repeated and expired requests', () => {
  it('an unknown request id is rejected and approves nothing', async () => {
    const promise = engine.ask(subject())
    for (const forged of ['nope', 'id-999', '', 'id-1 ', 'ID-1']) {
      expect(engine.respond({ requestId: forged, decision: 'allow_once' }).ok).toBe(false)
    }
    expect(engine.pendingRequests()).toHaveLength(1)
    engine.respond({ requestId: 'id-1', decision: 'deny' })
    expect(await promise).toMatchObject({ decision: 'deny' })
  })

  it('a request id is single use: the second answer is rejected and cannot flip the outcome', async () => {
    const promise = engine.ask(subject())
    expect(engine.respond({ requestId: 'id-1', decision: 'deny' }).ok).toBe(true)
    expect(engine.respond({ requestId: 'id-1', decision: 'allow_once' }).ok).toBe(false)
    expect(await promise).toMatchObject({ decision: 'deny' })
  })

  it('answering a request for one call cannot approve a different pending call', async () => {
    const a = engine.ask(subject({ toolRunId: 'a' }))
    const b = engine.ask(subject({ toolRunId: 'b' }))
    engine.respond({ requestId: 'id-1', decision: 'allow_once' })
    expect(await a).toMatchObject({ decision: 'allow_once' })
    expect(engine.pendingRequests().map((r) => r.toolRunId)).toEqual(['b'])
    engine.respond({ requestId: 'id-2', decision: 'deny' })
    expect(await b).toMatchObject({ decision: 'deny' })
  })

  it('request ids from the default generator are unguessable UUIDs', () => {
    const real = new PermissionEngine({ grants: repo, emit: (e) => events.push(e) })
    void real.ask(subject({ toolRunId: 'x' }))
    void real.ask(subject({ toolRunId: 'y' }))
    const ids = real.pendingRequests().map((r) => r.requestId)
    expect(new Set(ids).size).toBe(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('requests expire with their run: the prompt is withdrawn and a late answer is rejected', async () => {
    const promise = engine.ask(subject())
    const other = engine.ask(subject({ runId: 'run-2', toolRunId: 'z' }))
    expect(engine.cancelRun('run-1')).toBe(1)
    expect(await promise).toEqual({ decision: 'cancelled', source: 'cancelled' })
    expect(events.some((e) => e.type === 'permission-resolved' && e.requestId === 'id-1')).toBe(true)
    expect(engine.respond({ requestId: 'id-1', decision: 'allow_once' }).ok).toBe(false)
    // The other run is untouched.
    expect(engine.pendingRequests().map((r) => r.runId)).toEqual(['run-2'])
    engine.respond({ requestId: 'id-2', decision: 'deny' })
    await other
  })

  it('aborting the signal while a prompt is open cancels just that prompt', async () => {
    const controller = new AbortController()
    const promise = engine.ask(subject(), controller.signal)
    controller.abort()
    expect(await promise).toEqual({ decision: 'cancelled', source: 'cancelled' })
    expect(engine.pendingRequests()).toEqual([])
    expect(engine.respond({ requestId: 'id-1', decision: 'allow_once' }).ok).toBe(false)
  })

  it('an already-aborted signal never creates a prompt', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await engine.ask(subject(), controller.signal)).toEqual({ decision: 'cancelled', source: 'cancelled' })
    expect(events.filter((e) => e.type === 'permission-request')).toHaveLength(0)
  })

  it('a decision that is not one of the four is rejected', () => {
    void engine.ask(subject())
    expect(engine.respond({ requestId: 'id-1', decision: 'allow_forever' as never }).ok).toBe(false)
    expect(engine.pendingRequests()).toHaveLength(1)
  })
})

describe('grant lifecycle', () => {
  it('forgetting a conversation drops its session grants', async () => {
    await askAndAnswer(subject(), 'allow_session')
    engine.forgetConversation(conv1)
    expect(engine.gate(subject())).toEqual({ kind: 'ask' })
  })
})
