import { z } from 'zod'

/**
 * File extensions eligible for content indexing/attachment in V1: plain
 * text, structured data, and common source code. No PDF support yet (no
 * well-maintained permissively-licensed extractor turned up quickly — see
 * DECISIONS.md and BUILD_STATE.md known limitations) and no other binary
 * formats — those are listed but never read into context.
 */
export const SUPPORTED_TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.mdx',
  '.json',
  '.jsonc',
  '.csv',
  '.tsv',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.php',
  '.sh',
  '.bash',
  '.ps1',
  '.sql',
  '.graphql',
  '.proto',
] as const

/**
 * Secrets and repository internals: never indexed, attached, read or written
 * by the code workspace, regardless of `.gitignore` — see ARCHITECTURE.md
 * "Security model". Expressed as `ignore`-package-compatible gitignore
 * patterns (so `.git/` matches at any depth).
 */
export const SENSITIVE_DENY_PATTERNS = [
  '.git/',
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.pfx',
  '*.p12',
  '*.crt',
  '*.cer',
  '*.keystore',
  '*.jks',
  'id_rsa*',
  'id_ed25519*',
  'id_ecdsa*',
  'id_dsa*',
  '*credentials*.json',
  '.aws/',
  '.ssh/',
] as const

/**
 * Noise: dependency folders, build output, OS litter and binaries. Hidden
 * from the index and the file tree, but NOT a security boundary — a tracked
 * file under `build/` that shows up in `git status` can still be opened
 * (the code workspace only refuses `SENSITIVE_DENY_PATTERNS`).
 */
export const NOISE_EXCLUDE_PATTERNS = [
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  'target/',
  'coverage/',
  '.cache/',
  '.DS_Store',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.bin',
  '*.zip',
  '*.tar',
  '*.gz',
  '*.7z',
  '*.rar',
  '*.pdf',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.ico',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.sqlite',
  '*.sqlite3',
  '*.db',
] as const

/**
 * Everything that is never indexed or attached, and never shown in the file
 * tree, regardless of `.gitignore` contents: secrets + noise.
 */
export const DEFAULT_DENY_PATTERNS = [...SENSITIVE_DENY_PATTERNS, ...NOISE_EXCLUDE_PATTERNS] as const

/** Per-file cap on how much content is read into the index/attachment
 * pipeline. Larger files are still listed (metadata only) but their content
 * is not indexed. Character-based, not byte-based, to match the token
 * estimate heuristic used throughout Phase 3 (see DECISIONS.md). */
export const MAX_INDEXED_FILE_CHARS = 200_000

/** Safety cap on how many files a single workspace root indexes in one pass
 * (V1 does a full re-walk on every (re)index — see DECISIONS.md). */
export const MAX_INDEXED_FILES = 5000

export const WorkspaceFileRootSchema = z.object({
  workspaceId: z.string(),
  rootPath: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkspaceFileRoot = z.infer<typeof WorkspaceFileRootSchema>

export const SetWorkspaceFileRootInputSchema = z.object({
  workspaceId: z.string().min(1),
  rootPath: z.string().min(1),
})
export type SetWorkspaceFileRootInput = z.infer<typeof SetWorkspaceFileRootInputSchema>

export const WorkspaceFileIndexEntrySchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  /** Whether this file's content was actually indexed (vs. too large/binary
   * — listed for browsing but not searchable/attachable as full content). */
  contentIndexed: z.boolean(),
  indexedAt: z.number(),
})
export type WorkspaceFileIndexEntry = z.infer<typeof WorkspaceFileIndexEntrySchema>

export const IndexWorkspaceFilesResultSchema = z.object({
  root: WorkspaceFileRootSchema,
  fileCount: z.number(),
  indexedCount: z.number(),
})
export type IndexWorkspaceFilesResult = z.infer<typeof IndexWorkspaceFilesResultSchema>

export const WorkspaceFileSearchInputSchema = z.object({
  workspaceId: z.string().min(1),
  query: z.string().min(1).max(500),
  limit: z.number().int().positive().max(50).optional(),
})
export type WorkspaceFileSearchInput = z.infer<typeof WorkspaceFileSearchInputSchema>

export const WorkspaceFileSearchResultSchema = z.object({
  relativePath: z.string(),
  snippet: z.string(),
  score: z.number(),
})
export type WorkspaceFileSearchResult = z.infer<typeof WorkspaceFileSearchResultSchema>
