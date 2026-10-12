/**
 * Secret redaction for everything that leaves the machine through a tool
 * result (ADR-041). A tool's output - a file the model read, a command's
 * output, a diff - is passed through `redactSecrets` before it is sent to the
 * provider, stored in the audit log, or shown in a prompt.
 *
 * This is a safety net, not a guarantee: it catches the COMMON secret shapes
 * (below). A secret in an unusual format, split across lines, or encoded is not
 * recognised. The real controls are that deny-listed files (.env, keys,
 * credentials) are unreadable by the tools in the first place (path-safety.ts)
 * and that the model cannot run a command without the user seeing it.
 */

export const REDACTED = '[REDACTED]'

interface Rule {
  name: string
  pattern: RegExp
  /** Replacement; defaults to the redaction marker. `$1` etc. keep the non-secret part. */
  replace?: string
}

// Order matters: the multi-line private key block goes first, then specific token
// shapes (so `sk-ant-` is not left half-matched by the generic `sk-` rule).
const RULES: Rule[] = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    replace: `-----BEGIN PRIVATE KEY----- ${REDACTED} -----END PRIVATE KEY-----`,
  },
  { name: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openrouter-key', pattern: /\bsk-or-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-style-key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'github-token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { name: 'gitlab-token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\b/g },
  { name: 'stripe-key', pattern: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { name: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'groq-or-xai-key', pattern: /\b(?:gsk_|xai-)[A-Za-z0-9]{20,}/g },
  {
    name: 'bearer-header',
    pattern: /(\bAuthorization\s*[:=]\s*["']?(?:Bearer|Basic|Token)\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    // A JSON Web Token: three base64url segments, the first two starting "eyJ".
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    // user:password@ inside a URL.
    name: 'url-credentials',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]{3,}(@)/gi,
    replace: `$1${REDACTED}$2`,
  },
]

/**
 * `.env`-style assignments: `API_KEY=...`, `export DB_PASSWORD: "..."`, `"client_secret": "..."`.
 * The key must look sensitive; the value (to end of line / closing quote) is replaced and the key kept.
 */
const SENSITIVE_KEY =
  /((?:^|[\s,{;])(?:export\s+|set\s+|\$env:)?["']?[A-Za-z0-9_.-]*?(?:API[_-]?KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE[_-]?KEY|CREDENTIALS?|ACCESS[_-]?KEY)(?:[_-]?(?:KEY|VALUE|BASE|ID|TOKEN))*["']?\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s"'#,;}][^\r\n#,;}]*)/gim

/**
 * Values that are code, not secrets: type annotations (`password: string`), literals, and references to where a
 * secret LIVES (`process.env.X`, `os.environ[...]`, `${VAR}`, `$VAR`, `getenv(...)`, `<placeholder>`). Redacting
 * these would only break the model's view of ordinary source files.
 */
const NOT_A_SECRET_VALUE =
  /^(?:true|false|null|undefined|none|nil|string|number|boolean|any|unknown|str|int|bool|bytes|object|void|never|required|optional|secret(?:str)?|password)[\s,;?]*$|^(?:process\.env|import\.meta\.env|os\.environ|os\.getenv|env\(|getenv\(|System\.getenv|ENV\[)|^\$\{?[A-Za-z_]\w*\}?$|^<[^>]*>$|^%[A-Za-z_]\w*%$/i

/** Values this short are placeholders (`TOKEN=1`, `PASSWORD=x`), not secrets - keep the output readable. */
const MIN_ASSIGNED_SECRET_LENGTH = 4

export function redactSecrets(text: string, extraSecrets: readonly string[] = []): string {
  if (text === '') return text
  let out = text
  for (const rule of RULES) out = out.replace(rule.pattern, rule.replace ?? REDACTED)
  out = out.replace(SENSITIVE_KEY, (match, prefix: string) => {
    const value = match.slice(prefix.length)
    const bare = value.replace(/^["']|["']$/g, '')
    if (bare.length < MIN_ASSIGNED_SECRET_LENGTH || bare === REDACTED || NOT_A_SECRET_VALUE.test(bare)) {
      return match
    }
    return `${prefix}${REDACTED}`
  })
  // Exact values the app itself knows are secret (e.g. decrypted provider keys), whatever their shape.
  for (const secret of extraSecrets) {
    if (secret.length >= 8) out = out.split(secret).join(REDACTED)
  }
  return out
}

/** True when `redactSecrets` would change the text (used to flag results in the audit log). */
export function containsSecret(text: string, extraSecrets: readonly string[] = []): boolean {
  return redactSecrets(text, extraSecrets) !== text
}
