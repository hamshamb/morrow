import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES } from '@ai-workspace/shared'
import { base64Bytes, capToolText, formatCallToolResult } from '../mcp/result-format'
import { readResourceAttachments, resourceFileName, resourcesToAttachments, type ReadContent } from '../mcp/resource-attachments'
import { basicSchemaProblem, cleanDisplayText, mcpArgumentsSchema, providerInputSchema } from '../mcp/tool-adapter'
import { buildMcpStdioEnv, inheritedEnvNames } from '../mcp/stdio-env'

describe('formatCallToolResult', () => {
  it('joins text blocks', () => {
    expect(formatCallToolResult({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toEqual({ text: 'a\nb', isError: false })
  })

  it('image and audio become a placeholder with the mime type and decoded size', () => {
    const data = Buffer.alloc(1500, 1).toString('base64')
    const { text } = formatCallToolResult({ content: [{ type: 'image', data, mimeType: 'image/png' }, { type: 'audio', data, mimeType: 'audio/mpeg' }] })
    expect(text).toBe('[image omitted: image/png, 1500 bytes]\n[audio omitted: audio/mpeg, 1500 bytes]')
  })

  it('embedded resources: text as text, blobs as a placeholder; links as their uri', () => {
    const out = formatCallToolResult({
      content: [
        { type: 'resource', resource: { uri: 'a://1', text: 'hello' } },
        { type: 'resource', resource: { uri: 'a://2', mimeType: 'image/png', blob: Buffer.alloc(9).toString('base64') } },
        { type: 'resource_link', uri: 'a://3', name: 'three' },
      ],
    })
    expect(out.text).toBe('hello\n[binary resource omitted: a://2, image/png, 9 bytes]\na://3')
  })

  it('structuredContent only when there is no text', () => {
    expect(formatCallToolResult({ content: [], structuredContent: { n: 1 } }).text).toBe('{\n  "n": 1\n}')
    expect(formatCallToolResult({ content: [{ type: 'text', text: 'prose' }], structuredContent: { n: 1 } }).text).toBe('prose')
  })

  it('isError is carried; an empty result says so; nothing instruction-like is added', () => {
    expect(formatCallToolResult({ isError: true, content: [{ type: 'text', text: 'bad' }] })).toEqual({ text: 'bad', isError: true })
    expect(formatCallToolResult({ isError: true, content: [] })).toEqual({ text: 'The tool reported an error without a message.', isError: true })
    expect(formatCallToolResult({ content: [] })).toEqual({ text: '(the tool returned no content)', isError: false })
    expect(formatCallToolResult(null)).toEqual({ text: '(the tool returned no content)', isError: false })
  })

  it('an unknown block type or garbage block is a bounded placeholder, never executed or echoed whole', () => {
    expect(formatCallToolResult({ content: [{ type: 'hologram', secret: 'x'.repeat(5000) }, 42, null] }).text).toBe(
      '[unsupported content block: hologram]\n[unsupported content block]\n[unsupported content block]',
    )
  })

  it('old servers\' toolResult is shown when there is no content array', () => {
    expect(formatCallToolResult({ toolResult: { ok: true } }).text).toBe('{\n  "ok": true\n}')
  })

  it('base64Bytes handles padding and whitespace', () => {
    expect(base64Bytes('')).toBe(0)
    expect(base64Bytes('QQ==')).toBe(1)
    expect(base64Bytes('QUI=')).toBe(2)
    expect(base64Bytes('QUJD\n')).toBe(3)
  })

  it('capToolText keeps the head and says how much was cut', () => {
    expect(capToolText('abc', 10)).toEqual({ text: 'abc', truncated: false })
    expect(capToolText('abcdefghij', 4)).toEqual({ text: 'abcd\n[output truncated: 6 more characters]', truncated: true })
  })
})

describe('basicSchemaProblem', () => {
  const schema = {
    type: 'object',
    required: ['path'],
    properties: { path: { type: 'string' }, limit: { type: 'integer' }, mode: { enum: ['r', 'w'] }, either: { type: ['string', 'null'] }, flag: { type: 'boolean' } },
  }
  it.each([
    [{ path: 'a' }, null],
    [{ path: 'a', limit: 3, mode: 'r', either: null, flag: true }, null],
    [{}, 'missing required argument "path"'],
    [{ path: 1 }, 'argument "path" must be string'],
    [{ path: 'a', limit: 1.5 }, 'argument "limit" must be integer'],
    [{ path: 'a', mode: 'x' }, 'argument "mode" must be one of "r", "w"'],
    [{ path: 'a', either: 3 }, 'argument "either" must be string or null'],
    [{ path: 'a', unknown: 1 }, null],
  ])('%j -> %j', (value, expected) => {
    expect(basicSchemaProblem(schema, value)).toBe(expected)
  })

  it('additionalProperties: false rejects extras; a missing or odd schema accepts anything', () => {
    expect(basicSchemaProblem({ type: 'object', properties: {}, additionalProperties: false }, { x: 1 })).toBe('unexpected argument "x"')
    expect(basicSchemaProblem(undefined, { x: 1 })).toBeNull()
    expect(basicSchemaProblem('nonsense', { x: 1 })).toBeNull()
  })

  it('the zod schema rejects non-objects', () => {
    const zod = mcpArgumentsSchema(schema)
    expect(zod.safeParse(null).success).toBe(false)
    expect(zod.safeParse([1]).success).toBe(false)
    expect(zod.safeParse('x').success).toBe(false)
    expect(zod.safeParse({ path: 'a' }).success).toBe(true)
  })
})

describe('providerInputSchema / cleanDisplayText', () => {
  it('forces an object schema with properties and drops $schema', () => {
    expect(providerInputSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { a: { type: 'string' } } })).toEqual({ type: 'object', properties: { a: { type: 'string' } } })
  })
  it('strips control, zero-width and bidi characters', () => {
    expect(cleanDisplayText('a\u0000b\u200bc\u202ed\u2066e\ufefff\u001bg')).toBe('abcdefg')
    expect(cleanDisplayText('keeps\nnewlines\tand tabs')).toBe('keeps\nnewlines\tand tabs')
  })
})

describe('buildMcpStdioEnv - an allow-list, not a deny-list', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/u',
    USERPROFILE: 'C:\\Users\\u',
    SystemRoot: 'C:\\Windows',
    GITHUB_TOKEN: 'ghp_x',
    AWS_SECRET_ACCESS_KEY: 'aws',
    OPENAI_API_KEY: 'sk-x',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: '--require evil.js',
    BASH_FUNC_x: '() { evil; }',
    SHELL: '() { :; }; echo pwned',
    RANDOM_APP_SETTING: 'x',
  } as NodeJS.ProcessEnv

  it('passes only the inherited names, then the configured variables on top (which win)', () => {
    const env = buildMcpStdioEnv(parent, 'linux', { MY_TOKEN: 'configured', PATH: '/custom' })
    expect(env['PATH']).toBe('/custom')
    expect(env['HOME']).toBe('/home/u')
    expect(env['MY_TOKEN']).toBe('configured')
    for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'RANDOM_APP_SETTING', 'BASH_FUNC_x', 'USERPROFILE']) expect(env).not.toHaveProperty(name)
    // an exported shell function is code, not data
    expect(env).not.toHaveProperty('SHELL')
  })

  it('has a Windows list that includes what programs need to start', () => {
    const names = inheritedEnvNames('win32')
    for (const needed of ['PATH', 'SYSTEMROOT', 'USERPROFILE', 'APPDATA', 'PATHEXT', 'COMSPEC']) expect(names).toContain(needed)
    expect(names.some((n) => /TOKEN|SECRET|KEY|PASSWORD/i.test(n))).toBe(false)
  })
})

