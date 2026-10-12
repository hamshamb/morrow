import type {
  AppSettings,
  Attachment,
  ChatStreamEvent,
  Conversation,
  ContextInspectorState,
  Message,
  ProviderConfigSummary,
  ProviderModelCatalog,
  RendererApi,
  Workspace,
  WorkspaceFileIndexEntry,
  WorkspaceFileRoot,
} from '@ai-workspace/shared'

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

const providerConfigs: ProviderConfigSummary[] = FIXTURE === 'empty' ? [] : [
  {
    id: 'pc-anthropic',
    provider: 'anthropic',
    label: 'Personal key',
    maskedKey: 'sk-ant...4f2a',
    baseUrl: null,
    createdAt: now - 20 * 24 * hour,
    updatedAt: now - 20 * 24 * hour,
  },
  {
    id: 'pc-openai',
    provider: 'openai',
    label: 'Work key',
    maskedKey: 'sk-...9b21',
    baseUrl: null,
    createdAt: now - 12 * 24 * hour,
    updatedAt: now - 12 * 24 * hour,
  },
  {
    id: 'pc-google',
    provider: 'google',
    label: 'Google',
    maskedKey: 'AIza...x7Qe',
    baseUrl: null,
    createdAt: now - 6 * 24 * hour,
    updatedAt: now - 6 * 24 * hour,
  },
]

const modelCatalogs: Record<string, ProviderModelCatalog> = {
  'pc-anthropic': {
    providerConfigId: 'pc-anthropic',
    fetchedAt: now - 2 * hour,
    models: [
      { id: 'claude-sonnet-5', displayName: 'Claude Sonnet 5' },
      { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' },
      { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5' },
    ],
  },
  'pc-openai': {
    providerConfigId: 'pc-openai',
    fetchedAt: now - 3 * hour,
    models: [
      { id: 'gpt-5.1', displayName: 'GPT-5.1' },
      { id: 'gpt-5.1-mini', displayName: 'GPT-5.1 Mini' },
      { id: 'o4-mini', displayName: 'o4-mini' },
    ],
  },
  'pc-google': {
    providerConfigId: 'pc-google',
    fetchedAt: null,
    models: [
      { id: 'gemini-2.0-flash', displayName: 'Gemini 2.0 Flash' },
      { id: 'gemini-1.5-pro', displayName: 'Gemini 1.5 Pro' },
    ],
  },
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

const messages: Record<string, Message[]> = {
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
      model: 'gpt-5.1',
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
      model: 'gemini-2.0-flash',
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

const conversationsByWorkspace: Record<string, Conversation[]> = {
  'ws-website': [
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
          { providerConfigId: 'pc-openai', model: 'gpt-5.1' },
        ],
  recentModels:
    FIXTURE === 'empty'
      ? []
      : [
          { providerConfigId: 'pc-anthropic', model: 'claude-sonnet-5', effort: 'medium' },
          { providerConfigId: 'pc-google', model: 'gemini-2.0-flash', effort: null },
        ],
}

function delay<T>(value: T, ms = 120): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms))
}

function buildContextInspectorState(): ContextInspectorState {
  return {
    sources: [
      {
        id: 'history',
        type: 'conversation-history',
        label: 'Conversation history',
        detail: '4 prior messages',
        characterCount: 1200,
        estimatedTokens: 300,
        includedByDefault: true,
        exceedsBudget: false,
      },
      {
        id: 'file:src/lib/auth/session.ts',
        type: 'workspace-file',
        label: 'session.ts',
        detail: 'src/lib/auth/session.ts',
        characterCount: 3400,
        estimatedTokens: 850,
        includedByDefault: true,
        exceedsBudget: false,
      },
      {
        id: 'retrieval:src/lib/db/schema.sql',
        type: 'retrieval-snippet',
        label: 'schema.sql',
        detail: 'matched "session" · src/lib/db/schema.sql',
        characterCount: 620,
        estimatedTokens: 155,
        includedByDefault: true,
        exceedsBudget: false,
      },
    ],
    totalCharacterCount: 5220,
    totalEstimatedTokens: 1305,
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
        }
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
        modelCatalogs[created.id] = { providerConfigId: created.id, models: [], fetchedAt: null }
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
    modelCatalog: {
      list: (providerConfigId) =>
        delay(modelCatalogs[providerConfigId] ?? { providerConfigId, models: [], fetchedAt: null }),
      refresh: (providerConfigId) => {
        const catalog = modelCatalogs[providerConfigId] ?? {
          providerConfigId,
          models: [],
          fetchedAt: null,
        }
        // Mirrors main: Google's live catalog isn't implemented (ADR-015).
        if (providerConfigs.find((c) => c.id === providerConfigId)?.provider === 'google') {
          return delay({ ok: false, message: 'Live model listing is not implemented for Google yet.', catalog })
        }
        const refreshed = { ...catalog, fetchedAt: Date.now() }
        modelCatalogs[providerConfigId] = refreshed
        return delay({ ok: true, catalog: refreshed })
      },
    },
    chat: {
      sendMessage: async (input) => {
        const requestId = input.requestId
        const userMessage: Message = {
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
        }
        messages[input.conversationId] = [...(messages[input.conversationId] ?? []), userMessage]

        const replyText = `(mock reply) I received: "${input.content.slice(0, 80)}"${input.content.length > 80 ? '…' : ''}`
        const listener = listeners.get(requestId)

        if (FIXTURE === 'error') {
          await delay(undefined, 300)
          const raw =
            '401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_mock"}'
          listener?.({ type: 'error', message: raw })
          const failed: Message = {
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
          }
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

        const assistantMessage: Message = {
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
        }
        messages[input.conversationId] = [...(messages[input.conversationId] ?? []), assistantMessage]
        listener?.({ type: 'done', message: assistantMessage })
        return assistantMessage
      },
      cancel: () => delay(undefined),
      onStreamEvent: (requestId, listener) => {
        listeners.set(requestId, listener)
        return () => listeners.delete(requestId)
      },
      getContextInspector: () => delay(buildContextInspectorState()),
    },
    attachments: {
      pickFile: () =>
        delay({
          filename: 'notes.md',
          mimeType: 'text/markdown',
          sizeBytes: 512,
          content: '# Notes\n\nMocked attachment content for screenshot review.',
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
  }

  window.api = api
  console.info('[dev] mock RendererApi installed — no Electron main process, fixture data only')
}
