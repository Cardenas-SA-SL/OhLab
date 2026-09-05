/**
 * Which LOCAL project is this machine's side of a Hub shared project.
 *
 * Every member of a shared project runs their OWN copy on their own machine (the canvas rule "a
 * canvas never holds nodes from two machines" stands), so a shared project has N local sides —
 * one per member, each a plain local project bound to the Hub id. The binding is machine-local
 * (`Project.hubProjectId`, riding `IndexEntryV3.hubProjectId`, never the git-shared project file).
 *
 * ONE resolver, asked by every caller — main's session-request acceptance, the sharing flag the
 * app publishes to the Hub, the Team panel's "this project is shared as …" — so the three can
 * never disagree about which canvas a member is shown. Order:
 *
 *  1. the explicit binding (`hubProjectId === sharedProjectId`);
 *  2. the legacy id match: Task 1's "Share this project" created the Hub project WITH the local
 *     project's own id, so an owner who shared before bindings existed still resolves. Local ids
 *     are random (`project-<ts>-<token>`), so a guest can never collide into someone else's id;
 *  3. none — the member has no local side yet (reported to the Hub as `sharing: false`).
 *
 * The NAME match Task 1 fell back to is gone on purpose: two members naming unrelated local
 * projects alike is ordinary, and it silently made one of them host the wrong canvas.
 */
export interface LocalSideCandidate {
  id: string
  hubProjectId?: string
}

export function resolveLocalSide(
  sharedProjectId: string,
  projects: readonly LocalSideCandidate[]
): string | null {
  if (!sharedProjectId) return null
  const bound = projects.find((project) => project.hubProjectId === sharedProjectId)
  if (bound) return bound.id
  const legacy = projects.find((project) => project.id === sharedProjectId && !project.hubProjectId)
  return legacy?.id ?? null
}

/** The stable key for one member's tab in one shared project — what `hubMutedMembers` and the
 *  auto-connect controller's de-duplication are keyed on. */
export function memberTabKey(hubProjectId: string, accountId: string): string {
  return `${hubProjectId}:${accountId}`
}

/** `settings.hubMutedMembers` as a validated set: settings.json is hand-editable, and anything
 *  that is not a `<project>:<account>` string is dropped rather than matched. */
export function mutedMemberKeys(raw: unknown): Set<string> {
  const keys = new Set<string>()
  if (!Array.isArray(raw)) return keys
  for (const item of raw) {
    if (typeof item === 'string' && item.includes(':') && item.length <= 512) keys.add(item)
  }
  return keys
}
