/**
 * Test-only helpers: scripted server-sent-event bodies in each provider's real wire format plus a recording
 * `fetch`. Imported by tests as `@ai-workspace/providers/src/testing` - never by app code. They exist so
 * tool-calling behaviour can be proven through the REAL AI SDK without a network (a mock provider bypasses
 * the SDK's own validation, which is how the `system`-in-messages bug shipped).
 */
export {
  anthropicStep,
  chatCompletionsStep,
  openaiResponsesStep,
  scriptedFetch,
  type RecordedRequest,
  type ScriptedStep,
} from './__tests__/fixtures/sse-scripts'
