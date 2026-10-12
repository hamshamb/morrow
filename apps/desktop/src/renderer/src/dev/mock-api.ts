import type {
  AppSettings,
  Attachment,
  ChatStreamEvent,
  Conversation,
  ContextInspectorState,
  LocalProviderStatus,
  Message,
  ModelMetadata,
  ModelsMetadataStatus,
  ProviderConfigSummary,
  ProviderModelCatalog,
  ProviderRegistryEntry,
  ReasoningEffort,
  RendererApi,
  Workspace,
  WorkspaceFileIndexEntry,
  WorkspaceFileRoot,
} from '@ai-workspace/shared'
import {
  cancelledIds,
  createOrchestrationMock,
  fillMessage,
  orchestrationFixtures,
  type MessageSeed,
} from './mock-orchestration'
import { createMockCodeApi } from './mock-code'

/**
 * Dev-only mock implementing the full `RendererApi` shape, so the renderer
 * can be opened in a plain browser tab (via the Vite dev server, no
 * Electron main/preload process) for UI work and screenshot review. Only
 * installed when `window.api` is undefined — inside the real Electron app
 * the real preload-provided API always wins. Every export here is
 * dynamically imported from `main.tsx` behind an `import.meta.env.DEV`
 * check, so none of this ships in a production build (verified by
 * inspecting the production bundle — see docs/BUILD_STATE.md).
 *
 * Fixture data is representative, not exhaustive: two workspaces, a
 * conversation with several messages including a long assistant response
 * with markdown/code, a couple of attachments, masked-key-only provider
 * configs, and a small model catalog.
 */

/** `?fixture=empty` → no provider keys (first-run onboarding);
 * `?fixture=error` → every send fails with a raw provider 401 body. */
const FIXTURE = new URLSearchParams(window.location.search).get('fixture')

