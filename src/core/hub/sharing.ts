import type { HubProject } from '../../shared/types'

/**
 * Which member rows of the Hub projects this app belongs to must be told about a changed local
 * side (`HubProjectMember.sharing`). Pure so the rule has its own test: publish only when the flag
 * the Hub holds for OUR row disagrees with what this machine resolves — every other call would be
 * a no-op round trip per project per reconnect. A row that is not ours is never touched.
 */
export function sharingUpdates(
  projects: readonly HubProject[],
  myAccountId: string,
  hasLocalSide: (project: HubProject) => boolean
): Array<{ projectId: string; sharing: boolean }> {
  const updates: Array<{ projectId: string; sharing: boolean }> = []
  for (const project of projects) {
    const me = project.members?.find((member) => member.accountId === myAccountId)
    if (!me) continue
    const sharing = hasLocalSide(project)
    if ((me.sharing === true) !== sharing) updates.push({ projectId: project.projectId, sharing })
  }
  return updates
}
