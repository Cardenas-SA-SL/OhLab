import type { CanvasNode } from '../state/workspace'

/** Move a relay-spawned launch away from xterm input, where terminal DA replies can splice bytes
 * into it, and onto the host RPC's shell-ready paste-buffer delivery queue. */
export function queueRelayInitialCommand(node: CanvasNode, relay: boolean): CanvasNode {
  const command = node.data.initialCommand as string | undefined
  if (!relay || !command) return node
  return { ...node, data: { ...node.data, initialCommand: undefined, pendingLaunch: { after: [], command } } }
}