let idCounter = 0
function nextId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${idCounter}`
}

const now = Date.now()
const hour = 60 * 60 * 1000

// ---- Workspaces ----

const workspaces: Workspace[] = [
  {
    id: 'ws-website',
    name: 'Personal Website',
    description: 'Marketing site + blog, Next.js on Vercel.',
    createdAt: now - 30 * 24 * hour,
    updatedAt: now - hour,
  },
  {
    id: 'ws-api',
    name: 'API Refactor',
    description: 'Splitting the monolith into services.',
    createdAt: now - 10 * 24 * hour,
    updatedAt: now - 5 * hour,
  },
]

// ---- Provider configs (masked keys only — never real) ----

/** `?ollama=down` → the Ollama probe reports "not running". */
const OLLAMA_RUNNING = new URLSearchParams(window.location.search).get('ollama') !== 'down'

function config(
  id: string,
  provider: string,
  label: string,
  maskedKey: string,
  ageDays: number,
  baseUrl: string | null = null,
): ProviderConfigSummary {
  return {
    id,
    provider,
    label,
    maskedKey,
    baseUrl,
    createdAt: now - ageDays * 24 * hour,
    updatedAt: now - ageDays * 24 * hour,
  }
}

const providerConfigs: ProviderConfigSummary[] =
  FIXTURE === 'empty'
    ? []
    : [
        config('pc-anthropic', 'anthropic', 'Personal key', 'sk-ant...4f2a', 20),
        config('pc-openai', 'openai', 'Work key', 'sk-pro...9b21', 12),
        config('pc-google', 'google', 'Google', 'AIza...x7Qe', 6),
        config('pc-xai', 'xai', 'xAI', 'xai-...k3Ld', 4),
        config('pc-groq', 'groq', 'Groq', 'gsk_...91Zt', 3),
        config('pc-ollama', 'ollama', 'Ollama', 'no key', 2, 'http://localhost:11434/v1'),
      ]

// ---- models.dev metadata (shapes mirror what the main process joins on) ----

type MetaInit = Partial<ModelMetadata> & Pick<ModelMetadata, 'id' | 'name'>

/** Builds a `ModelMetadata`; `ctx`/`out` in tokens, `price` = USD per 1M [input, output]. */
function meta(
  init: MetaInit,
  ctx: number,
  out: number,
  price: [number, number] | null,
  release: string,
): ModelMetadata {
  return {
    family: null,
    reasoning: false,
    reasoningEfforts: [],
    reasoningToggle: false,
    reasoningBudget: null,
    attachment: true,
    vision: true,
    inputModalities: ['text', 'image'],
    toolCall: true,
    structuredOutput: true,
    contextWindow: ctx,
    maxOutput: out,
    cost: price ? { input: price[0], output: price[1], cacheRead: null, cacheWrite: null } : null,
    knowledge: null,
    releaseDate: release,
    openWeights: false,
    status: null,
    ...init,
  }
}

const EFFORTS_ALL: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

const modelCatalogs: Record<string, ProviderModelCatalog> = {
  'pc-anthropic': {
    providerConfigId: 'pc-anthropic',
    fetchedAt: now - 2 * hour,
    source: 'live',
    models: [
      {
        id: 'claude-sonnet-5',
        displayName: 'Claude Sonnet 5',
        meta: meta(
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', reasoning: true, reasoningEfforts: EFFORTS_ALL, knowledge: '2026-01-31' },
          1_000_000,
          128_000,
          [2, 10],
          '2026-06-29',
        ),
      },
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        meta: meta(
          { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: true, reasoningEfforts: EFFORTS_ALL },
          1_000_000,
          128_000,
          [8, 40],
          '2026-08-02',
        ),
      },
      {
        id: 'claude-haiku-4-5-20251001',
        displayName: 'Claude Haiku 4.5',
        meta: meta(
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoning: true, reasoningBudget: { min: 1024, max: null } },
          200_000,
          64_000,
          [1, 5],
          '2025-10-01',
        ),
      },
    ],
  },
  'pc-openai': {
    providerConfigId: 'pc-openai',
    fetchedAt: now - 3 * hour,
    source: 'live',
    models: [
      {
        id: 'gpt-5.6',
        displayName: 'GPT-5.6',
        meta: meta(
          { id: 'gpt-5.6', name: 'GPT-5.6', reasoning: true, reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
          1_050_000,
          128_000,
          [2.5, 15],
          '2026-03-01',
        ),
      },
      {
        id: 'gpt-5-mini',
        displayName: 'GPT-5 mini',
        meta: meta(
          { id: 'gpt-5-mini', name: 'GPT-5 mini', reasoning: true, reasoningEfforts: ['minimal', 'low', 'medium', 'high'] },
          400_000,
          128_000,
          [0.25, 2],
          '2025-08-07',
        ),
      },
      {
        id: 'gpt-4o-mini',
        displayName: 'GPT-4o mini',
        meta: meta({ id: 'gpt-4o-mini', name: 'GPT-4o mini' }, 128_000, 16_384, [0.15, 0.6], '2024-07-18'),
      },
    ],
  },
  'pc-google': {
    providerConfigId: 'pc-google',
    fetchedAt: now - 5 * hour,
    source: 'live',
    models: [
      {
        id: 'gemini-3.5-flash',
        displayName: 'Gemini 3.5 Flash',
        meta: meta(
          { id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', reasoning: true, reasoningEfforts: ['minimal', 'low', 'medium', 'high'] },
          1_048_576,
          65_536,
          [0.3, 2.5],
          '2026-05-01',
        ),
      },
      {
        id: 'gemini-2.5-pro',
        displayName: 'Gemini 2.5 Pro',
        meta: meta(
          { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, reasoningBudget: { min: 128, max: 32768 } },
          1_048_576,
          65_536,
          [1.25, 10],
          '2025-06-01',
        ),
      },
    ],
  },
  'pc-xai': {
    providerConfigId: 'pc-xai',
    fetchedAt: null,
    source: 'metadata',
    models: [
      {
        id: 'grok-4.7',
        displayName: 'Grok 4.7',
        meta: meta(
          { id: 'grok-4.7', name: 'Grok 4.7', reasoning: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], vision: false, inputModalities: ['text'] },
          500_000,
          64_000,
          [3, 15],
          '2026-04-01',
        ),
      },
    ],
  },
  'pc-groq': {
    providerConfigId: 'pc-groq',
    fetchedAt: now - hour,
    source: 'live',
    models: [
      {
        id: 'llama-3.3-70b-versatile',
        displayName: 'Llama 3.3 70B',
        meta: meta(
          { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', vision: false, inputModalities: ['text'], openWeights: true },
          131_072,
          32_768,
          [0.59, 0.79],
          '2024-12-01',
        ),
      },
      {
        id: 'openai/gpt-oss-120b',
        displayName: 'GPT OSS 120B',
        meta: meta(
          { id: 'openai/gpt-oss-120b', name: 'GPT OSS 120B', reasoning: true, reasoningEfforts: ['low', 'medium', 'high'], vision: false, inputModalities: ['text'], openWeights: true },
          131_072,
          32_768,
          [0.15, 0.6],
          '2025-08-05',
        ),
      },
    ],
  },
  // A local model server: models come from /api/tags and models.dev knows none of them.
  'pc-ollama': {
    providerConfigId: 'pc-ollama',
    fetchedAt: now - hour,
    source: 'live',
    models: [
      { id: 'llama3.2:latest', displayName: null, meta: null },
      { id: 'qwen3:8b', displayName: null, meta: null },
    ],
  },
}

// ---- Provider registry (data-driven in the real app; a representative slice here) ----

function entry(
  id: string,
  name: string,
  modelCount: number,
  rank: number | null,
  extra: Partial<ProviderRegistryEntry> = {},
): ProviderRegistryEntry {
  return {
    id,
    name,
    kind: 'bundled',
    doc: `https://models.dev/providers/${id}`,
    keyRequired: true,
    isLocal: false,
    defaultBaseUrl: null,
    keyPrefix: null,
    popularRank: rank,
    modelCount,
    ...extra,
  }
}

