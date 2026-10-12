import {
  isStepCount,
  jsonSchema,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type SystemModelMessage,
  type ToolSet,
} from 'ai'
import type { AgentToolOutcome, AgentToolSpec, ProviderChatRequest, ProviderStreamEvent, ProviderUsage } from '../types'

/** `streamText`'s own `providerOptions` type, read off its parameters
 * rather than imported directly — it's assembled internally from
 * `@ai-sdk/provider-utils` and not part of `ai`'s public export surface, so
 * this stays correct across versions without reaching into an internal
 * package. */
export type StreamTextProviderOptions = NonNullable<Parameters<typeof streamText>[0]['providerOptions']>

/**
 * `ai@7` rejects any `system` message inside `messages` ("System messages are
 * not allowed in the prompt or messages fields. Use the instructions option
 * instead.") — before a request is even sent, for every provider. So system
 * messages are lifted out into `instructions`, in order, and only user /
 * assistant turns stay in `messages`. Callers should only ever send our own
 * trusted prompts as `system`; untrusted content (attached files) belongs in
 * the user turn (see ChatService.buildProviderMessages).
 */
export function splitInstructions(messages: ProviderChatRequest['messages']): {
  instructions: SystemModelMessage[]
  messages: ModelMessage[]
} {
  const instructions: SystemModelMessage[] = []
  const rest: ModelMessage[] = []
  for (const message of messages) {
    if (message.role === 'system') instructions.push({ role: 'system', content: message.content })
    else if (message.role === 'assistant') rest.push({ role: 'assistant', content: message.content })
    else rest.push({ role: 'user', content: message.content })
  }
  return { instructions, messages: rest }
}

/**
 * A readable message for any thrown/streamed error. Some providers answer
 * with an error body the SDK cannot parse, which leaves `Error.message`
 * empty; fall back to the HTTP status and the raw body so the user (and the
 * connection test) never see a blank failure.
 */
export function describeStreamError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message) return err.message
    const detail = err as Error & { statusCode?: number; responseBody?: string }
    const body = detail.responseBody?.trim()
    if (detail.statusCode !== undefined || body) {
      return `HTTP ${detail.statusCode ?? '?'}${body ? `: ${body.slice(0, 500)}` : ''}`
    }
    return err.name || 'Unknown error'
  }
  return String(err)
}

/** Appended to the instructions on the last allowed model call of a tool run. */
export const FINAL_STEP_NOTICE =
  'This is your final step: the step limit has been reached and no further tool calls will be run. Reply now with a plain-text summary of what you did, what you found and anything left undone.'

type JsonSchemaArg = Parameters<typeof jsonSchema>[0]

/** Our provider-independent tool specs -> the AI SDK's tool set. This is the ONLY place that knows the SDK's tool shape. */
export function buildToolSet(specs: readonly AgentToolSpec[], fallbackSignal: AbortSignal): ToolSet {
  const set: ToolSet = {}
  for (const spec of specs) {
    const { validate } = spec
    set[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema<unknown>(
        spec.inputJsonSchema as JsonSchemaArg,
        validate ? { validate: (value: unknown) => validate(value) } : undefined,
      ),
      execute: async (input: unknown, options): Promise<AgentToolOutcome> =>
        spec.execute(input, { toolCallId: options.toolCallId, signal: options.abortSignal ?? fallbackSignal }),
      // Errors go back as an error result so the model can react; plain results as text, never JSON-wrapped.
      toModelOutput: ({ output }) => {
        const outcome = output as AgentToolOutcome
        return outcome.isError ? { type: 'error-text', value: outcome.text } : { type: 'text', value: outcome.text }
      },
    })
  }
  return set
}

/**
 * Shared streaming loop used by every real (`ai`-backed) adapter. Only the
 * `LanguageModel` instance differs between providers; the translation from
 * `ai`'s `stream` (text-delta/error parts) into our own `ProviderStreamEvent`
 * union is identical across Anthropic/OpenAI/Google.
 */
export async function* streamWithModel(
  model: LanguageModel,
  request: ProviderChatRequest,
  providerOptions?: StreamTextProviderOptions,
): AsyncGenerator<ProviderStreamEvent> {
  const { instructions, messages } = splitInstructions(request.messages)
  const toolOptions = request.toolOptions
  const maxSteps = toolOptions ? Math.max(1, Math.floor(toolOptions.maxSteps)) : 1

  const result = streamText({
    model,
    ...(instructions.length > 0 ? { instructions } : {}),
    messages,
    ...(request.signal ? { abortSignal: request.signal } : {}),
    ...(providerOptions ? { providerOptions } : {}),
    // Failures are reported through the stream as `error` events; the SDK's default handler would also dump them on stderr.
    onError: () => undefined,
    ...(toolOptions
      ? {
          tools: buildToolSet(toolOptions.tools, request.signal ?? new AbortController().signal),
          // The loop is bounded HERE, in our code: the step cap is a stop condition, not a request to the model.
          stopWhen: isStepCount(maxSteps),
          // On the last allowed step tell the model so it wraps up. Tool choice is deliberately NOT changed:
          // `none` makes the Anthropic adapter drop `tools` while earlier tool_use blocks are in the history,
          // which that API rejects.
          prepareStep: ({ stepNumber }: { stepNumber: number }) =>
            maxSteps > 1 && stepNumber >= maxSteps - 1
              ? { instructions: [...instructions, { role: 'system' as const, content: FINAL_STEP_NOTICE }] }
              : undefined,
        }
      : {}),
  })

  let accumulated = ''
  let usage: ProviderUsage | undefined
  let steps = 0
  let finishReason: string | undefined
  try {
    for await (const part of result.stream) {
      if (part.type === 'text-delta') {
        accumulated += part.text
        yield { type: 'text-delta', delta: part.text }
      } else if (part.type === 'start-step') {
        steps += 1
        if (toolOptions) yield { type: 'step-start', step: steps }
      } else if (part.type === 'tool-call') {
        yield {
          type: 'tool-call',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          ...(part.invalid ? { invalid: describeStreamError(part.error ?? 'invalid tool call') } : {}),
        }
      } else if (part.type === 'tool-result') {
        const outcome = part.output as Partial<AgentToolOutcome> | undefined
        yield {
          type: 'tool-result',
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          text: typeof outcome?.text === 'string' ? outcome.text : '',
          isError: outcome?.isError === true,
        }
      } else if (part.type === 'tool-error') {
        yield { type: 'tool-error', toolCallId: part.toolCallId, toolName: part.toolName, error: describeStreamError(part.error) }
      } else if (part.type === 'finish-step') {
        if (toolOptions) yield { type: 'step-finish', step: steps, finishReason: part.finishReason }
      } else if (part.type === 'abort') {
        yield { type: 'error', error: 'Aborted' }
        return
      } else if (part.type === 'finish') {
        finishReason = part.finishReason
        const inputTokens = part.totalUsage.inputTokens ?? null
        const outputTokens = part.totalUsage.outputTokens ?? null
        // A provider that reports nothing yields no usage at all (never zeros).
        if (inputTokens !== null || outputTokens !== null) usage = { inputTokens, outputTokens }
      } else if (part.type === 'error') {
        yield {
          type: 'error',
          error: describeStreamError(part.error),
        }
        return
      }
    }
    yield {
      type: 'done',
      text: accumulated,
      ...(usage ? { usage } : {}),
      ...(toolOptions ? { steps, ...(finishReason ? { finishReason } : {}) } : {}),
    }
  } catch (err) {
    yield { type: 'error', error: describeStreamError(err) }
  }
}
