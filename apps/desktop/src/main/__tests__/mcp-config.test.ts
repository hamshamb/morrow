import { afterEach, describe, expect, it } from 'vitest'
import { McpNameTakenError } from '@ai-workspace/storage'
import { McpConfigError } from '../mcp/config-service'
import { fakeCrypto, makeMcpBed, stdioServer, type McpTestBed } from './mcp-utils'

let bed: McpTestBed
afterEach(() => bed?.cleanup())

const rawBlob = (id: string): string => (bed.repo.getSecrets(id) ?? Buffer.alloc(0)).toString('utf8')

describe('McpConfigService - saving', () => {
  it('stores a stdio server and returns it with secret values withheld', () => {
    bed = makeMcpBed()
    const saved = bed.config.save(
      stdioServer('files', {
        args: ['a.js', '--root', 'C:/x'],
        env: [
          { key: 'LOG_LEVEL', value: 'debug', secret: false },
          { key: 'API_TOKEN', value: 'tok_live_1234567890abcdef', secret: true },
        ],
      }),
    )
    expect(saved.env).toEqual([
      { key: 'LOG_LEVEL', value: 'debug', secret: false },
      { key: 'API_TOKEN', value: null, secret: true },
    ])
    // The value reached the database only inside the encrypted blob, never in a plain column.
    const row = bed.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(saved.id) as Record<string, unknown>
    const plain = JSON.stringify({ ...row, secrets: null })
    expect(plain).not.toContain('tok_live_1234567890abcdef')
    expect(rawBlob(saved.id)).not.toContain('tok_live')
    expect(rawBlob(saved.id)).toContain('enc1:')
    expect(fakeCrypto.decrypt(bed.repo.getSecrets(saved.id) as Buffer)).toContain('tok_live_1234567890abcdef')
  })

  it('a secret entry with no value keeps the stored one; a new value replaces it; dropping the entry removes it', () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('s', { env: [{ key: 'TOKEN', value: 'first-secret-value', secret: true }] }))
    const kept = bed.config.save(stdioServer('s', { id: saved.id, command: 'node2', env: [{ key: 'TOKEN', value: null, secret: true }] }))
    expect(kept.command).toBe('node2')
    expect(bed.config.resolveLaunch(saved.id).env).toEqual({ TOKEN: 'first-secret-value' })
    bed.config.save(stdioServer('s', { id: saved.id, env: [{ key: 'TOKEN', value: 'second-secret-value', secret: true }] }))
    expect(bed.config.resolveLaunch(saved.id).env).toEqual({ TOKEN: 'second-secret-value' })
    bed.config.save(stdioServer('s', { id: saved.id, env: [] }))
    expect(bed.config.resolveLaunch(saved.id).env).toEqual({})
    expect(bed.repo.getSecrets(saved.id)).toBeNull()
  })

  it('refuses a secret with no value and nothing stored', () => {
    bed = makeMcpBed()
    expect(() => bed.config.save(stdioServer('s', { env: [{ key: 'TOKEN', value: null, secret: true }] }))).toThrow(/Enter a value for the secret "TOKEN"/)
  })

  it('http: secret headers are encrypted, non-secret ones are not, and the launch merges both', () => {
    bed = makeMcpBed()
    const saved = bed.config.save({
      name: 'remote',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: [
        { key: 'X-Client', value: 'morrow', secret: false },
        { key: 'Authorization', value: 'Bearer abcdefghijklmnop', secret: true },
      ],
    })
    expect(saved.headers).toEqual([
      { key: 'X-Client', value: 'morrow', secret: false },
      { key: 'Authorization', value: null, secret: true },
    ])
    expect(rawBlob(saved.id)).not.toContain('abcdefghijklmnop')
    const launch = bed.config.resolveLaunch(saved.id)
    expect(launch.headers).toEqual({ 'X-Client': 'morrow', Authorization: 'Bearer abcdefghijklmnop' })
    expect(launch.secretValues).toEqual(['Bearer abcdefghijklmnop'])
    expect(launch.command).toBe('')
  })

  it('switching transport drops the other side (and its secrets)', () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('s', { env: [{ key: 'TOKEN', value: 'secretvalue123', secret: true }] }))
    const http = bed.config.save({ id: saved.id, name: 's', transport: 'http', url: 'https://example.com/mcp', env: [{ key: 'TOKEN', value: null, secret: true }] })
    expect(http.transport).toBe('http')
    expect(http.command).toBe('')
    expect(http.env).toEqual([])
    expect(bed.repo.getSecrets(saved.id)).toBeNull()
  })

  it('rejects bad input with every reason: name, command, url, headers, env', () => {
    bed = makeMcpBed()
    expect(() => bed.config.save({ name: 'Bad Name', transport: 'stdio', command: 'x' })).toThrow(McpConfigError)
    expect(() => bed.config.save({ name: 'ok', transport: 'stdio', command: '  ' })).toThrow(/Enter the command/)
    expect(() => bed.config.save({ name: 'ok', transport: 'http', url: 'http://example.com/mcp' })).toThrow(/localhost/)
    expect(() => bed.config.save({ name: 'ok', transport: 'http', url: 'file:///etc/passwd' })).toThrow(/https/)
    expect(() => bed.config.save({ name: 'ok', transport: 'http', url: 'https://u:p@example.com' })).toThrow(/user name or password/)
    expect(() => bed.config.save({ name: 'ok', transport: 'http', url: 'https://example.com', headers: [{ key: 'bad header', value: 'x', secret: false }] })).toThrow(/valid header/)
    expect(() => bed.config.save({ name: 'ok', transport: 'stdio', command: 'x', env: [{ key: '1X', value: 'v', secret: false }] })).toThrow(/valid environment/)
    expect(() => bed.config.save({ name: 'ok', transport: 'stdio', command: 'x', cwd: 'relative/dir' })).toThrow(/absolute/)
    expect(() => bed.config.save({ name: 'ok', transport: 'carrier-pigeon' } as never)).toThrow(McpConfigError)
    expect(bed.config.list()).toEqual([])
  })

  it('accepts http only for loopback, https anywhere', () => {
    bed = makeMcpBed()
    for (const [i, url] of ['https://mcp.example.com/mcp', 'http://localhost:3000/mcp', 'http://127.0.0.1:3000/mcp', 'http://[::1]:3000/mcp'].entries()) {
      expect(bed.config.save({ name: `h${i}`, transport: 'http', url }).url).toBe(url)
    }
  })

  it('names are unique; editing a server keeps its own name', () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('files'))
    expect(() => bed.config.save(stdioServer('files'))).toThrow(McpNameTakenError)
    expect(bed.config.save(stdioServer('files', { id: a.id, args: [] })).args).toEqual([])
  })

  it('a command is data: shell syntax in it is stored as a program name, never interpreted', () => {
    bed = makeMcpBed()
    const saved = bed.config.save(stdioServer('weird', { command: 'node && calc.exe', args: ['; rm -rf /', '$(whoami)'] }))
    expect(bed.config.resolveLaunch(saved.id)).toMatchObject({ command: 'node && calc.exe', args: ['; rm -rf /', '$(whoami)'] })
  })

  it('toggles tools and enabled, and deletes', () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('files'))
    expect(bed.config.setToolEnabled(a.id, 'wipe', false).disabledTools).toEqual(['wipe'])
    expect(bed.config.setToolEnabled(a.id, 'wipe', true).disabledTools).toEqual([])
    expect(bed.config.setEnabled(a.id, false).enabled).toBe(false)
    bed.config.delete(a.id)
    expect(bed.config.get(a.id)).toBeNull()
  })

  it('an undecryptable secrets blob behaves as unset instead of crashing', () => {
    bed = makeMcpBed()
    const a = bed.config.save(stdioServer('s', { env: [{ key: 'TOKEN', value: 'secretvalue123', secret: true }] }))
    bed.db.prepare('UPDATE mcp_servers SET secrets = ? WHERE id = ?').run(Buffer.from('garbage'), a.id)
    expect(bed.config.resolveLaunch(a.id).env).toEqual({})
    expect(() => bed.config.save(stdioServer('s', { id: a.id, env: [{ key: 'TOKEN', value: null, secret: true }] }))).toThrow(/Enter a value/)
  })
})
