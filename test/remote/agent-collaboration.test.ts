import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../src/hub'
import { connectRelayHost } from '../../src/main/remote/relay-host'
import { connectRelayClient } from '../../src/main/remote/relay-client'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { handleRelayAgentMessage, handleRelayContextRead } from '../../src/main/remote/agent-collaboration-host'
import { deliverAgentMessage, type DeliveryDeps } from '../../src/core/agents/agent-message'
import { MANAGED_SCRIPT_REVISION } from '../../src/core/agents/hooks/managed-script'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { relayPeerScope } from '../../src/main/peer-registry'
import { IPC } from '../../src/shared/ipc'

type Host = ReturnType<typeof connectRelayHost>
type Client = ReturnType<typeof connectRelayClient>

afterEach(() => resetPlatformForTests())

describe('two-core agent collaboration over the real Hub relay', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')(
    'reads B context, sends A to B, and replies B to A with sender/project checks',
    async () => {
      const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-agent-collab-'))
      const transcriptB = path.join(dataDir, 'b.jsonl')
      await fs.writeFile(transcriptB, JSON.stringify({ type: 'user', message: { content: 'from B' } }))
      const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
      const hosts: Host[] = []
      const clients: Client[] = []
      try {
        const address = await hub.listen()
        const api = `http://127.0.0.1:${address.port}`
        const url = `ws://127.0.0.1:${address.port}/relay`
        initPlatform({
          userDataDir: dataDir, appVersion: 'test', isPackaged: false,
          handle: () => {}, on: () => {}, handleWithSender: () => {}, onWithSender: () => {},
          sendTo: () => {}, broadcast: () => {}, clientIds: () => [], openExternal: async () => {}
        })

        const paneA: string[] = []
        const paneB: string[] = []
        const delivery = (pane: string[]) => async (request: Parameters<typeof deliverAgentMessage>[0]) => {
          let receipt: ((event: { nodeId: string; newTurn: boolean; verified: boolean }) => void) | undefined
          const deps: DeliveryDeps = {
            paneOwner: async () => ({
              tty: '/dev/pts/9', panePid: 100, paneId: '%1', command: 'claude',
              argv: ['claude'], pids: [200]
            }),
            bracketPasteRequested: async () => true,
            sendEnvelope: async (_nodeId, envelope) => { pane.push(envelope); return true },
            mirrorEntry: () => ({
              state: 'done', updatedAt: 1, stateVerified: true,
              clientRevision: MANAGED_SCRIPT_REVISION
            }),
            tokenFilePresent: () => true,
            lock: async (_nodeId, run) => run(),
            now: () => 1,
            trace: async () => ({ traceId: 'relay-test', traced: 'memory' }),
            subscribeEvents: (listener) => {
              receipt = listener
              return () => { receipt = undefined }
            }
          }
          const pending = deliverAgentMessage(request, deps)
          await vi.waitFor(() => expect(receipt).toBeTypeOf('function'))
          receipt?.({ nodeId: request.targetNodeId, newTurn: true, verified: true })
          return pending
        }

        const openDirection = async (opts: {
          sharedProjectId: string
          accountId: string
          memberName: string
          machineLabel: string
          nodeId: string
          transcript?: string
          pane: string[]
        }) => {
          const minted = await fetch(`${api}/v1/pair/token`, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}'
          }).then((response) => response.json()) as { pairingToken: string }
          const hostKeys = genKeyPair()
          const clientKeys = genKeyPair()
          const responses = new Map<number, (value: unknown) => void>()
          let nextId = 1
          let host!: Host
          let client!: Client
          const opened = new Promise<void>((resolve) => {
            const hostDeps = {
              isRelayPeer: () => true,
              peerScope: relayPeerScope,
              nodeInProject: (projectId: string, nodeId: string) =>
                projectId === opts.sharedProjectId && nodeId === opts.nodeId
                  ? { id: nodeId, agentId: 'claude' }
                  : undefined,
              readContext: async () => opts.transcript ? fs.readFile(opts.transcript, 'utf8') : null,
              deliver: async (request: Parameters<typeof deliverAgentMessage>[0] & { remoteOrigin?: { memberName: string; machineLabel: string } }) => ({
                ok: true,
                result: await delivery(opts.pane)({
                  targetNodeId: request.targetNodeId,
                  sourceNodeId: request.sourceNodeId,
                  sourceTitle: request.remoteOrigin?.sourceTitle ?? request.sourceNodeId,
                  body: request.body,
                  targetAgentId: 'claude',
                  targetBinaries: ['claude'],
                  origin: request.remoteOrigin
                })
              })
            }
            const platform = {
              dispatch: async (senderId: number, request: { id: number; method: string; args: unknown[] }) => {
                const result = request.method === IPC.contextLinkRemoteRead
                  ? await handleRelayContextRead(senderId, request.args[0], hostDeps)
                  : request.method === IPC.agentMessageDeliver
                    ? await handleRelayAgentMessage(senderId, request.args[0], hostDeps)
                    : undefined
                return { t: 'res' as const, id: request.id, ok: true as const, result }
              },
              cast: vi.fn()
            }
            host = connectRelayHost({
              url, token: minted.pairingToken, ourKeys: hostKeys, platform: platform as never,
              sharedProjectId: opts.sharedProjectId,
              peerScope: {
                accountId: opts.accountId,
                memberName: opts.memberName,
                machineLabel: opts.machineLabel
              },
              onPeerPending: (session) => session.confirm(), onOpen: resolve, onClose: () => {}
            })
            client = connectRelayClient({
              url, token: minted.pairingToken, hostKeyB64: publicKeyToB64(hostKeys.publicKey),
              ourKeys: clientKeys, onSas: (session) => session.confirm(), onApproved: () => {},
              onFrame: (frame) => {
                const response = JSON.parse(frame) as { t: string; id: number; result: unknown }
                if (response.t === 'res') responses.get(response.id)?.(response.result)
              },
              onPtyData: () => {}, onClose: () => {}
            })
          })
          await opened
          hosts.push(host)
          clients.push(client)
          return {
            request(method: string, arg: unknown): Promise<unknown> {
              const id = nextId++
              return new Promise((resolve) => {
                responses.set(id, resolve)
                expect(client.send(JSON.stringify({ t: 'req', id, method, args: [arg] }))).toBe(true)
              })
            }
          }
        }

        const aToB = await openDirection({
          sharedProjectId: 'project-b', accountId: 'account-a', memberName: 'Sebastián',
          machineLabel: "Sebastián's Mac", nodeId: 'b1', transcript: transcriptB, pane: paneB
        })
        const bToA = await openDirection({
          sharedProjectId: 'project-a', accountId: 'account-b', memberName: 'Jorge',
          machineLabel: "Jorge's PC", nodeId: 'a1', pane: paneA
        })

        await expect(aToB.request(IPC.contextLinkRemoteRead, {
          projectId: 'project-b', nodeId: 'b1', kind: 'transcript'
        })).resolves.toMatchObject({ ok: true, text: expect.stringContaining('from B') })
        await expect(aToB.request(IPC.contextLinkRemoteRead, {
          projectId: 'project-b', nodeId: 'outside', kind: 'transcript'
        })).resolves.toEqual({ ok: false, reason: 'forbidden' })

        await expect(aToB.request(IPC.agentMessageDeliver, {
          verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'review this',
          remoteOrigin: { memberName: 'forged', machineLabel: 'forged', sourceTitle: 'Reviewer' }
        })).resolves.toMatchObject({ ok: true, result: { kind: 'delivered' } })
        expect(paneB[0]).toContain("from: Sebastián's agent 'Reviewer' on Sebastián's Mac")

        await expect(bToA.request(IPC.agentMessageDeliver, {
          verb: 'reply', sourceNodeId: 'b1', targetNodeId: 'a1', body: 'looks good',
          remoteOrigin: { memberName: 'forged', machineLabel: 'forged', sourceTitle: 'Builder' }
        })).resolves.toMatchObject({ ok: true, result: { kind: 'delivered' } })
        expect(paneA[0]).toContain("from: Jorge's agent 'Builder' on Jorge's PC")
      } finally {
        clients.forEach((client) => client.close())
        hosts.forEach((host) => host.close())
        await hub.close()
        await fs.rm(dataDir, { recursive: true, force: true })
      }
    },
    20_000
  )
})
