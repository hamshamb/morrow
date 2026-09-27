import { describe, expect, it } from 'vitest'
import { createMockProvider } from '../adapters/mock'
import type { ProviderStreamEvent } from '../types'

async function collect(iterable: AsyncIterable<ProviderStreamEvent>): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = []
  for await (const event of iterable) events.push(event)
  return events
}

describe('createMockProvider', () => {
  it('streams scripted chunks and finishes with the accumulated text', async () => {
    const provider = createMockProvider({ id: 'anthropic', respond: ['Hello', ', ', 'world!'] })
    const events = await collect(
      provider.streamChat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hello' },
      { type: 'text-delta', delta: ', ' },
      { type: 'text-delta', delta: 'world!' },
      { type: 'done', text: 'Hello, world!' },
    ])
  })

  it('defaults to echoing the last user message', async () => {
    const provider = createMockProvider({ id: 'openai' })
    const events = await collect(
      provider.streamChat({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'what is 2+2?' }],
      }),
    )
    const done = events.at(-1)
    expect(done?.type).toBe('done')
    expect(done && 'text' in done ? done.text : '').toContain('what is 2+2?')
  })

  it('emits an error event when configured to fail', async () => {
    const provider = createMockProvider({ id: 'google', respond: ['partial'], failWith: 'boom' })
    const events = await collect(
      provider.streamChat({ model: 'mock-model', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(events.at(-1)).toEqual({ type: 'error', error: 'boom' })
  })

  it('reports its provider id for attribution', () => {
    const provider = createMockProvider({ id: 'openai' })
    expect(provider.id).toBe('openai')
  })

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = createMockProvider({ id: 'anthropic' })
    const events = await collect(
      provider.streamChat({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
        signal: controller.signal,
      }),
    )
    expect(events).toEqual([{ type: 'error', error: 'Aborted' }])
  })
})
