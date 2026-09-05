import { describe, expect, it } from 'vitest'
import { memberTabKey, mutedMemberKeys, resolveLocalSide } from './hub-local-side'

describe('resolveLocalSide', () => {
  it('prefers the explicit binding over everything else', () => {
    const projects = [
      { id: 'hub-1' }, // legacy id match candidate
      { id: 'project-a', hubProjectId: 'hub-1' }
    ]
    expect(resolveLocalSide('hub-1', projects)).toBe('project-a')
  })

  it('falls back to the legacy id match for a project shared before bindings existed', () => {
    expect(resolveLocalSide('project-x', [{ id: 'project-x' }, { id: 'project-y' }])).toBe('project-x')
  })

  it('answers none when nothing is bound and nothing matches', () => {
    expect(resolveLocalSide('hub-2', [{ id: 'project-a', hubProjectId: 'hub-1' }])).toBeNull()
    expect(resolveLocalSide('', [{ id: '' }])).toBeNull()
  })

  // The name match Task 1 used is gone: two members' unrelated projects named alike must never
  // make one of them host the other's canvas.
  it('never matches by name', () => {
    const projects = [{ id: 'project-a', name: 'Brothers' } as { id: string; name: string }]
    expect(resolveLocalSide('Brothers', projects)).toBeNull()
  })

  it('a project bound to another shared project is not a legacy match for its own id', () => {
    expect(resolveLocalSide('project-a', [{ id: 'project-a', hubProjectId: 'hub-9' }])).toBeNull()
  })
})

describe('member tab keys', () => {
  it('composes and validates the mute keys', () => {
    expect(memberTabKey('hub-1', 'acct-2')).toBe('hub-1:acct-2')
    expect([...mutedMemberKeys(['hub-1:acct-2', 42, 'nocolon', null])]).toEqual(['hub-1:acct-2'])
    expect(mutedMemberKeys('hub-1:acct-2').size).toBe(0)
    expect(mutedMemberKeys(undefined).size).toBe(0)
  })
})
