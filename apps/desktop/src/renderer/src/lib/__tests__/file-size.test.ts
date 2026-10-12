import { describe, expect, it } from 'vitest'
import { formatFileSize } from '../file-size'

describe('formatFileSize', () => {
  it('shows bytes, kB and MB without rounding small files to zero', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(8)).toBe('8 B')
    expect(formatFileSize(1023)).toBe('1023 B')
    expect(formatFileSize(1840)).toBe('1.8 kB')
    expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})
