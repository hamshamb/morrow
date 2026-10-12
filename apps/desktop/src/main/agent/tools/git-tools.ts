import { z } from 'zod'
import { TOOL_OUTPUT_CHAR_CAP, type GitChange, type GitStatus } from '@ai-workspace/shared'
import { unifiedDiff, truncateDiff } from '../unified-diff'
import { ToolError, type ToolDefinition } from './types'
import { toolPath } from './fs-tools'

/** Git tools are read-only on purpose: status, diff and log. There is no commit, push, reset, checkout or clean tool. */

function describeChange(change: GitChange): string {
  const counts = change.binary ? 'binary' : change.additions === null ? '' : `+${change.additions} -${change.deletions ?? 0}`
  const from = change.origPath ? ` (from ${change.origPath})` : ''
  return `  ${change.status.padEnd(10)} ${change.path}${from}${counts ? `  ${counts}` : ''}`
}

function notAvailable(status: GitStatus): string | null {
  if (status.state === 'git-missing') return 'git is not installed or not on PATH.'
  if (status.state === 'not-a-repo') return 'This workspace folder is not a git repository.'
  if (status.state === 'error') return `git failed: ${status.message}`
  return null
}

// ------------------------------------------------------------------ git.status

export const gitStatus: ToolDefinition<Record<string, never>> = {
  id: 'git.status',
  description: 'Show the git branch and which files are staged, modified or untracked, with +added/-removed line counts. Read-only.',
  inputSchema: z.object({}) as unknown as z.ZodType<Record<string, never>>,
  risk: 'safe',
  label: () => 'git status',
  async run(_input, ctx) {
    const status = await ctx.services.git.status(ctx.workspaceId)
    const unavailable = notAvailable(status)
    if (unavailable || status.state !== 'ok') return { text: unavailable ?? 'git status unavailable', summary: 'unavailable', isError: true }
    const sections: string[] = []
    const add = (title: string, changes: GitChange[]): void => {
      if (changes.length > 0) sections.push(`${title}:\n${changes.map(describeChange).join('\n')}`)
    }
    add('Staged', status.staged)
    add('Modified (not staged)', status.unstaged)
    add('Untracked', status.untracked)
    add('Conflicted', status.conflicted)
    const head = `On branch ${status.branch.head ?? '(detached HEAD)'}${status.commit ? ` at ${status.commit.shortSha} "${status.commit.subject}"` : ' (no commits yet)'}`
    const total = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length
    const text = sections.length === 0 ? `${head}\nWorking tree clean.` : `${head}\n${sections.join('\n')}${status.truncated ? '\n[list truncated]' : ''}`
    return { text, summary: total === 0 ? 'clean' : `${total} changed` }
  },
}

// ------------------------------------------------------------------ git.diff

const DiffInput = z.object({
  path: z.string().max(4096).optional().describe('A file to diff. Omit to list every changed file with line counts.'),
  area: z.enum(['staged', 'unstaged', 'untracked']).optional().describe('staged = index vs HEAD; unstaged (default) = working tree vs index; untracked = a new file.'),
})

export const gitDiff: ToolDefinition<z.infer<typeof DiffInput>> = {
  id: 'git.diff',
  description:
    'Show uncommitted changes. With a path: the unified diff of that file (area staged | unstaged | untracked). Without a path: the list of changed files with +/- counts. Read-only; secrets files are never shown.',
  inputSchema: DiffInput,
  risk: 'safe',
  label: (input) => (input.path ? `git diff ${input.path}` : 'git diff'),
  async run(input, ctx) {
    if (!input.path) {
      const status = await ctx.services.git.status(ctx.workspaceId)
      const unavailable = notAvailable(status)
      if (unavailable || status.state !== 'ok') return { text: unavailable ?? 'unavailable', summary: 'unavailable', isError: true }
      const rows = [
        ...status.staged.map((c) => `staged    ${describeChange(c).trim()}`),
        ...status.unstaged.map((c) => `unstaged  ${describeChange(c).trim()}`),
        ...status.untracked.map((c) => `untracked ${describeChange(c).trim()}`),
      ]
      return { text: rows.length === 0 ? 'No uncommitted changes.' : rows.join('\n'), summary: rows.length === 0 ? 'clean' : `${rows.length} file${rows.length === 1 ? '' : 's'}` }
    }
    const path = toolPath(input.path)
    const area = input.area ?? 'unstaged'
    const result = await ctx.services.git.diff(ctx.workspaceId, path, area)
    if (result.status !== 'ok') return { text: `${path}: ${result.message}`, summary: result.status, isError: result.status === 'protected' }
    const diff = unifiedDiff(path, result.original, result.modified, { isNew: result.original === '' && area === 'untracked' })
    if (diff === '') {
      return { text: `No ${area} changes in ${path}.${area === 'unstaged' ? ' (Try area: "staged" or "untracked".)' : ''}`, summary: 'no changes' }
    }
    const lines = diff.split('\n')
    const added = lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length
    const removed = lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length
    return { text: truncateDiff(diff, TOOL_OUTPUT_CHAR_CAP), summary: `+${added} -${removed}`, detail: truncateDiff(diff, 60_000) }
  },
}

// ------------------------------------------------------------------ git.log

const LogInput = z.object({
  limit: z.number().int().min(1).max(50).optional().describe('How many commits (default 15).'),
  path: z.string().max(4096).optional().describe('Only commits that touched this file.'),
})

export const gitLog: ToolDefinition<z.infer<typeof LogInput>> = {
  id: 'git.log',
  description: 'Show recent commits (hash, date, author, subject), newest first, optionally only those touching one file. Read-only.',
  inputSchema: LogInput,
  risk: 'safe',
  label: (input) => `git log${input.path ? ` ${input.path}` : ''}`,
  async run(input, ctx) {
    const path = input.path ? toolPath(input.path) : undefined
    let entries
    try {
      entries = await ctx.services.git.log(ctx.workspaceId, input.limit ?? 15, path)
    } catch (err) {
      throw new ToolError(`git log failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (entries.length === 0) return { text: 'No commits.', summary: 'no commits' }
    return {
      text: entries.map((e) => `${e.shortHash} ${e.date} ${e.author}: ${e.subject}`).join('\n'),
      summary: `${entries.length} commit${entries.length === 1 ? '' : 's'}`,
    }
  },
}

export const GIT_TOOLS = [gitStatus, gitDiff, gitLog]