const registry: ProviderRegistryEntry[] = [
  entry('anthropic', 'Anthropic', 17, 0, { keyPrefix: 'sk-ant-' }),
  entry('openai', 'OpenAI', 40, 1, { keyPrefix: 'sk-proj-' }),
  entry('google', 'Google', 31, 2, { keyPrefix: 'AIza' }),
  entry('xai', 'xAI', 8, 3, { keyPrefix: 'xai-' }),
  entry('mistral', 'Mistral', 19, 4),
  entry('groq', 'Groq', 14, 5, { keyPrefix: 'gsk_' }),
  entry('deepseek', 'DeepSeek', 2, 6, { defaultBaseUrl: 'https://api.deepseek.com' }),
  entry('openrouter', 'OpenRouter', 379, 7, { keyPrefix: 'sk-or-', defaultBaseUrl: 'https://openrouter.ai/api/v1' }),
  entry('ollama', 'Ollama', 0, 8, {
    kind: 'local',
    keyRequired: false,
    isLocal: true,
    defaultBaseUrl: 'http://localhost:11434/v1',
    doc: 'https://github.com/ollama/ollama',
  }),
  ...[
    ['302ai', '302.AI', 124],
    ['alibaba', 'Alibaba', 59],
    ['cerebras', 'Cerebras', 2],
    ['cohere', 'Cohere', 17],
    ['deepinfra', 'DeepInfra', 53],
    ['fireworks-ai', 'Fireworks AI', 22],
    ['helicone', 'Helicone', 90],
    ['huggingface', 'Hugging Face', 81],
    ['kilo', 'Kilo Gateway', 386],
    ['lmstudio', 'LM Studio', 3],
    ['moonshotai', 'Moonshot AI', 4],
    ['nvidia', 'Nvidia', 47],
    ['perplexity', 'Perplexity', 4],
    ['togetherai', 'Together AI', 18],
    ['zai', 'Z.AI', 18],
  ].map(([id, name, n]) =>
    entry(id as string, name as string, n as number, null, {
      kind: id === 'lmstudio' ? 'local' : 'openai-compatible',
      ...(id === 'lmstudio'
        ? { keyRequired: false, isLocal: true, defaultBaseUrl: 'http://127.0.0.1:1234/v1' }
        : {}),
    }),
  ),
  entry('custom', 'Custom OpenAI-compatible endpoint', 0, null, { kind: 'custom', keyRequired: false, doc: null }),
]

