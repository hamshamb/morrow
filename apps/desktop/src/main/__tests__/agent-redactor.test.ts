import { describe, expect, it } from 'vitest'
import { REDACTED, containsSecret, redactSecrets } from '../agent/redactor'

// Fake secrets, built at runtime so no scanner mistakes this file for a leak.
const fake = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',
  anthropic: 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWx',
  openai: 'sk-' + 'proj-AbCdEfGhIjKlMnOpQrStUvWxYz012345',
  google: 'AIza' + 'SyA-1234567890abcdefghijklmnopqrstu',
  github: 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789',
  githubPat: 'github_pat_' + '11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz',
  slack: 'xoxb-' + '123456789012-abcdefghijkl',
  jwt: 'eyJhbGciOiJIUzI1NiJ9' + '.eyJzdWIiOiIxMjM0NTY3ODkwIn0.' + 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
}

describe('redactSecrets - token shapes', () => {
  it.each(Object.entries(fake))('redacts a %s secret', (_name, secret) => {
    const out = redactSecrets(`before ${secret} after`)
    expect(out).not.toContain(secret)
    expect(out).toContain(REDACTED)
    expect(out.startsWith('before ')).toBe(true)
    expect(out.endsWith(' after')).toBe(true)
  })

  it('redacts a whole private key block, keeping the surrounding text', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxxxxxx\nyyyyyyyyyyyyyyyy\n-----END RSA PRIVATE KEY-----'
    const out = redactSecrets(`config:\n${key}\nend`)
    expect(out).not.toContain('MIIEow')
    expect(out).not.toContain('yyyyyyyy')
    expect(out).toContain('config:')
    expect(out).toContain('end')
  })

  it('redacts an unterminated private key block to the end of the text (a truncated read)', () => {
    const out = redactSecrets('x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA')
    expect(out).not.toContain('b3BlbnNzaC1rZXk')
  })

  it('redacts credentials inside a URL but keeps host and user', () => {
    const out = redactSecrets('git clone https://deploy:hunter2hunter2@github.com/acme/app.git')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('https://deploy:')
    expect(out).toContain('@github.com/acme/app.git')
  })

  it('redacts an Authorization header value', () => {
    const out = redactSecrets('curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://x')
    expect(out).not.toContain('abcdefghijklmnop')
    expect(out).toContain('Authorization: Bearer')
  })

  it('uses the specific rule for sk-ant- keys rather than leaving a stub of the generic one', () => {
    const out = redactSecrets(`key=${fake.anthropic}`)
    expect(out).not.toMatch(/sk-ant/)
  })
})

describe('redactSecrets - .env style assignments', () => {
  it('redacts the value of sensitive keys and keeps the key', () => {
    const env = [
      'DATABASE_URL=postgres://localhost/db',
      'API_KEY=abc123def456',
      'export GITHUB_TOKEN=notatokenshape12345',
      'DB_PASSWORD="p@ss w0rd!"',
      "client_secret: 'zzzzzzzz'",
      'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      '"stripeSecretKey": "whsec_abcdef123456"',
    ].join('\n')
    const out = redactSecrets(env)
    for (const leaked of ['abc123def456', 'notatokenshape12345', 'p@ss w0rd!', 'zzzzzzzz', 'wJalrXUtnFEMI', 'whsec_abcdef123456']) {
      expect(out).not.toContain(leaked)
    }
    expect(out).toContain('API_KEY=')
    expect(out).toContain('DATABASE_URL=postgres://localhost/db') // not a sensitive key name: untouched
    expect(out.split('\n')).toHaveLength(7)
  })

  it('does not mangle ordinary code and config that merely mention these words', () => {
    const code = [
      'const maxTokens = 4096',
      'max_tokens: 4096',
      'tokenizer: "bpe"',
      'author = "Jane"',
      'password: string',
      'secret = true',
      'if (token === undefined) return',
      'TOKEN=1',
    ].join('\n')
    expect(redactSecrets(code)).toBe(code)
  })

  it('redacts exact values the app knows are secret, whatever their shape', () => {
    const out = redactSecrets('the key is hunter2-very-secret-value here', ['hunter2-very-secret-value'])
    expect(out).toBe(`the key is ${REDACTED} here`)
    // A short "secret" is ignored: replacing "a" everywhere would wreck the text.
    expect(redactSecrets('banana', ['a'])).toBe('banana')
  })
})

describe('redactSecrets - safety properties', () => {
  it('leaves clean text untouched and is idempotent', () => {
    const text = 'function add(a, b) {\n  return a + b\n}\n// see https://example.com/docs?page=2'
    expect(redactSecrets(text)).toBe(text)
    const dirty = `a ${fake.github} b`
    expect(redactSecrets(redactSecrets(dirty))).toBe(redactSecrets(dirty))
  })

  it('handles empty input and very long input', () => {
    expect(redactSecrets('')).toBe('')
    const long = 'x'.repeat(500_000) + ' ' + fake.aws + ' ' + 'y'.repeat(500_000)
    const started = Date.now()
    const out = redactSecrets(long)
    expect(out).not.toContain(fake.aws)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('containsSecret reports whether anything would change', () => {
    expect(containsSecret('hello')).toBe(false)
    expect(containsSecret(fake.openai)).toBe(true)
  })
})
