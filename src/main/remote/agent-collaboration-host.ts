import type { AgentMessageDeliverRequest } from '../../shared/agents/agent-messaging'
import { isDeliverRequest } from '../../core/agents/agent-messaging'
import type { RelayPeerScope } from '../peer-registry'

export interface RelayContextNode {
  id: string
  agentId?: string
  sessionId?: string
  accountId?: string
}

export interface RelayCollaborationHostDeps {
  isRelayPeer(senderId: number): boolean
  peerScope(senderId: number): RelayPeerScope | undefined
  nodeInProject(projectId: string, nodeId: string): RelayContextNode | undefined
  readContext(
    node: RelayContextNode,
    kind: 'transcript' | 'terminal',
    maxBytes?: number
  ): Promise<string | null>
  deliver(request: AgentMessageDeliverRequest): Promise<unknown>
}

/** Sender-checked host handler for the existing `agent:message-deliver` RPC. */
export async function handleRelayAgentMessage(
  senderId: number,
  raw: unknown,
  deps: RelayCollaborationHostDeps
): Promise<unknown> {
  if (!isDeliverRequest(raw))
    return { ok: false, error: 'malformed agent-message request. Do not retry.' }
  const peer = deps.peerScope(senderId)
  if (deps.isRelayPeer(senderId) && !peer)
    return { ok: false, error: 'notPermitted: relay member has no granted project. Do not retry.' }
  const request: AgentMessageDeliverRequest = peer
    ? {
        ...raw,
        remoteOrigin: {
          memberName: peer.memberName,
          machineLabel: peer.machineLabel,
          sourceTitle: raw.remoteOrigin?.sourceTitle || raw.sourceNodeId,
          hostAccountId: peer.accountId,
          grantedProjectId: peer.sharedProjectId
        }
      }
    : { ...raw, remoteOrigin: undefined }
  return deps.deliver(request)
}

/** Sender-checked host handler for `context-link:remote-read`.
 * The peer supplies no path or command. The host resolves both from its granted project/node. */
export async function handleRelayContextRead(
  senderId: number,
  raw: unknown,
  deps: RelayCollaborationHostDeps
): Promise<{ ok: true; text: string } | { ok: false; reason: 'forbidden' | 'unavailable' }> {
  const peer = deps.peerScope(senderId)
  const req = raw as { projectId?: unknown; nodeId?: unknown; kind?: unknown; maxBytes?: unknown }
  if (
    !peer?.sharedProjectId ||
    req.projectId !== peer.sharedProjectId ||
    typeof req.nodeId !== 'string' ||
    (req.kind !== 'transcript' && req.kind !== 'terminal')
  ) return { ok: false, reason: 'forbidden' }
  const node = deps.nodeInProject(peer.sharedProjectId, req.nodeId)
  if (!node) return { ok: false, reason: 'forbidden' }
  const text = await deps.readContext(
    node,
    req.kind,
    typeof req.maxBytes === 'number' ? req.maxBytes : undefined
  )
  return text == null ? { ok: false, reason: 'unavailable' } : { ok: true, text }
}