const localStatus: LocalProviderStatus[] = [
  { id: 'ollama', baseUrl: 'http://localhost:11434/v1', running: OLLAMA_RUNNING, modelCount: OLLAMA_RUNNING ? 2 : 0 },
  { id: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', running: false, modelCount: 0 },
]

let metadataStatus: ModelsMetadataStatus = {
  source: 'cache',
  fetchedAt: now - 3 * hour,
  networkEnabled: true,
  providerCount: 202,
  modelCount: 6658,
}

// ---- Conversations + messages ----

const LONG_ASSISTANT_REPLY = `Here's a plan for the auth flow redesign, plus a quick example of the token refresh middleware:

## Approach

1. Move session storage from cookies to an HTTP-only, \`SameSite=Lax\` cookie holding only an opaque session id.
2. Look up the session server-side on every request (Redis, ~1ms).
3. Rotate the refresh token on every use (refresh token reuse detection).

## Example: refresh middleware

\`\`\`ts
export async function refreshMiddleware(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.cookies.sid
  if (!sessionId) return next()

  const session = await store.get(sessionId)
  if (!session) return res.status(401).json({ error: 'invalid_session' })

  if (session.expiresAt < Date.now()) {
    const rotated = await rotateRefreshToken(session)
    res.cookie('sid', rotated.id, { httpOnly: true, sameSite: 'lax', secure: true })
    req.session = rotated
  } else {
    req.session = session
  }

  next()
}
\`\`\`

A few things worth flagging:

- This assumes Redis is already in the stack (it is, for rate limiting).
- Reuse detection means a stolen refresh token becomes useless after the legitimate client's next refresh — worth the extra round trip.
- We'll want a migration path for existing sessions; I'd suggest a dual-read period where both old and new cookies are accepted for ~2 weeks.

| Step | Owner | ETA |
| --- | --- | --- |
| Middleware + tests | You | 2 days |
| Redis session store | Backend | 1 day |
| Migration/dual-read | You | 1 day |

Want me to draft the migration middleware next, or the Redis session store first?`

const messageSeeds: Record<string, MessageSeed[]> = {
  'conv-auth': [
    {
      id: nextId('msg'),
      conversationId: 'conv-auth',
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      createdAt: now - 2 * hour,
      updatedAt: now - 2 * hour,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-1',
          type: 'text',
          content:
            "Our session cookies never expire and we don't rotate refresh tokens. Can you help me redesign the auth flow to be more secure?",
          position: 0,
          createdAt: now - 2 * hour,
        },
      ],
      attachments: [],
    },
    {
      id: nextId('msg'),
      conversationId: 'conv-auth',
      role: 'assistant',
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      status: 'complete',
      createdAt: now - 2 * hour + 30_000,
      updatedAt: now - 2 * hour + 30_000,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-2',
          type: 'text',
          content: LONG_ASSISTANT_REPLY,
          position: 0,
          createdAt: now - 2 * hour + 30_000,
        },
      ],
      attachments: [],
    },
    {
      id: nextId('msg'),
      conversationId: 'conv-auth',
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      createdAt: now - hour,
      updatedAt: now - hour,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-3',
          type: 'text',
          content: "Let's start with the Redis session store — here's our current schema.",
          position: 0,
          createdAt: now - hour,
        },
      ],
      attachments: [
        {
          id: nextId('att'),
          messageId: 'msg-3',
          filename: 'session-schema.sql',
          mimeType: 'application/sql',
          sizeBytes: 1842,
          content: 'CREATE TABLE sessions (\n  id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL\n);',
          createdAt: now - hour,
        } satisfies Attachment,
      ],
    },
    {
      id: nextId('msg'),
      conversationId: 'conv-auth',
      role: 'assistant',
      provider: 'openai',
      model: 'gpt-5.6',
      status: 'complete',
      createdAt: now - hour + 20_000,
      updatedAt: now - hour + 20_000,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-4',
          type: 'text',
          content:
            "That schema works as a starting point. I'd add a `rotated_from` column (nullable, self-referencing) so reuse detection can walk the chain back when a stale refresh token shows up.",
          position: 0,
          createdAt: now - hour + 20_000,
        },
      ],
      attachments: [],
    },
    // A sibling answer to the same turn from a third model — what
    // "[regenerate with…]" produces (appended, never replacing).
    {
      id: nextId('msg'),
      conversationId: 'conv-auth',
      role: 'assistant',
      provider: 'google',
      model: 'gemini-3.5-flash',
      status: 'complete',
      createdAt: now - hour + 60_000,
      updatedAt: now - hour + 60_000,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-4b',
          type: 'text',
          content:
            'Agree on `rotated_from`. Also index `user_id` and add an `expires_at` column so a nightly job can prune dead sessions without a full table scan.',
          position: 0,
          createdAt: now - hour + 60_000,
        },
      ],
      attachments: [],
    },
  ],
  'conv-deploy': [
    {
      id: nextId('msg'),
      conversationId: 'conv-deploy',
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      createdAt: now - 4 * hour,
      updatedAt: now - 4 * hour,
      parts: [
        {
          id: nextId('part'),
          messageId: 'msg-5',
          type: 'text',
          content: 'What changed in the last deploy?',
          position: 0,
          createdAt: now - 4 * hour,
        },
      ],
      attachments: [],
    },
  ],
}

