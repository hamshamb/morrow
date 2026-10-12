import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chatCompletionsStep, type ScriptedStep } from '@ai-workspace/providers/src/testing'

/**
 * A deterministic stand-in for a model provider: a local OpenAI-compatible HTTP server (`/v1/chat/completions`,
 * streaming) that answers each request with the next scripted step. The app is configured to use it as a CUSTOM
 * ENDPOINT, so the E2E exercises the real provider adapter and the real AI SDK end to end - the only fake is the
 * model's decisions. Every request body is recorded for assertions.
 */

export interface StubStep extends ScriptedStep {
  /** Pause before answering (lets a test observe an in-progress state). */
  delayMs?: number
}

export interface RecordedChatRequest {
  messages: { role: string; content?: unknown; tool_calls?: unknown; tool_call_id?: string }[]
  tools?: { function: { name: string } }[] | undefined
  raw: Record<string, unknown>
}

export interface StubModel {
  url: string
  /** Loads a new script (resets the step counter) and forgets recorded requests. */
  setScript(steps: StubStep[]): void
  requests: RecordedChatRequest[]
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function startStubModel(): Promise<StubModel> {
  let script: StubStep[] = []
  let index = 0
  const requests: RecordedChatRequest[] = []

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = req.url ?? ''
      if (req.method === 'GET' && url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'stub-model', object: 'model' }] }))
        return
      }
      if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
        const raw = JSON.parse(await readBody(req)) as Record<string, unknown>
        requests.push({ messages: (raw['messages'] ?? []) as RecordedChatRequest['messages'], tools: raw['tools'] as RecordedChatRequest['tools'], raw })
        const step = script[index]
        index += 1
        if (!step) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: `stub model: script exhausted at request ${index}` } }))
          return
        }
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs))
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.end(chatCompletionsStep(step))
        return
      }
      res.writeHead(404)
      res.end()
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    setScript(steps) {
      script = steps
      index = 0
      requests.length = 0
    },
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** One scripted tool call step. */
export const call = (name: string, args: unknown, text?: string, id?: string): StubStep => ({
  ...(text ? { text } : {}),
  toolCall: { id: id ?? `call_${Math.random().toString(36).slice(2, 10)}`, name, args: JSON.stringify(args) },
})
