import { describe, expect, it } from 'vitest'
import { AppSettingsSchema, DEFAULT_SETTINGS } from '../settings'
import { CreateWorkspaceInputSchema, UpdateWorkspaceInputSchema } from '../workspace'

describe('CreateWorkspaceInputSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(CreateWorkspaceInputSchema.parse({ name: 'My workspace' })).toEqual({
      name: 'My workspace',
    })
  })

  it('rejects an empty name', () => {
    expect(() => CreateWorkspaceInputSchema.parse({ name: '' })).toThrow()
  })

  it('rejects a missing name', () => {
    expect(() => CreateWorkspaceInputSchema.parse({})).toThrow()
  })
})

describe('UpdateWorkspaceInputSchema', () => {
  it('requires an id but allows partial fields', () => {
    expect(UpdateWorkspaceInputSchema.parse({ id: 'abc' })).toEqual({ id: 'abc' })
  })

  it('rejects a missing id', () => {
    expect(() => UpdateWorkspaceInputSchema.parse({ name: 'x' })).toThrow()
  })
})

describe('AppSettingsSchema', () => {
  it('validates the default settings', () => {
    expect(AppSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS)
  })

  it('rejects an invalid theme', () => {
    expect(() => AppSettingsSchema.parse({ theme: 'neon', activeWorkspaceId: null })).toThrow()
  })
})