const orchestrationDemo = orchestrationFixtures(now, hour)
const messages: Record<string, Message[]> = {
  ...Object.fromEntries(Object.entries(messageSeeds).map(([id, list]) => [id, list.map(fillMessage)])),
  ...orchestrationDemo.messages,
}

const conversationsByWorkspace: Record<string, Conversation[]> = {
  'ws-website': [
    ...orchestrationDemo.conversations,
    { id: 'conv-auth', workspaceId: 'ws-website', title: 'Auth flow redesign', createdAt: now - 2 * hour, updatedAt: now - hour },
    { id: 'conv-deploy', workspaceId: 'ws-website', title: 'Deploy notes', createdAt: now - 4 * hour, updatedAt: now - 4 * hour },
    { id: 'conv-empty', workspaceId: 'ws-website', title: 'New conversation', createdAt: now - hour / 2, updatedAt: now - hour / 2 },
  ],
  'ws-api': [],
}

// ---- Workspace files ----

const fileRoots: Record<string, WorkspaceFileRoot | null> = {
  'ws-website': { workspaceId: 'ws-website', rootPath: 'C:\\dev\\personal-website', createdAt: now - 20 * 24 * hour, updatedAt: now - 24 * hour },
  'ws-api': null,
}

const indexedFiles: Record<string, WorkspaceFileIndexEntry[]> = {
  'ws-website': [
    'src/app/layout.tsx',
    'src/app/page.tsx',
    'src/lib/auth/session.ts',
    'src/lib/auth/refresh-middleware.ts',
    'src/lib/db/schema.sql',
    'src/components/Nav.tsx',
    'README.md',
    'package.json',
  ].map((relativePath, i) => ({
    id: `file-${i}`,
    workspaceId: 'ws-website',
    relativePath,
    sizeBytes: 800 + i * 137,
    mtimeMs: now - i * hour,
    contentIndexed: !relativePath.endsWith('.json'),
    indexedAt: now - 24 * hour,
  })),
  'ws-api': [],
}

// ---- Settings ----

// `?theme=light|dark|system` seeds the initial theme so screenshot QA can
// capture both themes without clicking through Settings first.
function initialTheme(): AppSettings['theme'] {
  const requested = new URLSearchParams(window.location.search).get('theme')
  return requested === 'light' || requested === 'system' ? requested : 'dark'
}

let settings: AppSettings = {
  theme: initialTheme(),
  activeWorkspaceId: 'ws-website',
  lastModelSelection:
    FIXTURE === 'empty' ? null : { providerConfigId: 'pc-anthropic', model: 'claude-sonnet-5', effort: 'medium' },
  favoriteModels:
    FIXTURE === 'empty'
      ? []
      : [
          { providerConfigId: 'pc-anthropic', model: 'claude-opus-5-5' },
          { providerConfigId: 'pc-openai', model: 'gpt-5.6' },
        ],
  recentModels:
    FIXTURE === 'empty'
      ? []
      : [
          { providerConfigId: 'pc-anthropic', model: 'claude-sonnet-5', effort: 'medium' },
          { providerConfigId: 'pc-google', model: 'gemini-3.5-flash', effort: null },
        ],
  modelsDevFetchEnabled: true,
  autoPreference: 'balanced',
  // `?tabs=1` restores three open files in the code view (screenshot QA).
  codeSessions: new URLSearchParams(window.location.search).get('tabs')
    ? { 'ws-website': { openTabs: ['src/lib/auth/session.ts', 'src/components/Nav.tsx', 'README.md'], activeTab: 'src/lib/auth/session.ts' } }
    : {},
}

