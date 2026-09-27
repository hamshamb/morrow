import { describe, expect, it } from 'vitest'
import { AppSettingsSchema, DEFAULT_SETTINGS } from '../settings'
import { CreateWorkspaceInputSchema, UpdateWorkspaceInputSchema } from '../workspace'
import {
  AddProviderConfigInputSchema,
  ProviderConfigSummarySchema,
  ProviderIdSchema,
} from '../provider'
import {
  ChatStreamEventSchema,
  CreateConversationInputSchema,
  MessageSchema,
  SendMessageInputSchema,
} from '../conversation'

describe('CreateWorkspaceInputSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(CreateWorkspaceInputSchema.parse({ name: 'My workspace' })).toEqual({
      name: 'My workspace',
    })
  })

  it('rejects an empty name', () => {
    expect(() => CreateWorkspaceInputSchema.parse({ name: '' })).toThrow()
  })

  it('rejects a missing name', () => {
    expect(() => CreateWorkspaceInputSchema.parse({})).toThrow()
  })
})

describe('UpdateWorkspaceInputSchema', () => {
  it('requires an id but allows partial fields', () => {
    expect(UpdateWorkspaceInputSchema.parse({ id: 'abc' })).toEqual({ id: 'abc' })
  })

  it('rejects a missing id', () => {
    expect(() => UpdateWorkspaceInputSchema.parse({ name: 'x' })).toThrow()
  })
})

describe('AppSettingsSchema', () => {
  it('validates the default settings', () => {
    expect(AppSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects an invalid theme', () => {
    expect(() => AppSettingsSchema.parse({ theme: 'neon', activeWorkspaceId: null })).toThrow()
  })
})

describe('ProviderIdSchema', () => {
  it('accepts the three supported providers', () => {
    expect(ProviderIdSchema.parse('anthropic')).toBe('anthropic')
    expect(ProviderIdSchema.parse('openai')).toBe('openai')
    expect(ProviderIdSchema.parse('google')).toBe('google')
  })

  it('rejects an unsupported provider', () => {
    expect(() => ProviderIdSchema.parse('mistral')).toThrow()
  })
})

describe('AddProviderConfigInputSchema', () => {
  it('accepts a minimal valid input', () => {
    const input = { provider: 'anthropic', label: 'Personal key', apiKey: 'sk-ant-abc123' }
    expect(AddProviderConfigInputSchema.parse(input)).toMatchObject(input)
  })

  it('rejects an empty api key', () => {
    expect(() =>
      AddProviderConfigInputSchema.parse({ provider: 'openai', label: 'x', apiKey: '' }),
    ).toThrow()
  })

  it('rejects an invalid base url', () => {
    expect(() =>
      AddProviderConfigInputSchema.parse({
        provider: 'openai',
        label: 'x',
        apiKey: 'sk-1',
        baseUrl: 'not-a-url',
      }),
    ).toThrow()
  })
})

describe('ProviderConfigSummarySchema', () => {
  it('never round-trips a raw key field', () => {
    const summary = {
      id: '1',
      provider: 'openai',
      label: 'Work key',
      maskedKey: 'sk-...ab12',
      baseUrl: null,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(ProviderConfigSummarySchema.parse(summary)).toEqual(summary)
    expect(ProviderConfigSummarySchema.safeParse({ ...summary, apiKey: 'sk-real-secret' }).data)
      .not.toHaveProperty('apiKey')
  })
})

describe('CreateConversationInputSchema', () => {
  it('requires a workspaceId but allows an optional title', () => {
    expect(CreateConversationInputSchema.parse({ workspaceId: 'ws-1' })).toEqual({
      workspaceId: 'ws-1',
    })
  })

  it('rejects a missing workspaceId', () => {
    expect(() => CreateConversationInputSchema.parse({ title: 'Untitled' })).toThrow()
  })
})

describe('SendMessageInputSchema', () => {
  it('accepts a full valid input', () => {
    const input = {
      requestId: 'req-1',
      conversationId: 'conv-1',
      providerConfigId: 'pc-1',
      model: 'claude-sonnet-4-5',
      content: 'Hello',
    }
    expect(SendMessageInputSchema.parse(input)).toEqual(input)
  })

  it('rejects empty content', () => {
    expect(() =>
      SendMessageInputSchema.parse({
        requestId: 'req-1',
        conversationId: 'conv-1',
        providerConfigId: 'pc-1',
        model: 'gpt-4o',
        content: '',
      }),
    ).toThrow()
  })
})

describe('MessageSchema', () => {
  it('allows a null provider/model for user messages', () => {
    const message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      createdAt: 1,
      updatedAt: 1,
      parts: [{ id: 'p1', messageId: 'm1', type: 'text', content: 'hi', position: 0, createdAt: 1 }],
    }
    expect(MessageSchema.parse(message)).toEqual(message)
  })

  it('requires provider/model to be a supported provider id or null', () => {
    const base = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      model: 'gpt-4o',
      status: 'complete',
      createdAt: 1,
      updatedAt: 1,
      parts: [],
    }
    expect(() => MessageSchema.parse({ ...base, provider: 'not-a-provider' })).toThrow()
    expect(MessageSchema.parse({ ...base, provider: 'openai' }).provider).toBe('openai')
  })
})

describe('ChatStreamEventSchema', () => {
  it('accepts a delta event', () => {
    expect(ChatStreamEventSchema.parse({ type: 'delta', delta: 'hi' })).toEqual({
      type: 'delta',
      delta: 'hi',
    })
  })

  it('accepts an error event', () => {
    expect(ChatStreamEventSchema.parse({ type: 'error', message: 'boom' })).toEqual({
      type: 'error',
      message: 'boom',
    })
  })

  it('rejects an unknown event type', () => {
    expect(() => ChatStreamEventSchema.parse({ type: 'ping' })).toThrow()
  })
})
