import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  DecisionSource,
  PermissionDecision,
  PermissionGrant,
  PermissionPreview,
  PermissionRequest,
  RespondPermissionInput,
  RespondPermissionResult,
  ToolId,
  ToolRisk,
} from '@ai-workspace/shared'

/**
 * The permission engine (ADR-041). The main process is the only enforcer: a tool
 * call runs only if `gate` says allow, or `ask` returns an allow decision for a
 * request THIS engine created and sent. Nothing a model or the renderer says
 * can raise a ceiling or approve something the engine did not ask about.
 *
 * Rules
 *  - `safe` tools never ask (read-only by construction).
 *  - Everything else asks, unless a matching grant exists.
 *  - `destructive` calls and calls flagged `noGrant` (commits, a terminal command in Plan mode)
 *    ask EVERY time and can only be allowed once or denied - the engine refuses any other
 *    answer, so the "never grantable" rule holds even against a hostile renderer.
 *  - A grant is keyed by tool + risk (+ the exact command for `terminal.execute`), so a grant for
 *    one thing never covers another, and a command that is later classified differently is asked again.
 *  - Session grants live in memory, per conversation. Workspace grants are stored and revocable.
 *  - Request ids are random, single use, and die with their run.
 */

export interface GrantStore {
  findGrant(workspaceId: string, toolId: ToolId, risk: ToolRisk, command: string | null): PermissionGrant | null
  addGrant(input: { workspaceId: string; toolId: ToolId; risk: ToolRisk; command: string | null }): PermissionGrant
  listGrants(workspaceId: string): PermissionGrant[]
  deleteGrant(id: string): void
}

export interface PermissionSubject {
  runId: string
  toolRunId: string
  workspaceId: string
  conversationId: string
  toolId: ToolId
  risk: ToolRisk
  /** The exact command (terminal) - the grant key and what the prompt shows. Null for other tools. */
  command: string | null
  /** Forces ask-every-time (and allow-once-only) regardless of grants. */
  noGrant: boolean
  /** In words: what a session/workspace grant would cover. */
  grantScopeNote: string | null
  preview: PermissionPreview
}

export type Gate = { kind: 'allow'; source: DecisionSource; grantId?: string } | { kind: 'ask' }

export interface AskOutcome {
  decision: PermissionDecision | 'cancelled'
  source: DecisionSource
}

interface Pending {
  request: PermissionRequest
  subject: PermissionSubject
  resolve: (outcome: AskOutcome) => void
  detach: () => void
}

export interface PermissionEngineOptions {
  grants: GrantStore
  emit: (event: AgentEvent) => void
  newId?: () => string
  now?: () => number
}

const sessionKey = (s: Pick<PermissionSubject, 'conversationId' | 'toolId' | 'risk' | 'command'>): string =>
  JSON.stringify([s.conversationId, s.toolId, s.risk, s.command ?? ''])

export function isGrantable(subject: Pick<PermissionSubject, 'risk' | 'noGrant'>): boolean {
  return subject.risk !== 'destructive' && !subject.noGrant
}

export class PermissionEngine {
  private readonly pending = new Map<string, Pending>()
  private readonly sessionGrants = new Map<string, PermissionGrant>()
  private readonly newId: () => string
  private readonly now: () => number

  constructor(private readonly options: PermissionEngineOptions) {
    this.newId = options.newId ?? randomUUID
    this.now = options.now ?? Date.now
  }

  /** Does a tool call need a prompt? Pure lookup - nothing is created or changed. */
  gate(subject: PermissionSubject): Gate {
    if (subject.risk === 'safe' && !subject.noGrant) return { kind: 'allow', source: 'default-safe' }
    if (!isGrantable(subject)) return { kind: 'ask' }
    const session = this.sessionGrants.get(sessionKey(subject))
    if (session) return { kind: 'allow', source: 'session-grant', grantId: session.id }
    const stored = this.options.grants.findGrant(subject.workspaceId, subject.toolId, subject.risk, subject.command)
    if (stored) return { kind: 'allow', source: 'workspace-grant', grantId: stored.id }
    return { kind: 'ask' }
  }

  allowedDecisions(subject: Pick<PermissionSubject, 'risk' | 'noGrant'>): PermissionDecision[] {
    return isGrantable(subject) ? ['allow_once', 'allow_session', 'allow_workspace', 'deny'] : ['allow_once', 'deny']
  }