function delay<T>(value: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

/** `?ctx=<tokens>` sets the estimated prompt size (default ≈ 18K) so screenshot
 * QA can show the budget both under and over the 80% warning line. */
const CONTEXT_TOKENS = Number(new URLSearchParams(window.location.search).get('ctx')) || 18_000

function buildContextInspectorState(): ContextInspectorState {
  const fileTokens = 5_200
  const snippetTokens = 800
  const historyTokens = Math.max(CONTEXT_TOKENS - fileTokens - snippetTokens, 0)
  return {
    sources: [
      {
        id: 'history',
        type: 'conversation-history',
        label: 'Conversation history',
        detail: '4 prior messages',
        characterCount: historyTokens * 4,
        estimatedTokens: historyTokens,
        includedByDefault: true,
        exceedsBudget: false,
      },
      {
        id: 'file:src/lib/auth/session.ts',
        type: 'workspace-file',
        label: 'session.ts',
        detail: 'src/lib/auth/session.ts',
        characterCount: fileTokens * 4,
        estimatedTokens: fileTokens,
        includedByDefault: true,
        exceedsBudget: false,
      },
      {
        id: 'retrieval:src/lib/db/schema.sql',
        type: 'retrieval-snippet',
        label: 'schema.sql',
        detail: 'matched "session" · src/lib/db/schema.sql',
        characterCount: snippetTokens * 4,
        estimatedTokens: snippetTokens,
        includedByDefault: true,
        exceedsBudget: false,
      },
    ],
    totalCharacterCount: CONTEXT_TOKENS * 4,
    totalEstimatedTokens: CONTEXT_TOKENS,
    budgetCharacterCap: 60_000,
  }
}

export function installMockApi(): void {
  const listeners = new Map<string, (event: ChatStreamEvent) => void>()

  const api: RendererApi = {
    workspaces: {
      list: () => delay([...workspaces]),
      get: (id) => delay(workspaces.find((w) => w.id === id) ?? null),
      create: (input) => {
        const created: Workspace = {
          id: nextId('ws'),
          name: input.name,
          description: input.description ?? null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        workspaces.push(created)
        conversationsByWorkspace[created.id] = []
        fileRoots[created.id] = null
        indexedFiles[created.id] = []
        return delay(created)
      },
      update: (input) => {
        const ws = workspaces.find((w) => w.id === input.id)
        if (!ws) throw new Error('Workspace not found')
        if (input.name !== undefined) ws.name = input.name
        if (input.description !== undefined) ws.description = input.description
        ws.updatedAt = Date.now()
        return delay(ws)
      },
      delete: (id) => {
        const index = workspaces.findIndex((w) => w.id === id)
        if (index >= 0) workspaces.splice(index, 1)
        return delay(undefined)
      },
    },
    settings: {
      get: () => delay({ ...settings }),
      set: (partial) => {
        settings = {
          theme: partial.theme ?? settings.theme,
          activeWorkspaceId:
            partial.activeWorkspaceId !== undefined ? partial.activeWorkspaceId : settings.activeWorkspaceId,
          lastModelSelection:
            partial.lastModelSelection !== undefined
              ? partial.lastModelSelection
              : settings.lastModelSelection,
          favoriteModels: partial.favoriteModels ?? settings.favoriteModels,
          recentModels: partial.recentModels ?? settings.recentModels,
          modelsDevFetchEnabled: partial.modelsDevFetchEnabled ?? settings.modelsDevFetchEnabled,
          autoPreference: partial.autoPreference ?? settings.autoPreference,
          codeSessions: partial.codeSessions ?? settings.codeSessions,
        }
        metadataStatus = { ...metadataStatus, networkEnabled: settings.modelsDevFetchEnabled }
        return delay({ ...settings })
      },
    },
    app: {
      getVersion: () => delay('0.0.0-dev'),
    },
    conversations: {
      list: (workspaceId) => delay([...(conversationsByWorkspace[workspaceId] ?? [])]),
      create: (input) => {
        const created: Conversation = {
          id: nextId('conv'),
          workspaceId: input.workspaceId,
          title: input.title ?? 'New conversation',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        conversationsByWorkspace[input.workspaceId] = [
          created,
          ...(conversationsByWorkspace[input.workspaceId] ?? []),
        ]
        messages[created.id] = []
        return delay(created)
      },
      rename: (input) => {
        for (const list of Object.values(conversationsByWorkspace)) {
          const conv = list.find((c) => c.id === input.id)
          if (conv) {
            conv.title = input.title
            conv.updatedAt = Date.now()
            return delay(conv)
          }
        }
        throw new Error('Conversation not found')
      },
      delete: (id) => {
        for (const key of Object.keys(conversationsByWorkspace)) {
          conversationsByWorkspace[key] = (conversationsByWorkspace[key] ?? []).filter((c) => c.id !== id)
        }
        delete messages[id]
        return delay(undefined)
      },
      listMessages: (conversationId) => delay([...(messages[conversationId] ?? [])]),
    },
    providerConfigs: {
      list: () => delay([...providerConfigs]),
      add: (input) => {
        const created: ProviderConfigSummary = {
          id: nextId('pc'),
          provider: input.provider,
          label: input.label,
          maskedKey: `${input.apiKey.slice(0, 4)}...${input.apiKey.slice(-4)}`,
          baseUrl: input.baseUrl ?? null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        providerConfigs.push(created)
        // Like the real app: a new key starts from models.dev's list for that
        // provider (here: the first catalog we have for the same provider).
        const sibling = providerConfigs.find((c) => c.provider === created.provider && c.id !== created.id)
        modelCatalogs[created.id] = {
          providerConfigId: created.id,
          models: sibling ? (modelCatalogs[sibling.id]?.models ?? []) : (modelCatalogs['pc-anthropic']?.models ?? []),
          fetchedAt: null,
          source: 'metadata',
        }
        return delay(created)
      },
      remove: (id) => {
        const index = providerConfigs.findIndex((c) => c.id === id)
        if (index >= 0) providerConfigs.splice(index, 1)
        return delay(undefined)
      },
      // Any key containing "bad" fails like a real provider would.
      test: (input) =>
        delay(
          input.apiKey.includes('bad')
            ? { ok: false, message: '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}' }
            : { ok: true, message: 'Connection OK (mock)' },
          600,
        ),
    },
    providers: {
      registry: () => delay([...registry]),
      detectLocal: () => delay([...localStatus], 250),
    },
    modelsMetadata: {
      status: () => delay({ ...metadataStatus }),
      refresh: () => {
        if (!settings.modelsDevFetchEnabled) {
          return delay({
            ok: false,
            message: 'Downloading the model catalog is turned off in Settings; using the built-in snapshot.',
            status: { ...metadataStatus },
          })
        }
        metadataStatus = { ...metadataStatus, source: 'network', fetchedAt: Date.now() }
        return delay({ ok: true, status: { ...metadataStatus } }, 800)
      },
      onChange: () => () => undefined,
    },
    modelCatalog: {
      list: (providerConfigId) =>
        delay(modelCatalogs[providerConfigId] ?? { providerConfigId, models: [], fetchedAt: null }),
      refresh: (providerConfigId) => {
        const catalog = modelCatalogs[providerConfigId] ?? {
          providerConfigId,
          models: [],
          fetchedAt: null,
        }
        const refreshed: ProviderModelCatalog = { ...catalog, fetchedAt: Date.now(), source: 'live' }
        modelCatalogs[providerConfigId] = refreshed
        return delay({ ok: true, catalog: refreshed })
      },
    },
    chat: {
      sendMessage: async (input) => {
        const requestId = input.requestId
        const userMessage: Message = fillMessage({
          id: nextId('msg'),
          conversationId: input.conversationId,
          role: 'user',
          provider: null,
          model: null,
          status: 'complete',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          parts: [
            { id: nextId('part'), messageId: 'u', type: 'text', content: input.content, position: 0, createdAt: Date.now() },
          ],
          attachments: (input.contextSelection?.attachments ?? []).map((a) => ({
            id: nextId('att'),
            messageId: 'u',
            filename: a.filename,
            mimeType: a.mimeType,
            sizeBytes: a.sizeBytes,
            content: a.content,
            createdAt: Date.now(),
          })),
        })
        // [regenerate]: answer the existing user turn again as a sibling; no new user message.
        const regenerateOf = input.regenerateOfMessageId
          ? (messages[input.conversationId] ?? []).find((m) => m.id === input.regenerateOfMessageId)
          : undefined
        if (!regenerateOf) messages[input.conversationId] = [...(messages[input.conversationId] ?? []), userMessage]
        const groupId = regenerateOf?.id ?? userMessage.id

        const replyText = `(mock reply) I received: "${input.content.slice(0, 80)}"${input.content.length > 80 ? '…' : ''}`
        const listener = listeners.get(requestId)

        if (FIXTURE === 'error') {
          await delay(undefined, 300)
          const raw =
            '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_mock"}'
          listener?.({ type: 'error', message: raw })
          const failed: Message = fillMessage({
            id: nextId('msg'),
            conversationId: input.conversationId,
            role: 'assistant',
            provider: providerConfigs.find((c) => c.id === input.providerConfigId)?.provider ?? 'anthropic',
            model: input.model,
            status: 'error',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            parts: [],
            attachments: [],
            replyGroupId: groupId,
            inContext: false,
            errorText: raw,
          })
          messages[input.conversationId] = [...(messages[input.conversationId] ?? []), failed]
          listener?.({ type: 'done', message: failed })
          return failed
        }
        if (listener) {
          const chunks = replyText.split(' ')
          for (const chunk of chunks) {
            await delay(undefined, 15)
            listener({ type: 'delta', delta: `${chunk} ` })
          }
        }

        const assistantMessage: Message = fillMessage({
          id: nextId('msg'),
          conversationId: input.conversationId,
          role: 'assistant',
          provider: providerConfigs.find((c) => c.id === input.providerConfigId)?.provider ?? 'anthropic',
          model: input.model,
          status: 'complete',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          parts: [
            { id: nextId('part'), messageId: 'a', type: 'text', content: replyText, position: 0, createdAt: Date.now() },
          ],
          attachments: [],
          replyGroupId: groupId,
          latencyMs: 900,
          inputTokens: 240,
          outputTokens: 80,
        })
        if (regenerateOf) {
          messages[input.conversationId] = (messages[input.conversationId] ?? []).map((m) =>
            m.role === 'assistant' && m.replyGroupId === groupId ? { ...m, inContext: false } : m,
          )
        }
        messages[input.conversationId] = [...(messages[input.conversationId] ?? []), assistantMessage]
        listener?.({ type: 'done', message: assistantMessage })
        return assistantMessage
      },
      cancel: (requestId) => {
        cancelledIds.add(requestId)
        return delay(undefined)
      },
      ...createOrchestrationMock({
        messages,
        providerConfigs,
        modelCatalogs,
        streamListeners: listeners,
        getAutoPreference: () => settings.autoPreference,
        nextId,
      }),
      onStreamEvent: (requestId, listener) => {
        listeners.set(requestId, listener)
        return () => listeners.delete(requestId)
      },
      getContextInspector: () => delay(buildContextInspectorState()),
    },
    attachments: {
      pickFiles: () =>
        delay({
          attachments: [
            {
              filename: 'notes.md',
              mimeType: 'text/markdown',
              sizeBytes: 512,
              content: '# Notes\n\nMocked attachment content for screenshot review.',
            },
            {
              filename: 'schema.sql',
              mimeType: 'text/plain',
              sizeBytes: 1840,
              content: 'CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);',
            },
            {
              filename: 'routes.ts',
              mimeType: 'text/plain',
              sizeBytes: 960,
              content: 'export const routes = ["/", "/login"]',
            },
          ],
          rejected: [{ filename: 'diagram.png', reason: 'unsupported type .png' }],
        }),
    },
    workspaceFiles: {
      getRoot: (workspaceId) => delay(fileRoots[workspaceId] ?? null),
      pickRoot: (workspaceId) => {
        const root: WorkspaceFileRoot = {
          workspaceId,
          rootPath: 'C:\\dev\\mock-root',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        fileRoots[workspaceId] = root
        indexedFiles[workspaceId] = indexedFiles[workspaceId] ?? []
        return delay({ root, fileCount: indexedFiles[workspaceId]!.length, indexedCount: indexedFiles[workspaceId]!.length })
      },
      reindex: (workspaceId) => {
        const root = fileRoots[workspaceId]
        if (!root) throw new Error('No root set')
        return delay({ root, fileCount: (indexedFiles[workspaceId] ?? []).length, indexedCount: (indexedFiles[workspaceId] ?? []).length })
      },
      list: (workspaceId) => delay([...(indexedFiles[workspaceId] ?? [])]),
      search: (workspaceId, query) =>
        delay(
          (indexedFiles[workspaceId] ?? [])
            .filter((f) => f.relativePath.toLowerCase().includes(query.toLowerCase()))
            .map((f) => ({ relativePath: f.relativePath, snippet: '…matched content…', score: 1 })),
        ),
    },
    ...createMockCodeApi(),
  }

  window.api = api
  console.info('[dev] mock RendererApi installed — no Electron main process, fixture data only')
}
