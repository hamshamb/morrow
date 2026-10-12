/**
 * Scripted server-sent-event bodies in each provider's REAL wire format, used
 * with a stubbed `fetch` so the actual AI SDK parses them (no network). A step
 * is either assistant text, a tool call, or both - the way a provider streams
 * them.
 */

export interface ScriptedStep {
  text?: string
  toolCall?: { id: string; name: string; args: string }
  /** Extra tool calls in the same step (parallel tool use). */
  moreToolCalls?: { id: string; name: string; args: string }[]
}

const sse = (events: { event?: string; data: unknown }[]): string =>
  events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${JSON.stringify(e.data)}\n\n`).join('')

/** Splits a JSON argument string into a few deltas, like a real stream. */
function chunks(args: string): string[] {
  const out: string[] = []
  const size = Math.max(1, Math.ceil(args.length / 3))
  for (let i = 0; i < args.length; i += size) out.push(args.slice(i, i + size))
  return out
}

/** Anthropic Messages API streaming. */
export function anthropicStep(step: ScriptedStep): string {
  const events: { event: string; data: unknown }[] = [
    {
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      },
    },
  ]
  let index = 0
  if (step.text) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } } })
    events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: step.text } } })
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
    index += 1
  }
  for (const call of [step.toolCall, ...(step.moreToolCalls ?? [])]) {
    if (!call) continue
    events.push({
      event: 'content_block_start',
      data: { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
    })
    for (const part of chunks(call.args)) {
      events.push({
        event: 'content_block_delta',
        data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: part } },
      })
    }
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } })
    index += 1
  }
  events.push({
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: step.toolCall ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 12 },
    },
  })
  events.push({ event: 'message_stop', data: { type: 'message_stop' } })
  return sse(events)
}

/** OpenAI Responses API streaming (what `@ai-sdk/openai` uses for `openai`). */
export function openaiResponsesStep(step: ScriptedStep): string {
  const events: { data: unknown }[] = [
    {
      data: {
        type: 'response.created',
        response: { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5.6', status: 'in_progress', output: [] },
      },
    },
  ]
  const output: unknown[] = []
  let outputIndex = 0
  if (step.text) {
    const item = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step.text, annotations: [] }] }
    events.push({
      data: { type: 'response.output_item.added', output_index: outputIndex, item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
    })
    events.push({
      data: { type: 'response.content_part.added', item_id: 'msg_1', output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    })
    events.push({ data: { type: 'response.output_text.delta', item_id: 'msg_1', output_index: outputIndex, content_index: 0, delta: step.text } })
    events.push({
      data: { type: 'response.output_text.done', item_id: 'msg_1', output_index: outputIndex, content_index: 0, text: step.text },
    })
    events.push({
      data: { type: 'response.content_part.done', item_id: 'msg_1', output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: step.text, annotations: [] } },
    })
    events.push({ data: { type: 'response.output_item.done', output_index: outputIndex, item } })
    output.push(item)
    outputIndex += 1
  }
  for (const call of [step.toolCall, ...(step.moreToolCalls ?? [])]) {
    if (!call) continue
    const itemId = `fc_${call.id}`
    const done = { id: itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: call.args, status: 'completed' }
    events.push({
      data: { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemId, type: 'function_call', call_id: call.id, name: call.name, arguments: '', status: 'in_progress' } },
    })
    for (const part of chunks(call.args)) {
      events.push({ data: { type: 'response.function_call_arguments.delta', item_id: itemId, output_index: outputIndex, delta: part } })
    }
    events.push({ data: { type: 'response.function_call_arguments.done', item_id: itemId, output_index: outputIndex, arguments: call.args } })
    events.push({ data: { type: 'response.output_item.done', output_index: outputIndex, item: done } })
    output.push(done)
    outputIndex += 1
  }
  events.push({
    data: {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        object: 'response',
        created_at: 1,
        model: 'gpt-5.6',
        status: 'completed',
        incomplete_details: null,
        output,
        usage: { input_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens: 14, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 44 },
      },
    },
  })
  return sse(events)
}

/** OpenAI Chat Completions streaming (what `@ai-sdk/openai-compatible` uses: custom endpoints, Ollama, Groq, ...). */
export function chatCompletionsStep(step: ScriptedStep): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null, usage?: unknown): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'local-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`
  let body = chunk({ role: 'assistant', content: '' }, null)
  if (step.text) body += chunk({ content: step.text }, null)
  const calls = [step.toolCall, ...(step.moreToolCalls ?? [])].filter((c): c is NonNullable<typeof c> => Boolean(c))
  calls.forEach((call, i) => {
    body += chunk({ tool_calls: [{ index: i, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }, null)
    for (const part of chunks(call.args)) {
      body += chunk({ tool_calls: [{ index: i, function: { arguments: part } }] }, null)
    }
  })
  body += chunk({}, calls.length > 0 ? 'tool_calls' : 'stop')
  body += `data: ${JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'local-model', choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 } })}\n\n`
  body += 'data: [DONE]\n\n'
  return body
}

export interface RecordedRequest {
  url: string
  body: Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A `fetch` that answers each call with the next scripted body and records the request. */
export function scriptedFetch(bodies: string[]): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = []
  let next = 0
  const fetchImpl = (async (input: unknown, init?: { body?: unknown }) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
    const body = bodies[next]
    next += 1
    if (body === undefined) {
      return new Response(JSON.stringify({ error: { message: 'script exhausted' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}
