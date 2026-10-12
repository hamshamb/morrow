import { WorkspaceFileRepository } from '@ai-workspace/storage'
import { getDatabase } from '../db'
import { CodeFileService } from './file-service'
import { GitService } from './git-service'

/**
 * The one CodeFileService / GitService pair for the process. The code workspace IPC (the user's editor, git view)
 * and the agent's tools both go through these - the agent never has its own path or git logic (ADR-040).
 */
let instances: { resolveRoot: (workspaceId: string) => string | null; files: CodeFileService; git: GitService } | null = null

export function getCodeServices(): NonNullable<typeof instances> {
  if (instances) return instances
  const roots = new WorkspaceFileRepository(getDatabase())
  const resolveRoot = (workspaceId: string): string | null => roots.getRoot(workspaceId)?.rootPath ?? null
  const files = new CodeFileService({ resolveRoot })
  const git = new GitService({ resolveRoot, files })
  instances = { resolveRoot, files, git }
  return instances
}
