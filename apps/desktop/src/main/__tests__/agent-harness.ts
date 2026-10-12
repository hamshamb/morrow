import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AgentRepository,
  ConversationRepository,
  WorkspaceFileRepository,
  WorkspaceRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import { DEFAULT_AGENT_LIMITS, TOOL_IDS, type AgentEvent, type AgentMode, type PermissionDecision, type PermissionRequest, type ToolId } from '@ai-workspace/shared'
import { CodeFileService } from '../code/file-service'
import { GitService } from '../code/git-service'
import { buildAgentEnv, detectAgentShell } from '../agent/command-runner'
import { PermissionEngine } from '../agent/permission-engine'
import { redactSecrets } from '../agent/redactor'
import { RunToolExecutor, type ExecutorOutcome } from '../agent/tool-executor'
import type { ToolServices } from '../agent/tools/types'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}

export function put(root: string, rel: string, content: string | Buffer): void {
  const full = join(root, ...rel.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** A throwaway repository with a local identity and one commit. */
export function makeRepo(files: Record<string, string | Buffer>): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'aiw-agent-')))
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.name', 'Agent Test')
  git(root, 'config', 'user.email', 'agent-test@example.invalid')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  put(root, '.gitignore', 'node_modules/\ndist/\n')
  for (const [rel, content] of Object.entries(files)) put(root, rel, content)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', 'initial commit')
  return root
}

export interface Harness {
  root: string
  db: AppDatabase
  repo: AgentRepository
  engine: PermissionEngine
  events: AgentEvent[]
  workspaceId: string
  conversationId: string
  runId: string
  services: ToolServices
  executor: RunToolExecutor
  controller: AbortController
  /** What to answer the next permission prompts with (default: deny, so nothing runs by accident). */
  answers: PermissionDecision[]
  prompts: PermissionRequest[]
  /** Called when a prompt appears, before the scripted answer - for tests that act "while the prompt is open". */
  onPrompt: ((request: PermissionRequest) => void | Promise<void>) | null
  autoAnswer: boolean
  call(wireName: string, input: unknown): Promise<ExecutorOutcome>
  cleanup(): void
}

export interface HarnessOptions {
  mode?: AgentMode
  allowedTools?: readonly ToolId[]
  files?: Record<string, string | Buffer>
  root?: string
  secrets?: string[]
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const root = options.root ?? makeRepo(options.files ?? { 'README.md': '# demo\n' })
  const db = openDatabase(':memory:')
  const workspace = new WorkspaceRepository(db).create({ name: 'W' })
  new WorkspaceFileRepository(db).setRoot(workspace.id, root)
  const conversation = new ConversationRepository(db).create({ workspaceId: workspace.id, title: 'C' })
  const repo = new AgentRepository(db)
  const runId = 'run-test'
  repo.createRun({ id: runId, workspaceId: workspace.id, conversationId: conversation.id, userMessageId: null, mode: options.mode ?? 'build', agentId: 'implementer', provider: 'custom', model: 'm', maxSteps: 25 })

  const events: AgentEvent[] = []
  const prompts: PermissionRequest[] = []
  const h = { answers: [] as PermissionDecision[], onPrompt: null, autoAnswer: true } as Harness

  const engine = new PermissionEngine({
    grants: repo,
    emit: (event) => {
      events.push(event)
      if (event.type === 'permission-request') {
        prompts.push(event.request)
        // Answer asynchronously, like a user clicking a button after the prompt rendered.
        setTimeout(() => {
          void (async () => {
            await h.onPrompt?.(event.request)
            if (!h.autoAnswer) return
            engine.respond({ requestId: event.request.requestId, decision: h.answers.shift() ?? 'deny' })
          })()
        }, 0)
      }
    },
  })

  const resolveRoot = (id: string): string | null => (id === workspace.id ? root : null)
  const files = new CodeFileService({ resolveRoot })
  const gitService = new GitService({ resolveRoot, files })
  const shell = detectAgentShell({ platform: process.platform, env: process.env })
  const services: ToolServices = {
    files,
    git: gitService,
    resolveRoot,
    indexSearch: (id, query, limit) => new WorkspaceFileRepository(db).search(id, query, limit),
    shell,
    commandEnv: () => buildAgentEnv(process.env, options.secrets ?? []).env,
    limits: () => ({ ...DEFAULT_AGENT_LIMITS, commandTimeoutSeconds: 60 }),
  }
  const controller = new AbortController()
  const executor = new RunToolExecutor({
    repo,
    engine,
    services,
    emit: (event) => events.push(event),
    redact: (text) => redactSecrets(text, options.secrets ?? []),
    run: {
      runId,
      workspaceId: workspace.id,
      conversationId: conversation.id,
      mode: options.mode ?? 'build',
      allowedTools: options.allowedTools ?? TOOL_IDS,
      signal: controller.signal,
    },
    currentStep: () => 1,
  })

  return Object.assign(h, {
    root,
    db,
    repo,
    engine,
    events,
    workspaceId: workspace.id,
    conversationId: conversation.id,
    runId,
    services,
    executor,
    controller,
    prompts,
    call: (wireName: string, input: unknown) => executor.execute(wireName, input),
    cleanup: () => {
      controller.abort()
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  })
}
