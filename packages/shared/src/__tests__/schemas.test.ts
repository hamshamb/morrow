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
  UpdateConversationInputSchema,
} from '../conversation'
import { AttachmentSchema, MAX_ATTACHMENT_BYTES, PendingAttachmentSchema } from '../attachment'
import {
  SetWorkspaceFileRootInputSchema,
  WorkspaceFileRootSchema,
  WorkspaceFileSearchInputSchema,
} from '../workspace-file'
import {
  ContextSelectionSchema,
  ContextSourceSchema,
  GetContextInspectorInputSchema,
  estimateTokens,
} from '../context'

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
    expect(() =>
      AppSettingsSchema.parse({ theme: 'neon', activeWorkspaceId: null, lastModelSelection: null }),
    ).toThrow()
  })

  it('round-trips a persisted last-used model selection', () => {
    const settings = {
      theme: 'dark',
      activeWorkspaceId: 'ws-1',
      lastModelSelection: { providerConfigId: 'pc-1', model: 'o3-mini', effort: 'medium' },
    }
    expect(AppSettingsSchema.parse(settings)).toEqual(settings)
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

describe('UpdateConversationInputSchema', () => {
  it('requires an id and a non-empty title', () => {
    expect(UpdateConversationInputSchema.parse({ id: 'c-1', title: 'Renamed' })).toEqual({
      id: 'c-1',
      title: 'Renamed',
    })
  })

  it('rejects an empty title', () => {
    expect(() => UpdateConversationInputSchema.parse({ id: 'c-1', title: '' })).toThrow()
  })

  it('rejects a missing id', () => {
    expect(() => UpdateConversationInputSchema.parse({ title: 'x' })).toThrow()
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

  it('accepts an optional reasoning effort', () => {
    const input = {
      requestId: 'req-1',
      conversationId: 'conv-1',
      providerConfigId: 'pc-1',
      model: 'claude-sonnet-5',
      content: 'Hello',
      effort: 'high',
    }
    expect(SendMessageInputSchema.parse(input)).toEqual(input)
  })

  it('accepts a null effort and omits it entirely without defaulting one in', () => {
    expect(
      SendMessageInputSchema.parse({
        requestId: 'req-1',
        conversationId: 'conv-1',
        providerConfigId: 'pc-1',
        model: 'gpt-4o',
        content: 'Hello',
        effort: null,
      }).effort,
    ).toBeNull()
    expect(
      SendMessageInputSchema.parse({
        requestId: 'req-1',
        conversationId: 'conv-1',
        providerConfigId: 'pc-1',
        model: 'gpt-4o',
        content: 'Hello',
      }).effort,
    ).toBeUndefined()
  })

  it('rejects an invalid effort value', () => {
    expect(() =>
      SendMessageInputSchema.parse({
        requestId: 'req-1',
        conversationId: 'conv-1',
        providerConfigId: 'pc-1',
        model: 'gpt-4o',
        content: 'Hello',
        effort: 'ultra',
      }),
    ).toThrow()
  })
})

describe('MessageSchema', () => {
  it('allows a null provider/model for user messages, defaulting attachments to empty', () => {
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
    expect(MessageSchema.parse(message)).toEqual({ ...message, attachments: [] })
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

  it('round-trips explicit attachments', () => {
    const attachment = {
      id: 'a1',
      messageId: 'm1',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      content: '# hello',
      createdAt: 1,
    }
    const message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      provider: null,
      model: null,
      status: 'complete',
      createdAt: 1,
      updatedAt: 1,
      parts: [],
      attachments: [attachment],
    }
    expect(MessageSchema.parse(message)).toEqual(message)
  })
})

describe('AttachmentSchema / PendingAttachmentSchema', () => {
  it('accepts a valid pending attachment', () => {
    const input = { filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, content: 'hello' }
    expect(PendingAttachmentSchema.parse(input)).toEqual(input)
  })

  it('rejects content larger than MAX_ATTACHMENT_BYTES', () => {
    const tooBig = 'x'.repeat(MAX_ATTACHMENT_BYTES + 1)
    expect(() =>
      PendingAttachmentSchema.parse({
        filename: 'a.txt',
        mimeType: 'text/plain',
        sizeBytes: tooBig.length,
        content: tooBig,
      }),
    ).toThrow()
  })

  it('rejects a missing filename', () => {
    expect(() =>
      PendingAttachmentSchema.parse({ mimeType: 'text/plain', sizeBytes: 1, content: 'a' }),
    ).toThrow()
  })

  it('round-trips a persisted attachment', () => {
    const attachment = {
      id: 'a1',
      messageId: 'm1',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      sizeBytes: 7,
      content: '# hi',
      createdAt: 1,
    }
    expect(AttachmentSchema.parse(attachment)).toEqual(attachment)
  })
})

describe('WorkspaceFileRootSchema / SetWorkspaceFileRootInputSchema', () => {
  it('accepts a valid root', () => {
    const root = { workspaceId: 'w1', rootPath: 'C:\\repo', createdAt: 1, updatedAt: 1 }
    expect(WorkspaceFileRootSchema.parse(root)).toEqual(root)
  })

  it('rejects an empty rootPath', () => {
    expect(() =>
      SetWorkspaceFileRootInputSchema.parse({ workspaceId: 'w1', rootPath: '' }),
    ).toThrow()
  })
})

describe('WorkspaceFileSearchInputSchema', () => {
  it('accepts a minimal query', () => {
    expect(WorkspaceFileSearchInputSchema.parse({ workspaceId: 'w1', query: 'foo' })).toMatchObject(
      { workspaceId: 'w1', query: 'foo' },
    )
  })

  it('rejects an empty query', () => {
    expect(() => WorkspaceFileSearchInputSchema.parse({ workspaceId: 'w1', query: '' })).toThrow()
  })
})

describe('estimateTokens', () => {
  it('divides character count by 4, rounding up', () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(4)).toBe(1)
    expect(estimateTokens(5)).toBe(2)
    expect(estimateTokens(400)).toBe(100)
  })
})

describe('ContextSourceSchema / ContextSelectionSchema', () => {
  it('accepts a full context source', () => {
    const source = {
      id: 'file:src/index.ts',
      type: 'workspace-file',
      label: 'src/index.ts',
      detail: null,
      characterCount: 400,
      estimatedTokens: 100,
      includedByDefault: true,
      exceedsBudget: false,
    }
    expect(ContextSourceSchema.parse(source)).toEqual(source)
  })

  it('rejects an unknown source type', () => {
    expect(() =>
      ContextSourceSchema.parse({
        id: 'x',
        type: 'not-a-type',
        label: 'x',
        detail: null,
        characterCount: 0,
        estimatedTokens: 0,
        includedByDefault: true,
        exceedsBudget: false,
      }),
    ).toThrow()
  })

  it('defaults an empty selection', () => {
    expect(ContextSelectionSchema.parse({})).toEqual({
      includeHistory: true,
      attachments: [],
      workspaceFilePaths: [],
      retrievalSnippetPaths: [],
    })
  })
})

describe('GetContextInspectorInputSchema', () => {
  it('requires workspaceId and conversationId but defaults the rest', () => {
    expect(
      GetContextInspectorInputSchema.parse({ workspaceId: 'w1', conversationId: 'c1' }),
    ).toEqual({
      workspaceId: 'w1',
      conversationId: 'c1',
      draftContent: '',
      pendingAttachments: [],
      selectedWorkspaceFilePaths: [],
    })
  })

  it('rejects a missing workspaceId', () => {
    expect(() => GetContextInspectorInputSchema.parse({ conversationId: 'c1' })).toThrow()
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
