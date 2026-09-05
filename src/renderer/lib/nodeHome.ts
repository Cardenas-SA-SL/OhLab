/**
 * `findNodeHome` — WHERE a node id lives, asked by every agent-facing verb that names one.
 *
 * The desktop holds a node in up to three places and none of them is always current:
 *  1. the serialized store (`useProjects.projects[].nodes`) — every project, but for a RELAY tab it
 *     is refreshed only by the peer-mutation leg while the tab is inactive and by
 *     `commitActiveToStore` when the human switches away, so a node the host adds while the tab is
 *     on screen is not there yet;
 *  2. the live canvas (React Flow's `nodesRef`) — current, but only for the ACTIVE project;
 *  3. every relay session's live node set (`session/relay-nodes.ts`) — seeded from the host's
 *     bootstrap and fed by every `canvas:mut`, whichever tab is active.
 *
 * `send`/`reply`/`notify` used to consult only (1): in the two-instance run a node the host created
 * after the guest opened the tab was missed, `targetSession` stayed undefined, and the delivery fell
 * through to the LOCAL PtyManager, which has no such session (`targetGone`), while `list` — which
 * reads (2) and (3) — was listing that very node as the member's. ONE resolver, consulted in that
 * order, is what stops the verbs from disagreeing about a node. The invariant the test pins: a node
 * that any relay session lists NEVER routes to the local delivery path.
 */
import type { CanvasNodeState, Project } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import type { WorkspaceSession } from '../session/session'

/** The shape every source is normalized to — what the verbs actually read off a target. */
export interface NodeSummary {
  id: string
  kind: string
  title: string
  agentId?: AgentId
  accountId?: string
  /** Auto-tracks the agent's session name while unset/true; false once the user named it. */
  titleAuto?: boolean
}

export interface NodeHome {
  projectId: string
  node: NodeSummary
  session: WorkspaceSession
  /** Which source answered — reported for diagnostics and pinned by tests, never branched on by
   *  a verb (the session is the routing fact, not the source). */
  via: 'store' | 'canvas' | 'relay'
}

export interface NodeHomeDeps {
  projects: readonly Project[]
  activeProjectId: string
  /** The active project's live nodes (React Flow), already summarized. */
  liveNodes: readonly NodeSummary[]
  sessionForProject(projectId: string): WorkspaceSession
  /** Every registered session; only `source === 'relay'` ones are consulted. */
  sessions(): readonly WorkspaceSession[]
  /** A relay session's live node set (`relayNodesOf`). */
  relayNodes(sessionId: string): readonly CanvasNodeState[]
  /** The project tab bound to a relay session (`projectForSession`). */
  projectForSession(sessionId: string): string | undefined
}

export function summarizeNode(node: CanvasNodeState): NodeSummary {
  return {
    id: node.id,
    kind: node.kind ?? 'terminal',
    title: node.title ?? '',
    agentId: node.agentId as AgentId | undefined,
    accountId: node.accountId,
    titleAuto: node.titleAuto
  }
}

export function findNodeHome(nodeId: string, deps: NodeHomeDeps): NodeHome | null {
  if (!nodeId) return null
  for (const project of deps.projects) {
    const node = project.nodes.find((candidate) => candidate.id === nodeId)
    if (node) {
      return { projectId: project.id, node: summarizeNode(node), session: deps.sessionForProject(project.id), via: 'store' }
    }
  }
  if (deps.activeProjectId) {
    const live = deps.liveNodes.find((candidate) => candidate.id === nodeId)
    if (live) {
      return { projectId: deps.activeProjectId, node: live, session: deps.sessionForProject(deps.activeProjectId), via: 'canvas' }
    }
  }
  for (const session of deps.sessions()) {
    if (session.source !== 'relay') continue
    const node = deps.relayNodes(session.id).find((candidate) => candidate.id === nodeId)
    if (!node) continue
    const projectId = deps.projectForSession(session.id)
    if (!projectId) continue
    return { projectId, node: summarizeNode(node), session, via: 'relay' }
  }
  return null
}

/** The delivery route a messaging verb takes for a target. `local` is also the answer for a node
 *  the renderer cannot find at all — main validates against its own store and refuses with a named
 *  reason — but NEVER for a node a relay session lists (see the header). */
export type MessageRoute =
  | { kind: 'relay'; session: WorkspaceSession; online: boolean; projectId: string }
  | { kind: 'local' }

export function messageRouteFor(
  home: NodeHome | null,
  projectUnavailable: (projectId: string) => boolean
): MessageRoute {
  if (!home || home.session.source !== 'relay') return { kind: 'local' }
  return {
    kind: 'relay',
    session: home.session,
    projectId: home.projectId,
    online: home.session.status === 'connected' && !projectUnavailable(home.projectId)
  }
}

/** One `list` row for a node in a member's tab. */
export interface RelayListRow {
  id: string
  kind: string
  title: string
  member: string
  machine: string
  online: boolean
  linked: boolean
}

/**
 * The relay rows `list` appends: the UNION of each relay project's serialized nodes and its
 * session's live set (deduped by id, live wins — it is the fresher of the two), so a node the
 * host added a second ago is listed with the same member label as one that was there at open.
 */
export function relayListRows(
  deps: Pick<NodeHomeDeps, 'projects' | 'sessionForProject' | 'relayNodes'> & {
    linked: (nodeId: string) => boolean
    unavailable: (project: Project) => boolean
  }
): RelayListRow[] {
  const rows: RelayListRow[] = []
  for (const project of deps.projects) {
    const owner = deps.sessionForProject(project.id)
    if (owner.source !== 'relay') continue
    const byId = new Map<string, NodeSummary>()
    for (const node of project.nodes) byId.set(node.id, summarizeNode(node))
    for (const node of deps.relayNodes(owner.id)) byId.set(node.id, summarizeNode(node))
    const online = owner.status === 'connected' && !deps.unavailable(project)
    for (const node of byId.values()) {
      rows.push({
        id: node.id,
        kind: node.kind,
        title: node.title,
        member: owner.memberName ?? owner.label,
        machine: owner.machineLabel ?? owner.label,
        online,
        linked: deps.linked(node.id)
      })
    }
  }
  return rows
}

/**
 * The title a delivered envelope attributes a message to (item 6 of the symmetric-sharing work).
 * A name the user typed (`titleAuto === false`) is theirs and wins; otherwise the agent's own
 * session name (what the CLI reports for the conversation) beats a node title, because the title
 * of an auto-tracking node is whatever first-prompt text the transcript last synced — "ohlab list
 * skill manage-ohlab-canvas" is a prompt, not a name. The id is the last resort, never `''`.
 */
export function preferredSourceTitle(
  node: Pick<NodeSummary, 'id' | 'title' | 'titleAuto'> | undefined,
  sessionName: string | undefined
): string {
  const title = node?.title?.trim() ?? ''
  const session = sessionName?.trim() ?? ''
  if (node?.titleAuto === false && title) return title
  if (session) return session
  if (title) return title
  return node?.id ?? ''
}
