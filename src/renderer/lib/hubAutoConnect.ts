/**
 * Mutual auto-connect — the DECISIONS, pure (docs/HUB.md "symmetric sharing").
 *
 * A shared project on the Hub has N members, each running their OWN copy on their own machine.
 * Every member's app opens each other online member's copy as a remote tab, so the owner sees the
 * guest and the guest sees the owner without anyone clicking Open. This module answers "which
 * members should this app connect to right now?" and "how long until the next retry?"; the
 * effectful half (session/hub-auto-connect.ts) owns sockets, tabs and timers and is built on it.
 *
 * Rules, each pinned by a test:
 *  - only APPROVED members, only while ONLINE, and only when BOTH sides have a bound local project
 *    (ours: the binding map; theirs: the `sharing` flag their app published to the Hub);
 *  - never ourselves;
 *  - never a member the user MUTED by closing their tab (`hubMutedMembers`) until they click Open;
 *  - never two tabs for one member+project: a key that is already open or already being dialled is
 *    skipped, whichever side dialled first (each direction is its own host/client pair, so two
 *    members connecting to each other simultaneously is fine — that is two sessions, not a duplicate).
 */
import type { HubProject, HubProjectMember } from '@shared/types'
import { memberTabKey } from '@shared/hub-local-side'

export interface AutoConnectTarget {
  key: string
  hubProjectId: string
  projectName: string
  accountId: string
  memberName: string
  machineLabel: string
  /** The local project bound as OUR side of this shared project. */
  localProjectId: string
  /** The tab's name: "<project> · <member>". */
  label: string
}

export interface AutoConnectInput {
  myAccountId: string | undefined
  hubProjects: readonly HubProject[]
  /** hubProjectId → our local project id (from `resolveLocalSide` over the local projects). */
  bindings: ReadonlyMap<string, string>
  muted: ReadonlySet<string>
  /** Keys with a tab already open (live, connecting, or offline-and-retrying). */
  open: ReadonlySet<string>
  /** Keys being dialled right now. */
  inFlight: ReadonlySet<string>
}

export function memberTabLabel(projectName: string, memberName: string): string {
  return `${projectName} · ${memberName}`
}

/** Is this member a candidate for a tab at all — regardless of what we already hold? */
export function memberConnectable(member: HubProjectMember, myAccountId: string | undefined): boolean {
  return (
    member.accountId !== myAccountId &&
    member.status === 'approved' &&
    member.online === true &&
    member.sharing === true
  )
}

export function autoConnectTargets(input: AutoConnectInput): AutoConnectTarget[] {
  const targets: AutoConnectTarget[] = []
  if (!input.myAccountId) return targets
  for (const project of input.hubProjects) {
    const localProjectId = input.bindings.get(project.projectId)
    if (!localProjectId) continue
    for (const member of project.members ?? []) {
      if (!memberConnectable(member, input.myAccountId)) continue
      const key = memberTabKey(project.projectId, member.accountId)
      if (input.muted.has(key) || input.open.has(key) || input.inFlight.has(key)) continue
      targets.push({
        key,
        hubProjectId: project.projectId,
        projectName: project.name,
        accountId: member.accountId,
        memberName: member.name,
        machineLabel: member.machineLabel || `${member.name}'s computer`,
        localProjectId,
        label: memberTabLabel(project.name, member.name)
      })
    }
  }
  return targets
}

/** Reconnect/retry delays after a drop or a failed dial: bounded, so a member whose app is stuck
 *  is retried on a calm cadence rather than hammered, and never given up on while they are online. */
export const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000] as const

export function reconnectDelayMs(attempt: number): number {
  const index = Math.max(0, Math.min(attempt, RECONNECT_DELAYS_MS.length - 1))
  return RECONNECT_DELAYS_MS[index]
}

/** Should a dropped/failed tab for `key` be retried? Only while the member still qualifies and the
 *  user has not muted them — a member who went offline is greyed and waits for their next
 *  `member-online`, not retried on a timer. */
export function shouldRetry(
  key: string,
  hubProjectId: string,
  accountId: string,
  input: Pick<AutoConnectInput, 'myAccountId' | 'hubProjects' | 'bindings' | 'muted'>
): boolean {
  if (input.muted.has(key) || !input.bindings.has(hubProjectId)) return false
  const project = input.hubProjects.find((candidate) => candidate.projectId === hubProjectId)
  const member = project?.members?.find((candidate) => candidate.accountId === accountId)
  return !!member && memberConnectable(member, input.myAccountId)
}

/** How the Team panel describes a member's canvas: what to show beside their name. */
export type MemberCanvasState = 'self' | 'pending' | 'not-sharing' | 'offline' | 'muted' | 'open' | 'available'

export function memberCanvasState(
  member: HubProjectMember,
  ctx: { myAccountId: string | undefined; muted: boolean; open: boolean }
): MemberCanvasState {
  if (member.accountId === ctx.myAccountId) return 'self'
  if (member.status !== 'approved') return 'pending'
  if (member.sharing !== true) return 'not-sharing'
  if (!member.online) return 'offline'
  if (ctx.open) return 'open'
  if (ctx.muted) return 'muted'
  return 'available'
}