  /**
   * Creates a request, tells the UI, and waits for the answer. Resolves `cancelled` if the run is
   * cancelled or `signal` aborts first. Only the one tool call is held up.
   */
  ask(subject: PermissionSubject, signal?: AbortSignal): Promise<AskOutcome> {
    if (signal?.aborted) return Promise.resolve({ decision: 'cancelled', source: 'cancelled' })
    const requestId = this.newId()
    const request: PermissionRequest = {
      requestId,
      runId: subject.runId,
      toolRunId: subject.toolRunId,
      conversationId: subject.conversationId,
      workspaceId: subject.workspaceId,
      toolId: subject.toolId,
      risk: subject.risk,
      allowedDecisions: this.allowedDecisions(subject),
      grantScopeNote: isGrantable(subject) ? subject.grantScopeNote : null,
      preview: subject.preview,
      createdAt: this.now(),
    }
    return new Promise<AskOutcome>((resolve) => {
      const onAbort = (): void => this.settle(requestId, { decision: 'cancelled', source: 'cancelled' })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(requestId, {
        request,
        subject,
        resolve,
        detach: () => signal?.removeEventListener('abort', onAbort),
      })
      this.options.emit({ type: 'permission-request', request })
    })
  }

  /**
   * An answer from the renderer. Accepted only for a request that exists and is still open, and only with
   * a decision that request allows. A rejected answer changes nothing (the request stays open).
   */
  respond(input: RespondPermissionInput): RespondPermissionResult {
    const entry = this.pending.get(input.requestId)
    if (!entry) return { ok: false, reason: 'This request is unknown, already answered, or expired.' }
    if (!entry.request.allowedDecisions.includes(input.decision)) {
      return { ok: false, reason: `"${input.decision}" is not allowed for this request.` }
    }
    const subject = entry.subject
    switch (input.decision) {
      case 'deny':
        this.settle(input.requestId, { decision: 'deny', source: 'prompt-deny' })
        break
      case 'allow_once':
        this.settle(input.requestId, { decision: 'allow_once', source: 'prompt-once' })
        break
      case 'allow_session': {
        const grant: PermissionGrant = {
          id: `session:${this.newId()}`,
          scope: 'session',
          workspaceId: subject.workspaceId,
          conversationId: subject.conversationId,
          toolId: subject.toolId,
          risk: subject.risk,
          command: subject.command,
          createdAt: this.now(),
        }
        this.sessionGrants.set(sessionKey(subject), grant)
        this.settle(input.requestId, { decision: 'allow_session', source: 'prompt-session' })
        break
      }
      case 'allow_workspace':
        this.options.grants.addGrant({
          workspaceId: subject.workspaceId,
          toolId: subject.toolId,
          risk: subject.risk,
          command: subject.command,
        })
        this.settle(input.requestId, { decision: 'allow_workspace', source: 'prompt-workspace' })
        break
    }
    return { ok: true, reason: null }
  }

  /** The run ended (or was cancelled): every prompt it still has open is withdrawn. */
  cancelRun(runId: string): number {
    let count = 0
    for (const [id, entry] of [...this.pending]) {
      if (entry.request.runId !== runId) continue
      this.settle(id, { decision: 'cancelled', source: 'cancelled' })
      count += 1
    }
    return count
  }

  pendingRequests(): PermissionRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  /** Stored workspace grants plus this app session's grants for the workspace. */
  listGrants(workspaceId: string): PermissionGrant[] {
    const session = [...this.sessionGrants.values()].filter((g) => g.workspaceId === workspaceId)
    return [...this.options.grants.listGrants(workspaceId), ...session]
  }

  revokeGrant(id: string): void {
    if (id.startsWith('session:')) {
      for (const [key, grant] of this.sessionGrants) if (grant.id === id) this.sessionGrants.delete(key)
      return
    }
    this.options.grants.deleteGrant(id)
  }

  /** Drops the in-memory grants of a conversation (it was deleted). */
  forgetConversation(conversationId: string): void {
    for (const [key, grant] of this.sessionGrants) if (grant.conversationId === conversationId) this.sessionGrants.delete(key)
  }

  private settle(requestId: string, outcome: AskOutcome): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId) // single use: gone before anything else can observe it
    entry.detach()
    this.options.emit({ type: 'permission-resolved', requestId, runId: entry.request.runId })
    entry.resolve(outcome)
  }
}
