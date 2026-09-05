// The LIVE node set of every relay session — the third leg of `findNodeHome` (lib/nodeHome.ts).
//
// A relay tab's nodes live in three places, and none of the first two is always current:
//   - the serialized store (`useProjects.projects[].nodes`): refreshed by the peer-mutation leg in
//     relay-tab.ts while the tab is INACTIVE, and by `commitActiveToStore` when the human switches
//     AWAY from it — so while the tab is active, a node the host adds is not in the store until
//     the next switch;
//   - React Flow (`nodesRef` in Canvas): current, but only for the ACTIVE project.
// The `send --node <remote>` bug in the two-instance run fell through that seam: the store lookup
// missed a node the host created after the tab opened, `targetSession` stayed undefined, and the
// delivery went to the LOCAL PtyManager, which has no such session (`targetGone`).
//
// This set is fed from the SAME `canvas:mut` stream the other two are, applied regardless of which
// tab is active, and seeded from the host's `workspace:load` at open — so it is current whenever
// the relay socket is, and it is what makes "any relay session lists this node" answerable without
// a canvas at either end. Runtime-only, never persisted; cleared with the session.
import type { CanvasMutation, CanvasNodeState } from '@shared/types'
import { applyCanvasMutation } from '@shared/canvas-mutations'

const NODES = new Map<string, Map<string, CanvasNodeState>>()

/** Replace a session's live set with the host's current nodes (open / reconnect bootstrap). */
export function seedRelayNodes(sessionId: string, nodes: readonly CanvasNodeState[]): void {
  NODES.set(sessionId, new Map(nodes.map((node) => [node.id, node])))
}

/** Apply one peer mutation to a session's live set. A mutation for a session that was never
 *  seeded still creates the set — a host may cast before the bootstrap resolves. */
export function applyRelayNodeMutation(sessionId: string, mutation: CanvasMutation): void {
  const current = NODES.get(sessionId) ?? new Map<string, CanvasNodeState>()
  const next = applyCanvasMutation([...current.values()], mutation)
  NODES.set(sessionId, new Map(next.map((node) => [node.id, node])))
}

/** The session's live nodes (empty for an unknown session — never undefined, so a caller can
 *  always iterate). */
export function relayNodesOf(sessionId: string): CanvasNodeState[] {
  return [...(NODES.get(sessionId)?.values() ?? [])]
}

/** One node from a session's live set, or undefined. */
export function relayNode(sessionId: string, nodeId: string): CanvasNodeState | undefined {
  return NODES.get(sessionId)?.get(nodeId)
}

export function clearRelayNodes(sessionId: string): void {
  NODES.delete(sessionId)
}

/** Test seam. */
export function resetRelayNodesForTest(): void {
  NODES.clear()
}
