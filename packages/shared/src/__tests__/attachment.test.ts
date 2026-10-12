import { describe, expect, it } from 'vitest'
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
  attachmentMimeType,
  attachmentRejectionReason,
  looksBinary,
  mergeAttachments,
  uniqueAttachmentName,
  type PendingAttachment,
} from '../attachment'
import { ContextSelectionSchema } from '../context'

const file = (filename: string): PendingAttachment => ({ filename, mimeType: 'text/plain', sizeBytes: 1, content: 'x' })

describe('attachment rules', () => {
  it('accepts supported text files and explains every rejection', () => {
    expect(attachmentRejectionReason('notes.md', 10)).toBeNull()
    expect(attachmentRejectionReason('App.TSX', 10)).toBeNull()
    expect(attachmentRejectionReason('photo.png', 10)).toBe('unsupported type .png')
    expect(attachmentRejectionReason('Makefile', 10)).toBe('unsupported type (no extension)')
    expect(attachmentRejectionReason('.env', 10)).toBe('unsupported type (no extension)')
    expect(attachmentRejectionReason('big.txt', MAX_ATTACHMENT_BYTES + 1)).toMatch(/^too large/)
  })

  it('maps known extensions to a mime type and defaults to text/plain', () => {
    expect(attachmentMimeType('a.md')).toBe('text/markdown')
    expect(attachmentMimeType('a.JSON')).toBe('application/json')
    expect(attachmentMimeType('a.ts')).toBe('text/plain')
  })

  it('detects binary content by NUL characters', () => {
    expect(looksBinary('plain text')).toBe(false)
    expect(looksBinary('PNG\u0000\u0001')).toBe(true)
  })
})

describe('uniqueAttachmentName', () => {
  it('numbers duplicates before the extension', () => {
    const taken = new Set(['notes.md', 'notes (2).md'])
    expect(uniqueAttachmentName(taken, 'new.md')).toBe('new.md')
    expect(uniqueAttachmentName(taken, 'notes.md')).toBe('notes (3).md')
    expect(uniqueAttachmentName(new Set(['README']), 'README')).toBe('README (2)')
  })
})

describe('mergeAttachments', () => {
  it('appends, keeps same-named files apart instead of replacing them', () => {
    const merged = mergeAttachments([file('a.md')], [file('a.md'), file('b.md'), file('a.md')])
    expect(merged.attachments.map((a) => a.filename)).toEqual(['a.md', 'a (2).md', 'b.md', 'a (3).md'])
    expect(merged.rejected).toEqual([])
  })

  it('stops at the per-message limit and reports the overflow', () => {
    const existing = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE - 1 }, (_, i) => file(`f${i}.md`))
    const merged = mergeAttachments(existing, [file('last.md'), file('over1.md'), file('over2.md')])
    expect(merged.attachments).toHaveLength(MAX_ATTACHMENTS_PER_MESSAGE)
    expect(merged.attachments.at(-1)?.filename).toBe('last.md')
    expect(merged.rejected.map((r) => r.filename)).toEqual(['over1.md', 'over2.md'])
  })
})

describe('ContextSelectionSchema attachment limit', () => {
  const selection = (n: number) => ({
    includeHistory: true,
    attachments: Array.from({ length: n }, (_, i) => file(`f${i}.md`)),
    workspaceFilePaths: [],
    retrievalSnippetPaths: [],
  })

  it('accepts up to the limit and refuses more at the IPC boundary', () => {
    expect(ContextSelectionSchema.safeParse(selection(MAX_ATTACHMENTS_PER_MESSAGE)).success).toBe(true)
    expect(ContextSelectionSchema.safeParse(selection(MAX_ATTACHMENTS_PER_MESSAGE + 1)).success).toBe(false)
  })
})