describe('MCP resources as attachments', () => {
  const text = (uri: string, body: string, mimeType?: string): ReadContent => ({ uri, text: body, ...(mimeType ? { mimeType } : {}) })
  const info = (name: string, uri: string, mimeType: string | null = null) => ({ name, uri, title: null, description: null, mimeType, size: null })

  it('names a file from the resource name (adding an extension from the mime type) or the last URI segment', () => {
    expect(resourceFileName(info('readme', 'notes://readme', 'text/markdown'), text('notes://readme', ''))).toBe('readme.md')
    expect(resourceFileName(null, text('file:///project/docs/todo.txt', ''))).toBe('todo.txt')
    expect(resourceFileName(info('data', 'x://d', 'application/json'), text('x://d', ''))).toBe('data.json')
    expect(resourceFileName(info('plain', 'x://p'), text('x://p', ''))).toBe('plain.txt')
    expect(resourceFileName(info('config.yaml', 'x://c'), text('x://c', ''))).toBe('config.yaml')
  })

  it('sanitises hostile names: separators, markup and control characters', () => {
    const name = resourceFileName(info('..\\..\\etc/<b>"x"\u0000.md', 'x://y'), text('x://y', ''))
    expect(name).not.toMatch(/[\\/<>":\u0000]/)
    expect(name.endsWith('.md')).toBe(true)
    expect(resourceFileName(info('x'.repeat(500), 'x://y'), text('x://y', '')).length).toBeLessThanOrEqual(124)
  })

  it('converts text, refuses binary blobs with a reason, and de-duplicates names', () => {
    const result = resourcesToAttachments([
      { resource: info('readme', 'a://1', 'text/markdown'), contents: [text('a://1', '# hi', 'text/markdown')] },
      { resource: info('readme', 'a://2', 'text/markdown'), contents: [text('a://2', '# again', 'text/markdown')] },
      { resource: info('logo', 'a://3', 'application/octet-stream'), contents: [{ uri: 'a://3', mimeType: 'application/octet-stream', blob: Buffer.alloc(2048).toString('base64') }] },
    ])
    expect(result.attachments.map((a) => [a.filename, a.mimeType, a.content])).toEqual([
      ['readme.md', 'text/markdown', '# hi'],
      ['readme (2).md', 'text/markdown', '# again'],
    ])
    expect(result.rejected).toEqual([{ filename: 'logo.txt', reason: 'binary content (application/octet-stream, 2,048 bytes) cannot be attached' }])
  })

  it('applies the attachment size cap and the NUL-byte binary check to text too', () => {
    const big = 'y'.repeat(MAX_ATTACHMENT_BYTES + 1)
    const result = resourcesToAttachments([
      { resource: info('huge', 'a://h', 'text/plain'), contents: [text('a://h', big)] },
      { resource: info('nul', 'a://n', 'text/plain'), contents: [text('a://n', 'abc\u0000def')] },
      { resource: info('empty', 'a://e'), contents: [] },
    ])
    expect(result.attachments).toEqual([])
    expect(result.rejected.map((r) => r.reason)).toEqual([expect.stringMatching(/^too large \(\d+ kB, max 512 kB\)$/), 'binary content', 'the server returned no content'])
  })

  it('readResourceAttachments only reads URIs the server listed, and reports a failing read without losing the others', async () => {
    const calls: string[] = []
    const source = {
      resources: () => Promise.resolve([info('a', 'x://a', 'text/plain'), info('b', 'x://b', 'text/plain')]),
      readResource: (_id: string, uri: string) => {
        calls.push(uri)
        if (uri === 'x://b') return Promise.reject(new Error('boom with key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'))
        return Promise.resolve({ contents: [text(uri, 'content of a')] })
      },
    }
    const result = await readResourceAttachments(source, 's', ['x://a', 'x://b', 'x://not-listed', 'x://a'], (t) => t.replace(/sk-ant-\S+/, '[REDACTED]'))
    expect(calls).toEqual(['x://a', 'x://b'])
    expect(result.attachments.map((a) => a.filename)).toEqual(['a.txt'])
    expect(result.rejected).toEqual([
      { filename: 'b', reason: 'boom with key [REDACTED]' },
      { filename: 'x://not-listed', reason: 'the server does not list this resource' },
    ])
  })
})
