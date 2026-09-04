import { describe, expect, it, vi } from 'vitest'
import {
  handleRelayAgentMessage,
  handleRelayContextRead,
  type RelayCollaborationHostDeps
} from './agent-collaboration-host'

function deps(over: Partial<RelayCollaborationHostDeps> = {}): RelayCollaborationHostDeps {
  return {
    isRelayPeer: (id) => id >= 7,
    peerScope: (id) => id === 7
      ? {
          sharedProjectId: 'granted',
          accountId: 'acct-a',
          memberName: 'Sebastián',
          machineLabel: "Sebastián's Mac"
        }
      : undefined,
    nodeInProject: (projectId, nodeId) =>
      projectId === 'granted' && nodeId === 'b1' ? { id: 'b1', agentId: 'claude' } : undefined,
    readContext: async () => 'remote transcript',
    deliver: async (request) => ({ ok: true, request }),
    ...over
  }
}

describe('relay collaboration host boundary', () => {
  it('resolves transcript and terminal on the host only for the sender-granted project/node', async () => {
    const readContext = vi.fn(async () => 'remote transcript')
    const d = deps({ readContext })
    await expect(handleRelayContextRead(7, {
      projectId: 'granted', nodeId: 'b1', kind: 'transcript', maxBytes: 42
    }, d)).resolves.toEqual({ ok: true, text: 'remote transcript' })
    expect(readContext).toHaveBeenCalledWith({ id: 'b1', agentId: 'claude' }, 'transcript', 42)

    await expect(handleRelayContextRead(7, {
      projectId: 'other', nodeId: 'b1', kind: 'transcript'
    }, d)).resolves.toEqual({ ok: false, reason: 'forbidden' })
    await expect(handleRelayContextRead(7, {
      projectId: 'granted', nodeId: 'outside', kind: 'terminal'
    }, d)).resolves.toEqual({ ok: false, reason: 'forbidden' })
    await expect(handleRelayContextRead(99, {
      projectId: 'granted', nodeId: 'b1', kind: 'transcript'
    }, d)).resolves.toEqual({ ok: false, reason: 'forbidden' })
    expect(readContext).toHaveBeenCalledTimes(1)
  })

  it('overwrites relay attribution and grant facts from the authenticated sender', async () => {
    const deliver = vi.fn(async () => ({ ok: true }))
    await handleRelayAgentMessage(7, {
      verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hello',
      remoteOrigin: {
        memberName: 'forged', machineLabel: 'forged', sourceTitle: 'Reviewer',
        hostAccountId: 'forged', grantedProjectId: 'other'
      }
    }, deps({ deliver }))
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      remoteOrigin: {
        memberName: 'Sebastián',
        machineLabel: "Sebastián's Mac",
        sourceTitle: 'Reviewer',
        hostAccountId: 'acct-a',
        grantedProjectId: 'granted'
      }
    }))

    await expect(handleRelayAgentMessage(8, {
      verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hello'
    }, deps({ deliver }))).resolves.toMatchObject({ ok: false, error: expect.stringContaining('notPermitted') })
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
