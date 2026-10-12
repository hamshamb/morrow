import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConversationRepository,
  MessageRepository,
  WorkspaceFileRepository,
  WorkspaceRepository,
  openDatabase,
  type AppDatabase,
} from '@ai-workspace/storage'
import { CONTEXT_TOTAL_CHAR_CAP, estimateTokens } from '@ai-workspace/shared'
import { ContextService } from '../context-service'

describe('ContextService', () => {
  let db: AppDatabase
  let messages: MessageRepository
  let workspaceFiles: WorkspaceFileRepository
  let contextService: ContextService
  let workspaceId: string
  let conversationId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    conversationId = new ConversationRepository(db).create({ workspaceId }).id
    messages = new MessageRepository(db)
    workspaceFiles = new WorkspaceFileRepository(db)
    contextService = new ContextService({ messages, workspaceFiles })
  })

  afterEach(() => {
    db.close()
  })

  describe('buildInspectorState', () => {
    it('always includes a history source, counting the draft toward it', () => {
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: 'hello',
        pendingAttachments: [],
        selectedWorkspaceFilePaths: [],
      })
      const history = state.sources.find((s) => s.id === 'history')
      expect(history).toBeDefined()
      expect(history?.characterCount).toBe('hello'.length)
      expect(history?.includedByDefault).toBe(true)
      expect(history?.estimatedTokens).toBe(estimateTokens('hello'.length))
    })

    it('folds existing conversation history into the history source count', () => {
      messages.create({
        conversationId,
        role: 'user',
        provider: null,
        model: null,
        status: 'complete',
        parts: [{ type: 'text', content: '1234567890' }], // 10 chars
      })
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: 'abcde', // 5 chars
        pendingAttachments: [],
        selectedWorkspaceFilePaths: [],
      })
      expect(state.sources.find((s) => s.id === 'history')?.characterCount).toBe(15)
    })

    it('does not count replies that are out of the context (compare siblings the user did not continue with)', () => {
      const user = messages.create({
        conversationId,
        role: 'user',
        provider: null,
        model: null,
        status: 'complete',
        parts: [{ type: 'text', content: '1234567890' }], // 10 chars
      })
      const reply = (content: string, inContext: boolean) =>
        messages.create({
          conversationId,
          role: 'assistant',
          provider: 'openai',
          model: 'm',
          status: 'complete',
          parts: [{ type: 'text', content }],
          replyGroupId: user.id,
          orchestrationMode: 'compare',
          inContext,
        })
      reply('abcd', true) // 4 chars — the chosen column
      reply('z'.repeat(5_000), false) // a sibling that is never sent to a provider
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: '12', // 2 chars
        pendingAttachments: [],
        selectedWorkspaceFilePaths: [],
      })
      expect(state.sources.find((s) => s.id === 'history')?.characterCount).toBe(16)
    })

    it('surfaces a source per pending attachment, included by default', () => {
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: '',
        pendingAttachments: [
          { filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, content: 'hello' },
        ],
        selectedWorkspaceFilePaths: [],
      })
      const source = state.sources.find((s) => s.id === 'attachment:a.txt')
      expect(source).toMatchObject({
        type: 'attachment',
        label: 'a.txt',
        characterCount: 5,
        includedByDefault: true,
      })
    })

    it('surfaces a source per explicitly selected workspace file, reading real indexed content', () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'README.md', sizeBytes: 8, mtimeMs: 1, content: '# readme' },
      ])
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: '',
        pendingAttachments: [],
        selectedWorkspaceFilePaths: ['README.md'],
      })
      const source = state.sources.find((s) => s.id === 'file:README.md')
      expect(source).toMatchObject({ type: 'workspace-file', characterCount: 8, includedByDefault: true })
    })

    it('silently drops a selected workspace file path with no indexed content', () => {
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: '',
        pendingAttachments: [],
        selectedWorkspaceFilePaths: ['missing.txt'],
      })
      expect(state.sources.some((s) => s.id === 'file:missing.txt')).toBe(false)
    })

    it('auto-surfaces retrieval snippets from the draft text, excluding already-selected files', () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'src/auth.ts', sizeBytes: 30, mtimeMs: 1, content: 'function authenticate() {}' },
        {
          relativePath: 'src/other.ts',
          sizeBytes: 40,
          mtimeMs: 1,
          content: 'function authenticate(user) { return other(user) }',
        },
      ])
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: 'how does authenticate work?',
        pendingAttachments: [],
        selectedWorkspaceFilePaths: ['src/auth.ts'],
      })
      expect(state.sources.some((s) => s.id === 'file:src/auth.ts')).toBe(true)
      expect(state.sources.some((s) => s.id === 'retrieval:src/auth.ts')).toBe(false)
      expect(state.sources.some((s) => s.id === 'retrieval:src/other.ts')).toBe(true)
    })

    it('does not run retrieval for a too-short draft', () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'a.ts', sizeBytes: 10, mtimeMs: 1, content: 'ab content here' },
      ])
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: 'ab',
        pendingAttachments: [],
        selectedWorkspaceFilePaths: [],
      })
      expect(state.sources.some((s) => s.type === 'retrieval-snippet')).toBe(false)
    })

    it('reports totals as the sum of every listed source', () => {
      const state = contextService.buildInspectorState({
        workspaceId,
        conversationId,
        draftContent: 'hi',
        pendingAttachments: [
          { filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 3, content: 'abc' },
        ],
        selectedWorkspaceFilePaths: [],
      })
      expect(state.totalCharacterCount).toBe(2 + 3)
      expect(state.totalEstimatedTokens).toBe(estimateTokens(5))
      expect(state.budgetCharacterCap).toBe(CONTEXT_TOTAL_CHAR_CAP)
    })
  })

  describe('resolveContextBlock', () => {
    it('returns null when nothing is selected', () => {
      expect(
        contextService.resolveContextBlock(workspaceId, {
          includeHistory: true,
          attachments: [],
          workspaceFilePaths: [],
          retrievalSnippetPaths: [],
        }),
      ).toBeNull()
    })

    it('includes attachment content under a labeled header', () => {
      const block = contextService.resolveContextBlock(workspaceId, {
        includeHistory: true,
        attachments: [{ filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, content: 'hello' }],
        workspaceFilePaths: [],
        retrievalSnippetPaths: [],
      })
      expect(block).toContain('a.txt')
      expect(block).toContain('hello')
    })

    it('includes selected workspace file content by reading it fresh from the index', () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'src/index.ts', sizeBytes: 20, mtimeMs: 1, content: 'export const x = 1' },
      ])
      const block = contextService.resolveContextBlock(workspaceId, {
        includeHistory: true,
        attachments: [],
        workspaceFilePaths: ['src/index.ts'],
        retrievalSnippetPaths: [],
      })
      expect(block).toContain('src/index.ts')
      expect(block).toContain('export const x = 1')
    })

    it('includes selected retrieval snippet paths by reading their full indexed content', () => {
      workspaceFiles.replaceIndex(workspaceId, [
        { relativePath: 'src/math.ts', sizeBytes: 20, mtimeMs: 1, content: 'export const add = 1' },
      ])
      const block = contextService.resolveContextBlock(workspaceId, {
        includeHistory: true,
        attachments: [],
        workspaceFilePaths: [],
        retrievalSnippetPaths: ['src/math.ts'],
      })
      expect(block).toContain('export const add = 1')
    })

    it('truncates a single source at CONTEXT_PER_SOURCE_CHAR_CAP and the total block at CONTEXT_TOTAL_CHAR_CAP', () => {
      const huge = 'x'.repeat(CONTEXT_TOTAL_CHAR_CAP + 5_000)
      const block = contextService.resolveContextBlock(workspaceId, {
        includeHistory: true,
        attachments: [{ filename: 'huge.txt', mimeType: 'text/plain', sizeBytes: huge.length, content: huge }],
        workspaceFilePaths: [],
        retrievalSnippetPaths: [],
      })
      expect(block).not.toBeNull()
      expect(block?.length ?? 0).toBeLessThan(CONTEXT_TOTAL_CHAR_CAP + 1_000)
    })

    it('drops sources once the total budget is exhausted, in order', () => {
      // Each source is independently capped at CONTEXT_PER_SOURCE_CHAR_CAP,
      // so exhausting the *total* budget needs several max-sized sources —
      // three full-cap attachments exactly reach CONTEXT_TOTAL_CHAR_CAP.
      const full = 'a'.repeat(CONTEXT_TOTAL_CHAR_CAP)
      const block = contextService.resolveContextBlock(workspaceId, {
        includeHistory: true,
        attachments: [
          { filename: 'filler1.txt', mimeType: 'text/plain', sizeBytes: full.length, content: full },
          { filename: 'filler2.txt', mimeType: 'text/plain', sizeBytes: full.length, content: full },
          { filename: 'filler3.txt', mimeType: 'text/plain', sizeBytes: full.length, content: full },
          { filename: 'never.txt', mimeType: 'text/plain', sizeBytes: 5, content: 'never' },
        ],
        workspaceFilePaths: [],
        retrievalSnippetPaths: [],
      })
      expect(block).toContain('filler1.txt')
      expect(block).toContain('filler3.txt')
      expect(block).not.toContain('never.txt')
    })
  })
})
