import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../src/hub'
import { connectRelayHost } from '../../src/main/remote/relay-host'
import { connectRelayClient } from '../../src/main/remote/relay-client'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { peerRegistry } from '../../src/main/peer-registry'
import { IPC } from '../../src/shared/ipc'
import { HubClient } from '../../src/core/hub/client'
import type { HubEvent, HubProject, Workspace } from '../../src/shared/types'

describe('real Hub tunnel compatibility', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('bridges the existing E2EE host and client unchanged', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-tunnel-'))
    const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
    try {
      const address = await hub.listen()
      const api = `http://127.0.0.1:${address.port}`
      const url = `ws://127.0.0.1:${address.port}/relay`
      const minted = await fetch(`${api}/v1/pair/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json()) as { pairingToken: string }
      const hostKeys = genKeyPair()
      const clientKeys = genKeyPair()
      const responses: string[] = []
      const binary: Array<{ sessionId: string; data: string }> = []
      const clientClosed = vi.fn()
      let hostSession!: ReturnType<typeof connectRelayHost>
      let clientSession!: ReturnType<typeof connectRelayClient>
      const opened = new Promise<void>((resolve) => {
        const platform = {
          dispatch: async (_id: number, request: { id: number; args: unknown[] }) => ({ t: 'res' as const, id: request.id, ok: true as const, result: request.args[0] }),
          cast: vi.fn()
        }
        initPlatform({
          userDataDir: dataDir, appVersion: 'test', isPackaged: false,
          handle: () => {}, on: () => {}, handleWithSender: () => {}, onWithSender: () => {},
          sendTo: () => {}, broadcast: () => {}, clientIds: () => [], openExternal: async () => {}
        })
        hostSession = connectRelayHost({
          url, token: minted.pairingToken, ourKeys: hostKeys, platform: platform as never,
          onPeerPending: (session) => session.confirm(), onOpen: () => resolve(), onClose: () => {}
        })
        clientSession = connectRelayClient({
          url, token: minted.pairingToken, hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: clientKeys,
          onSas: (session) => session.confirm(), onApproved: () => {}, onFrame: (frame) => responses.push(frame),
          onPtyData: (sessionId, data) => binary.push({ sessionId, data }), onClose: clientClosed
        })
      })
      await opened
      expect(hostSession.sas()).toBe(clientSession.sas())
      expect(clientSession.send(JSON.stringify({ t: 'req', id: 7, method: 'echo', args: ['hello'] }))).toBe(true)
      await vi.waitFor(() => expect(JSON.parse(responses[0])).toMatchObject({ t: 'res', id: 7, ok: true, result: 'hello' }))
      peerRegistry().sendTo(hostSession.clientId()!, IPC.ptyData('s1'), 'binary')
      await vi.waitFor(() => expect(binary).toEqual([{ sessionId: 's1', data: 'binary' }]))
      hostSession.close()
      await vi.waitFor(() => expect(clientClosed).toHaveBeenCalled())
    } finally {
      await hub.close()
      resetPlatformForTests()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('runs share, join, approval, project bootstrap, presence, and removal end to end', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-team-flow-'))
    const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
    const ownerEvents: HubEvent[] = []
    const guestEvents: HubEvent[] = []
    const ownerKeys = genKeyPair()
    const guestKeys = genKeyPair()
    let hostSession: ReturnType<typeof connectRelayHost> | null = null
    let guestSession: ReturnType<typeof connectRelayClient> | null = null
    try {
      const address = await hub.listen()
      const hubUrl = `http://127.0.0.1:${address.port}`
      const owner = new HubClient({
        hubUrl,
        accountName: 'Sebastián',
        machineLabel: "Sebastián's Mac",
        keys: ownerKeys,
        onEvent: (event) => ownerEvents.push(event)
      })
      const guest = new HubClient({
        hubUrl,
        accountName: 'Jorge',
        machineLabel: "Jorge's Mac",
        keys: guestKeys,
        onEvent: (event) => guestEvents.push(event)
      })
      await owner.start()
      await guest.start()

      const shared = await owner.createProject('Brothers', 'owner-project')
      await guest.joinProject(shared.inviteCode)
      await vi.waitFor(() => expect(ownerEvents).toContainEqual(expect.objectContaining({ type: 'member-joined', projectId: shared.projectId })))
      const pending = (await owner.listProjects())[0].members!.find((member) => member.role !== 'owner')!
      await owner.approveMember(shared.projectId, pending.accountId)
      await vi.waitFor(() => expect(guestEvents).toContainEqual(expect.objectContaining({ type: 'member-approved', projectId: shared.projectId })))

      const onlineOnBothSides = async (): Promise<[HubProject, HubProject]> => {
        const ownerProject = (await owner.listProjects())[0]
        const guestProject = (await guest.listProjects())[0]
        return [ownerProject, guestProject]
      }
      await vi.waitFor(async () => {
        const [ownerProject, guestProject] = await onlineOnBothSides()
        expect(ownerProject.members?.find((member) => member.accountId === pending.accountId)).toMatchObject({ online: true, machineLabel: "Jorge's Mac" })
        expect(guestProject.members?.find((member) => member.accountId === pending.accountId)).toMatchObject({ online: true, machineLabel: "Jorge's Mac" })
      })

      const requestPromise = new Promise<Extract<HubEvent, { type: 'session-request' }>>((resolve) => {
        const poll = (): void => {
          const request = ownerEvents.find((event): event is Extract<HubEvent, { type: 'session-request' }> => event.type === 'session-request')
          if (request) resolve(request)
          else setTimeout(poll, 5)
        }
        poll()
      })
      const brokered = await guest.connectMember(shared.projectId, (await owner.listProjects())[0].ownerAccountId, "Jorge's Mac")
      const request = await requestPromise
      expect(request.pairingToken).toBe(brokered.pairingToken)

      const workspace: Workspace = {
        version: 2,
        activeProjectId: shared.projectId,
        projects: [{ id: shared.projectId, name: 'Brothers', nodes: [] } as Workspace['projects'][number]]
      }
      initPlatform({
        userDataDir: dataDir, appVersion: 'test', isPackaged: false,
        handle: () => {}, on: () => {}, handleWithSender: () => {}, onWithSender: () => {},
        sendTo: () => {}, broadcast: () => {}, clientIds: () => [], openExternal: async () => {}
      })
      const platform = {
        dispatch: async (_id: number, rpc: { id: number; method: string }) => ({
          t: 'res' as const,
          id: rpc.id,
          ok: true as const,
          result: rpc.method === IPC.workspaceLoad ? workspace : null
        }),
        cast: vi.fn()
      }
      let bootstrapResolve!: (workspace: Workspace) => void
      const bootstrap = new Promise<Workspace>((resolve) => { bootstrapResolve = resolve })
      const closed = vi.fn()
      const opened = new Promise<void>((resolve) => {
        hostSession = connectRelayHost({
          url: request.relayUrl,
          token: request.pairingToken,
          ourKeys: ownerKeys,
          platform: platform as never,
          sharedProjectId: shared.projectId,
          peerScope: { accountId: pending.accountId, memberName: 'Jorge', machineLabel: "Jorge's Mac" },
          onPeerPending: (session) => session.confirm(),
          onOpen: resolve,
          onClose: () => {}
        })
        guestSession = connectRelayClient({
          url: brokered.relayUrl,
          token: brokered.pairingToken,
          hostKeyB64: brokered.toPublicKeyB64,
          ourKeys: guestKeys,
          onSas: (session) => session.confirm(),
          onApproved: (session) => session.send(JSON.stringify({ t: 'req', id: 1, method: IPC.workspaceLoad, args: [] })),
          onFrame: (frame) => {
            const response = JSON.parse(frame) as { id: number; ok: boolean; result: Workspace }
            if (response.id === 1 && response.ok) bootstrapResolve(response.result)
          },
          onPtyData: () => {},
          onClose: closed
        })
      })
      await opened
      await expect(bootstrap).resolves.toMatchObject({ projects: [{ id: shared.projectId, name: 'Brothers' }] })

      await owner.removeMember(shared.projectId, pending.accountId)
      hostSession.close()
      await vi.waitFor(() => expect(closed).toHaveBeenCalled())
      expect(await guest.listProjects()).toEqual([])
      owner.stop()
      guest.stop()
    } finally {
      guestSession?.close()
      hostSession?.close()
      resetPlatformForTests()
      await hub.close()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  }, 20_000)
})
