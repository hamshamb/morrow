import { randomBytes } from 'node:crypto'
import { open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AgentFileDiff, ChangedFile, RevertInput, RevertResult } from '@ai-workspace/shared'
import type { AgentRepository, FileSnapshot } from '@ai-workspace/storage'
import { decodeUtf8, sha256 } from '../code/file-service'
import { resolveInRoot } from '../code/path-safety'
import { diffStats } from './unified-diff'

/**
 * The Changes view's backend (ADR-043): what a run changed, the diff of each file, and `[revert file]`.
 * Revert restores the exact pre-run BYTES from the snapshot taken before the agent's first write (a
 * created file is removed again). It only touches a file whose current content still equals the agent's
 * last write - if someone edited it since, it refuses unless the user explicitly forces it. Revert is a
 * user action (a click), not a tool: the model has no way to call it.
 */

export interface AgentChangeDeps {
  repo: AgentRepository
  resolveRoot: (workspaceId: string) => string | null
  isRunActive: (runId: string) => boolean
}

async function writeBytesAtomic(target: string, bytes: Buffer): Promise<void> {
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.revert.tmp`)
  try {
    const handle = await open(tmp, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(tmp, target)
  } catch (err) {
    await unlink(tmp).catch(() => undefined)
    throw err
  }
}

export class AgentChangeService {
  constructor(private readonly deps: AgentChangeDeps) {}

  private rootFor(workspaceId: string): string {
    const root = this.deps.resolveRoot(workspaceId)
    if (!root) throw new Error('This workspace has no folder.')
    return root
  }

  private async currentHash(root: string, path: string): Promise<{ exists: boolean; hash: string | null; text: string | null }> {
    try {
      const resolved = await resolveInRoot(root, path)
      const bytes = await readFile(resolved.absolutePath)
      return { exists: true, hash: sha256(bytes), text: decodeUtf8(bytes)?.replace(/^﻿/, '') ?? null }
    } catch {
      return { exists: false, hash: null, text: null }
    }
  }

  async list(runId: string): Promise<ChangedFile[]> {
    const run = this.deps.repo.getRun(runId)
    if (!run) return []
    const root = this.rootFor(run.workspaceId)
    const out: ChangedFile[] = []
    for (const snap of this.deps.repo.listSnapshots(runId)) {
      const disk = await this.currentHash(root, snap.path)
      const reverted = snap.revertedAt !== null
      const beforeText = snap.beforeContent === null ? '' : (decodeUtf8(snap.beforeContent)?.replace(/^﻿/, '') ?? null)
      let added = 0
      let removed = 0
      if (!reverted && beforeText !== null) {
        const stats = diffStats(beforeText, disk.text ?? '')
        added = stats.added
        removed = stats.removed
      }
      out.push({
        path: snap.path,
        kind: snap.beforeContent === null ? 'created' : 'modified',
        added,
        removed,
        reverted,
        changedSince: !reverted && disk.hash !== snap.afterHash,
      })
    }
    return out
  }

  async fileDiff(runId: string, path: string): Promise<AgentFileDiff> {
    const run = this.deps.repo.getRun(runId)
    const snap = run ? this.deps.repo.getSnapshot(runId, path) : null
    if (!run || !snap) return { status: 'unavailable', path, message: 'This file was not changed by that run.' }
    const root = this.rootFor(run.workspaceId)
    const disk = await this.currentHash(root, path)
    const original = snap.beforeContent === null ? '' : decodeUtf8(snap.beforeContent)
    if (original === null || (disk.exists && disk.text === null)) {
      return { status: 'unavailable', path, message: 'Not valid UTF-8 text: no text diff.' }
    }
    return { status: 'ok', path, original: original.replace(/^﻿/, ''), modified: disk.text ?? '' }
  }

  async revert(input: RevertInput): Promise<RevertResult> {
    const { repo } = this.deps
    const run = repo.getRun(input.runId)
    if (!run) throw new Error('Run not found.')
    if (this.deps.isRunActive(input.runId)) throw new Error('This run is still in progress. Stop it first, then revert.')
    const root = this.rootFor(run.workspaceId)
    let snapshots = repo.listSnapshots(input.runId)
    if (input.path !== undefined) {
      const wanted = input.path.replace(/\\/g, '/')
      snapshots = snapshots.filter((s) => s.path === wanted)
      if (snapshots.length === 0) throw new Error('That file was not changed by this run.')
    } else {
      snapshots = [...snapshots].reverse()
    }
    const result: RevertResult = { reverted: [], skipped: [] }
    for (const snap of snapshots) {
      if (snap.revertedAt !== null) continue
      const outcome = await this.revertOne(root, snap, input.force === true)
      if (outcome === 'reverted') {
        repo.markReverted(snap.id)
        result.reverted.push(snap.path)
      } else {
        result.skipped.push({ path: snap.path, reason: outcome.reason, changedSince: outcome.changedSince })
      }
    }
    return result
  }

  private async revertOne(root: string, snap: FileSnapshot, force: boolean): Promise<'reverted' | { reason: string; changedSince: boolean }> {
    const resolved = await resolveInRoot(root, snap.path)
    const disk = await this.currentHash(root, snap.path)
    const unchangedSinceAgent = disk.hash === snap.afterHash
    if (!unchangedSinceAgent && !force) {
      return {
        reason: disk.exists
          ? 'The file was edited after the agent wrote it, so reverting would discard those newer edits.'
          : 'The file no longer exists.',
        changedSince: true,
      }
    }
    if (snap.beforeContent === null) {
      // The agent created this file: reverting removes it again.
      if (disk.exists) await unlink(resolved.absolutePath)
      return 'reverted'
    }
    await writeBytesAtomic(resolved.absolutePath, snap.beforeContent)
    // Prove the restore: the bytes on disk must be exactly the pre-run bytes.
    const after = await readFile(resolved.absolutePath)
    if (sha256(after) !== sha256(snap.beforeContent)) return { reason: 'The restored file did not match the saved original; check it by hand.', changedSince: false }
    return 'reverted'
  }
}
