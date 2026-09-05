import { describe, expect, it } from 'vitest'
import type { HubProject } from '@shared/types'
import { canManageHubProject } from './hubTeam'

const project = { projectId: 'p1', ownerAccountId: 'owner' } as HubProject

describe('Hub team project access', () => {
  it('lets only the connected owner manage the invite', () => {
    expect(canManageHubProject(project, { state: 'connected', accountId: 'owner' })).toBe(true)
    expect(canManageHubProject(project, { state: 'connected', accountId: 'guest' })).toBe(false)
    expect(canManageHubProject(project, { state: 'connecting' })).toBe(false)
  })
})
