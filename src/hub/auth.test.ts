import { describe, expect, it } from 'vitest'
import { constantTimeEqual } from './auth'

describe('constantTimeEqual', () => {
  it('accepts only an exact match and never throws on a length mismatch', () => {
    expect(constantTimeEqual('admin-secret', 'admin-secret')).toBe(true)
    expect(constantTimeEqual('admin-secreT', 'admin-secret')).toBe(false)
    expect(constantTimeEqual('admin-secret-and-more', 'admin-secret')).toBe(false)
    expect(constantTimeEqual('', 'admin-secret')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })
})
