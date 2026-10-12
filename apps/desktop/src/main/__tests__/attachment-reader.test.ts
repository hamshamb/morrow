import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ATTACHMENT_BYTES } from '@ai-workspace/shared'
import { readAttachmentFile, readAttachmentFiles } from '../attachment-reader'

describe('readAttachmentFile', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-workspace-attachment-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads a supported text file and infers its mime type', () => {
    const filePath = join(dir, 'notes.md')
    writeFileSync(filePath, '# Notes', 'utf8')
    const attachment = readAttachmentFile(filePath)
    expect(attachment).toMatchObject({
      filename: 'notes.md',
      mimeType: 'text/markdown',
      content: '# Notes',
    })
  })

  it('defaults to text/plain for a supported extension with no specific mapping', () => {
    const filePath = join(dir, 'script.py')
    writeFileSync(filePath, 'print(1)', 'utf8')
    expect(readAttachmentFile(filePath).mimeType).toBe('text/plain')
  })

  it('rejects an unsupported extension', () => {
    const filePath = join(dir, 'photo.png')
    writeFileSync(filePath, 'binary-ish', 'utf8')
    expect(() => readAttachmentFile(filePath)).toThrow(/unsupported type \.png/)
  })

  it('rejects a file larger than MAX_ATTACHMENT_BYTES', () => {
    const filePath = join(dir, 'huge.txt')
    writeFileSync(filePath, 'x'.repeat(MAX_ATTACHMENT_BYTES + 1), 'utf8')
    expect(() => readAttachmentFile(filePath)).toThrow(/too large/)
  })

  it('rejects binary content behind a text extension', () => {
    const filePath = join(dir, 'renamed.txt')
    writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x0d]))
    expect(() => readAttachmentFile(filePath)).toThrow(/binary file/)
  })
})

describe('readAttachmentFiles', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-workspace-attachments-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads every good file and reports each bad one with its reason, without failing the batch', () => {
    writeFileSync(join(dir, 'a.md'), '# A', 'utf8')
    writeFileSync(join(dir, 'b.ts'), 'export {}', 'utf8')
    writeFileSync(join(dir, 'c.png'), 'x', 'utf8')
    writeFileSync(join(dir, 'd.txt'), Buffer.from([0x00, 0x01]))
    const result = readAttachmentFiles(['a.md', 'b.ts', 'c.png', 'd.txt', 'missing.md'].map((f) => join(dir, f)))
    expect(result.attachments.map((a) => a.filename)).toEqual(['a.md', 'b.ts'])
    expect(result.rejected.map((r) => r.filename)).toEqual(['c.png', 'd.txt', 'missing.md'])
    expect(result.rejected[0]?.reason).toBe('unsupported type .png')
    expect(result.rejected[1]?.reason).toBe('binary file')
    expect(result.rejected[2]?.reason).toMatch(/ENOENT|no such file/i)
  })
})
