import type { HubProject, HubStatus } from '@shared/types'

/** Invite rotation and sharing belong only to the directory account that owns the project. */
export function canManageHubProject(project: HubProject | undefined, status: HubStatus): boolean {
  return project !== undefined && status.state === 'connected' && project.ownerAccountId === status.accountId
}
