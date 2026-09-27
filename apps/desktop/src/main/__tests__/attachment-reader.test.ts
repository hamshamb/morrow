import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ATTACHMENT_BYTES } from '@ai-workspace/shared'
import { readAttachmentFile } from '../attachment-reader'

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
    expect(() => readAttachmentFile(filePath)).toThrow(/Unsupported file type/)
  })

  it('rejects a file larger than MAX_ATTACHMENT_BYTES', () => {
    const filePath = join(dir, 'huge.txt')
    writeFileSync(filePath, 'x'.repeat(MAX_ATTACHMENT_BYTES + 1), 'utf8')
    expect(() => readAttachmentFile(filePath)).toThrow(/too large/)
  })
})
