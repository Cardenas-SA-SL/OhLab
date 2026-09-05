import { describe, expect, it } from 'vitest'
import type { HubProject } from '../../shared/types'
import { sharingUpdates } from './sharing'

const project = (projectId: string, mine: { sharing?: boolean } | null, others: Array<{ sharing?: boolean }> = []): HubProject => ({
  projectId,
  name: projectId,
  ownerAccountId: 'owner',
  inviteCode: 'x',
  createdAt: 1,
  members: [
    ...(mine ? [{ accountId: 'me', name: 'Me', publicKeyB64: 'k', role: 'member' as const, status: 'approved' as const, joinedAt: 1, online: true, ...mine }] : []),
    ...others.map((other, index) => ({ accountId: `other-${index}`, name: 'Other', publicKeyB64: 'k', role: 'member' as const, status: 'approved' as const, joinedAt: 1, online: true, ...other }))
  ]
})

describe('sharingUpdates', () => {
  it('publishes only the rows whose Hub flag disagrees with this machine', () => {
    const projects = [
      project('bound-but-unflagged', { sharing: false }),
      project('bound-and-flagged', { sharing: true }),
      project('unbound-but-flagged', { sharing: true }),
      project('unbound-and-unflagged', {}),
      project('legacy-hub-no-flag', { sharing: undefined })
    ]
    const bound = new Set(['bound-but-unflagged', 'bound-and-flagged', 'legacy-hub-no-flag'])
    expect(sharingUpdates(projects, 'me', (p) => bound.has(p.projectId))).toEqual([
      { projectId: 'bound-but-unflagged', sharing: true },
      { projectId: 'unbound-but-flagged', sharing: false },
      { projectId: 'legacy-hub-no-flag', sharing: true }
    ])
  })

  it('never touches a project this account is not a member of, and reads only OUR row', () => {
    const projects = [project('theirs', null, [{ sharing: false }])]
    expect(sharingUpdates(projects, 'me', () => true)).toEqual([])
  })
})
