import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { McpServerRepository, openDatabase, type AppDatabase } from '@ai-workspace/storage'
import type { SaveMcpServerInput } from '@ai-workspace/shared'
import { redactSecrets } from '../agent/redactor'
import { McpConfigService, type SecretCrypto } from '../mcp/config-service'
import { McpManager, type McpManagerOptions } from '../mcp/manager'
import { createFixtureServer } from './fixtures/mcp-fixture-server.mjs'

export const FIXTURE_STDIO = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url))

/** Not plaintext: a stand-in for Electron safeStorage (which needs a running app). */
export const fakeCrypto: SecretCrypto = {
  encrypt: (plain) => Buffer.from(`enc1:${Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join('')}`),
  decrypt: (encrypted) => {
    const text = encrypted.toString('utf8')
    if (!text.startsWith('enc1:')) throw new Error('not ciphertext')
    return Buffer.from(text.slice(5).split('').reverse().join(''), 'base64').toString('utf8')
  },
}

export function stdioServer(name: string, over: Partial<SaveMcpServerInput> = {}): SaveMcpServerInput {
  return { name, transport: 'stdio', command: process.execPath, args: [FIXTURE_STDIO], ...over }
}

export interface McpTestBed {
  db: AppDatabase
  repo: McpServerRepository
  config: McpConfigService
  manager: McpManager
  events: unknown[]
  cleanup(): Promise<void>
}

export function makeMcpBed(options: Partial<McpManagerOptions> = {}): McpTestBed {
  const db = openDatabase(':memory:')
  const repo = new McpServerRepository(db)
  const config = new McpConfigService(repo, fakeCrypto)
  const events: unknown[] = []
  const manager = new McpManager({
    config,
    clientVersion: '0.0.0-test',
    redact: (text, secrets) => {
      let out = redactSecrets(text, secrets)
      for (const s of secrets) if (s.length >= 4) out = out.split(s).join('[REDACTED]')
      return out
    },
    emit: (e) => events.push(e),
    connectTimeoutMs: 15_000,
    ...options,
  })
  return {
    db,
    repo,
    config,
    manager,
    events,
    cleanup: async () => {
      await manager.closeAll()
      db.close()
    },
  }
}

/**
 * A server that only speaks the older HTTP+SSE transport: POST to the endpoint answers 405 (so a streamable-HTTP client
 * falls back), GET opens the event stream, POST /messages carries the client's messages.
 */
export async function startLegacySseFixture(): Promise<HttpFixture> {
  const transports = new Map<string, SSEServerTransport>()
  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/mcp') {
        const transport = new SSEServerTransport('/messages', res)
        transports.set(transport.sessionId, transport)
        res.on('close', () => transports.delete(transport.sessionId))
        await createFixtureServer().connect(transport)
        return
      }
      if (req.method === 'POST' && url.pathname === '/messages') {
        const transport = transports.get(url.searchParams.get('sessionId') ?? '')
        if (!transport) {
          res.writeHead(404)
          res.end()
          return
        }
        await transport.handlePostMessage(req, res)
        return
      }
      res.writeHead(405, { allow: 'GET' })
      res.end()
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuth: [],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface HttpFixture {
  url: string
  /** The Authorization header of every request the server saw. */
  seenAuth: (string | undefined)[]
  close(): Promise<void>
}

/** The fixture MCP server over streamable HTTP (stateless: a fresh server + transport per request), in this process. */
export async function startHttpFixture(options: { requireAuth?: string } = {}): Promise<HttpFixture> {
  const seenAuth: (string | undefined)[] = []
  const server: Server = createServer((req, res) => {
    void (async () => {
      const auth = req.headers['authorization']
      seenAuth.push(typeof auth === 'string' ? auth : undefined)
      if (options.requireAuth !== undefined && auth !== options.requireAuth) {
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'unauthorized' }, id: null }))
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const mcp = createFixtureServer()
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as never)
      res.on('close', () => {
        void transport.close()
        void mcp.close()
      })
      await mcp.connect(transport as never)
      await transport.handleRequest(req, res, body)
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    seenAuth,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
