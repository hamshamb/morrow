import { z } from 'zod'
import { AGENT_LIMITS, COMMAND_OUTPUT_CAP_BYTES, TOOL_OUTPUT_CHAR_CAP } from '@ai-workspace/shared'
import { assessCommand } from '../command-classifier'
import { runCommand } from '../command-runner'
import { ToolError, type ToolDefinition } from './types'

const ExecuteInput = z.object({
  command: z
    .string()
    .min(1)
    .max(8000)
    .describe('ONE command line to run once, non-interactively, in the workspace root. It cannot read input, so avoid anything that prompts. The user sees this exact text and must approve it.'),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(AGENT_LIMITS.commandTimeoutSeconds.hardCap)
    .optional()
    .describe('Kill the command after this many seconds (default 120, never more than the configured maximum).'),
})

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`

function shortCommand(command: string): string {
  const oneLine = command.replace(/\s+/g, ' ').trim()
  return oneLine.length > 90 ? `${oneLine.slice(0, 89)}…` : oneLine
}

export const terminalExecute: ToolDefinition<z.infer<typeof ExecuteInput>> = {
  id: 'terminal.execute',
  description:
    'Run one shell command in the workspace root (PowerShell on Windows, bash elsewhere), non-interactively with no profile and no stdin. Returns the exit code and the end of the output. Use it for tests, builds and inspection. Every command needs the user\'s approval; destructive commands (deleting files, git reset/clean, force-push, writing outside the workspace) can only be approved one at a time.',
  inputSchema: ExecuteInput,
  risk: 'execution',
  label: (input) => `run ${shortCommand(input.command)}`,
  assess(input, ctx) {
    const assessment = assessCommand(input.command)
    return {
      risk: assessment.risk,
      // In Plan mode the terminal is available but is asked about every single time.
      noGrant: assessment.noGrant || ctx.mode === 'plan',
      command: input.command,
      grantScopeNote: 'this exact command',
    }
  },
  async prepare(input, ctx) {
    const root = ctx.services.resolveRoot(ctx.workspaceId)
    if (!root) throw new ToolError('This workspace has no folder yet, so there is nowhere to run a command.')
    const limits = ctx.services.limits()
    const timeout = Math.min(input.timeoutSeconds ?? limits.commandTimeoutSeconds, limits.commandTimeoutSeconds)
    const assessment = assessCommand(input.command)
    return {
      state: { root, timeout },
      preview: {
        kind: 'command',
        command: input.command,
        cwd: root,
        shell: ctx.services.shell.title,
        timeoutSeconds: timeout,
        reasons: assessment.reasons,
      },
    }
  },
  async run(input, ctx, prepared) {
    const { root, timeout } = (prepared as { state: { root: string; timeout: number } }).state
    const result = await runCommand({
      command: input.command,
      cwd: root,
      timeoutMs: timeout * 1000,
      signal: ctx.signal,
      env: ctx.services.commandEnv(),
      shell: ctx.services.shell,
      outputCapBytes: COMMAND_OUTPUT_CAP_BYTES,
      onOutput: ctx.onOutput,
    })

    if (result.spawnError) {
      return { text: `The command could not be started: ${result.spawnError}`, summary: 'not started', isError: true, exitCode: null }
    }
    if (result.cancelled) {
      return { text: 'The command was cancelled and its process tree was killed.', summary: `cancelled · ${seconds(result.durationMs)}`, cancelled: true, exitCode: null, detail: result.output }
    }

    let output = result.output
    if (output.length > TOOL_OUTPUT_CHAR_CAP) {
      output = `[...earlier output omitted...]\n${output.slice(output.length - TOOL_OUTPUT_CHAR_CAP)}`
    } else if (result.truncated) {
      output = `[...earlier output omitted: only the last ${Math.round(COMMAND_OUTPUT_CAP_BYTES / 1024)} KB of ${Math.round(result.totalBytes / 1024)} KB are kept...]\n${output}`
    }
    const head: string[] = []
    if (result.timedOut) head.push(`TIMED OUT: the command was killed after ${timeout} s.`)
    head.push(`exit code: ${result.exitCode === null ? 'none (killed)' : result.exitCode}`)
    head.push(`duration: ${seconds(result.durationMs)}`)
    const body = output.trim() === '' ? '(no output)' : output
    const failed = result.timedOut || result.exitCode !== 0
    return {
      text: `${head.join('\n')}\n--- output ---\n${body}`,
      summary: result.timedOut ? `timed out after ${timeout}s` : `exit ${result.exitCode ?? '?'} · ${seconds(result.durationMs)}`,
      detail: result.output,
      exitCode: result.timedOut ? null : result.exitCode,
      // A non-zero exit is information for the model, not a malfunction of the tool; the audit row still records it as failed.
      isError: false,
      failed,
    }
  },
}
