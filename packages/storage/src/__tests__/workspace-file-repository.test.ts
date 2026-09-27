import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db'
import { WorkspaceRepository } from '../repositories/workspace-repository'
import { WorkspaceFileRepository, buildFtsQuery } from '../repositories/workspace-file-repository'

describe('WorkspaceFileRepository', () => {
  let db: AppDatabase
  let repo: WorkspaceFileRepository
  let workspaceId: string

  beforeEach(() => {
    db = openDatabase(':memory:')
    workspaceId = new WorkspaceRepository(db).create({ name: 'W' }).id
    repo = new WorkspaceFileRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('root', () => {
    it('returns null when no root is set', () => {
      expect(repo.getRoot(workspaceId)).toBeNull()
    })

    it('sets and updates a root', () => {
      const created = repo.setRoot(workspaceId, 'C:\\repo-a')
      expect(created.rootPath).toBe('C:\\repo-a')
      const updated = repo.setRoot(workspaceId, 'C:\\repo-b')
      expect(updated.rootPath).toBe('C:\\repo-b')
      expect(repo.getRoot(workspaceId)?.rootPath).toBe('C:\\repo-b')
    })

    it('is removed when the owning workspace is deleted', () => {
      repo.setRoot(workspaceId, 'C:\\repo')
      new WorkspaceRepository(db).delete(workspaceId)
      expect(repo.getRoot(workspaceId)).toBeNull()
    })
  })

  describe('replaceIndex / listFiles', () => {
    it('indexes files with content and lists them by path', () => {
      const result = repo.replaceIndex(workspaceId, [
        { relativePath: 'src/index.ts', sizeBytes: 10, mtimeMs: 1, content: 'export const x = 1' },
        { relativePath: 'README.md', sizeBytes: 5, mtimeMs: 1, content: '# Readme' },
        { relativePath: 'logo.png', sizeBytes: 999, mtimeMs: 1, content: null },
      ])
      expect(result).toEqual({ fileCount: 3, indexedCount: 2 })

      const files = repo.listFiles(workspaceId)
      expect(files.map((f) => f.relativePath)).toEqual(['README.md', 'logo.png', 'src/index.ts'])
      expect(files.find((f) => f.relativePath === 'logo.png')?.contentIndexed).toBe(false)
      expect(files.find((f) => f.relativePath === 'README.md')?.contentIndexed).toBe(true)
    })

    it('fully replaces the previous index on re-index', () => {
      repo.replaceIndex(workspaceId, [
        { relativePath: 'old.txt', sizeBytes: 1, mtimeMs: 1, content: 'old' },
      ])
      repo.replaceIndex(workspaceId, [
        { relativePath: 'new.txt', sizeBytes: 1, mtimeMs: 1, content: 'new' },
      ])
      const files = repo.listFiles(workspaceId)
      expect(files.map((f) => f.relativePath)).toEqual(['new.txt'])
    })

    it('scopes files to their own workspace', () => {
      const otherWorkspaceId = new WorkspaceRepository(db).create({ name: 'Other' }).id
      repo.replaceIndex(workspaceId, [{ relativePath: 'a.txt', sizeBytes: 1, mtimeMs: 1, content: 'a' }])
      repo.replaceIndex(otherWorkspaceId, [
        { relativePath: 'b.txt', sizeBytes: 1, mtimeMs: 1, content: 'b' },
      ])
      expect(repo.listFiles(workspaceId).map((f) => f.relativePath)).toEqual(['a.txt'])
      expect(repo.listFiles(otherWorkspaceId).map((f) => f.relativePath)).toEqual(['b.txt'])
    })
  })

  describe('getFileContent', () => {
    it('returns the indexed content for a file', () => {
      repo.replaceIndex(workspaceId, [
        { relativePath: 'a.txt', sizeBytes: 5, mtimeMs: 1, content: 'hello' },
      ])
      expect(repo.getFileContent(workspaceId, 'a.txt')).toBe('hello')
    })

    it('returns null for a file with no indexed content or an unknown path', () => {
      repo.replaceIndex(workspaceId, [{ relativePath: 'bin.exe', sizeBytes: 5, mtimeMs: 1, content: null }])
      expect(repo.getFileContent(workspaceId, 'bin.exe')).toBeNull()
      expect(repo.getFileContent(workspaceId, 'nope.txt')).toBeNull()
    })
  })

  describe('search (FTS5)', () => {
    beforeEach(() => {
      repo.replaceIndex(workspaceId, [
        {
          relativePath: 'src/auth.ts',
          sizeBytes: 40,
          mtimeMs: 1,
          content: 'export function login(user: string) { return authenticate(user) }',
        },
        {
          relativePath: 'src/math.ts',
          sizeBytes: 40,
          mtimeMs: 1,
          content: 'export function add(a: number, b: number) { return a + b }',
        },
        { relativePath: 'notes.txt', sizeBytes: 5, mtimeMs: 1, content: null },
      ])
    })

    it('finds files by keyword match', () => {
      const results = repo.search(workspaceId, 'authenticate')
      expect(results.map((r) => r.relativePath)).toEqual(['src/auth.ts'])
      expect(results[0]?.snippet).toContain('[authenticate]')
    })

    it('returns no results for a query that matches nothing', () => {
      expect(repo.search(workspaceId, 'nonexistentword')).toEqual([])
    })

    it('never matches files that had no content indexed', () => {
      const results = repo.search(workspaceId, 'notes')
      expect(results).toEqual([])
    })

    it('scopes results to the given workspace', () => {
      const otherWorkspaceId = new WorkspaceRepository(db).create({ name: 'Other' }).id
      repo.replaceIndex(otherWorkspaceId, [
        { relativePath: 'other.ts', sizeBytes: 10, mtimeMs: 1, content: 'authenticate here too' },
      ])
      const results = repo.search(workspaceId, 'authenticate')
      expect(results.map((r) => r.relativePath)).toEqual(['src/auth.ts'])
    })

    it('does not throw on punctuation-heavy queries', () => {
      expect(() => repo.search(workspaceId, 'auth(); -- DROP TABLE')).not.toThrow()
    })

    it("'or' mode matches a file containing any one token, unlike the 'and' default", () => {
      // Neither file contains every one of these words, so 'and' mode (the
      // default) finds nothing...
      expect(repo.search(workspaceId, 'authenticate number', 20, 'and')).toEqual([])
      // ...but 'or' mode matches whichever file has at least one of them.
      const results = repo.search(workspaceId, 'authenticate number', 20, 'or')
      expect(results.map((r) => r.relativePath).sort()).toEqual(['src/auth.ts', 'src/math.ts'])
    })
  })

  describe('buildFtsQuery', () => {
    it('quotes each token and ANDs them', () => {
      expect(buildFtsQuery('foo bar')).toBe('"foo" AND "bar"')
    })

    it('strips embedded quotes', () => {
      expect(buildFtsQuery('fo"o')).toBe('"foo"')
    })

    it('returns null for an empty/whitespace-only query', () => {
      expect(buildFtsQuery('   ')).toBeNull()
    })
  })
})
