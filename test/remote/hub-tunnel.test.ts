import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../src/hub'
import { connectRelayHost, killRelayHostsByPeerKey } from '../../src/main/remote/relay-host'
import { connectRelayClient } from '../../src/main/remote/relay-client'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { peerRegistry } from '../../src/main/peer-registry'
import { IPC } from '../../src/shared/ipc'
import { HubClient } from '../../src/core/hub/client'
import type { HubEvent, Workspace } from '../../src/shared/types'
import type { RpcErr, RpcOk } from '../../src/shared/rpc'
import { decodeOffer, encodeHubConnectOffer } from '../../src/main/remote/pairing'

/** Every step of the team flow is a network round trip; bound each one and name it, so a stuck
 *  step fails as itself instead of as the test's anonymous 30 s timeout. */
const STEP_MS = 5_000

function within<T>(what: string, ms: number, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) }
    )
  })
}

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
    let owner: HubClient | null = null
    let guest: HubClient | null = null
    let hostSession: ReturnType<typeof connectRelayHost> | null = null
    let guestSession: ReturnType<typeof connectRelayClient> | null = null
    try {
      const address = await within('the Hub listening', STEP_MS, hub.listen())
      const hubUrl = `http://127.0.0.1:${address.port}`
      owner = new HubClient({
        hubUrl,
        accountName: 'Sebastián',
        machineLabel: "Sebastián's Mac",
        keys: ownerKeys,
        onEvent: (event) => ownerEvents.push(event)
      })
      guest = new HubClient({
        hubUrl,
        accountName: 'Jorge',
        machineLabel: "Jorge's Mac",
        keys: guestKeys,
        onEvent: (event) => guestEvents.push(event)
      })
      expect(await within('the owner joining the Hub', STEP_MS, owner.start())).toMatchObject({ state: 'connected' })
      expect(await within('the guest joining the Hub', STEP_MS, guest.start())).toMatchObject({ state: 'connected' })

      // Share, join with the invite code, approve.
      const shared = await owner.createProject('Brothers', 'owner-project')
      await guest.joinProject(shared.inviteCode)
      await vi.waitFor(() => expect(ownerEvents).toContainEqual(expect.objectContaining({ type: 'member-joined', projectId: shared.projectId })), { timeout: STEP_MS })
      const pending = (await owner.listProjects())[0].members!.find((member) => member.role !== 'owner')!
      await owner.approveMember(shared.projectId, pending.accountId)
      await vi.waitFor(() => expect(guestEvents).toContainEqual(expect.objectContaining({ type: 'member-approved', projectId: shared.projectId })), { timeout: STEP_MS })

      // Presence: the guest reads as online, with its machine label, on both sides.
      await vi.waitFor(async () => {
        const [ownerProject, guestProject] = await Promise.all([owner!.listProjects(), guest!.listProjects()])
        expect(ownerProject[0].members?.find((member) => member.accountId === pending.accountId)).toMatchObject({ online: true, machineLabel: "Jorge's Mac" })
        expect(guestProject[0].members?.find((member) => member.accountId === pending.accountId)).toMatchObject({ online: true, machineLabel: "Jorge's Mac" })
      }, { timeout: STEP_MS })

      // The guest asks for a session; the Hub brokers it and pushes the request to the owner.
      const brokered = await guest.connectMember(shared.projectId, (await owner.listProjects())[0].ownerAccountId, "Jorge's Mac")
      await vi.waitFor(() => expect(ownerEvents.some((event) => event.type === 'session-request')).toBe(true), { timeout: STEP_MS })
      const request = ownerEvents.find((event): event is Extract<HubEvent, { type: 'session-request' }> => event.type === 'session-request')!
      expect(request.pairingToken).toBe(brokered.pairingToken)
      const offer = encodeHubConnectOffer(brokered)
      const decoded = decodeOffer(offer)
      expect(decoded).toEqual({
        relayEndpoint: brokered.relayUrl,
        pairingToken: brokered.pairingToken,
        hostPublicKeyB64: brokered.toPublicKeyB64
      })

      // The owner auto-hosts (what acceptSessionRequest does), the guest dials the decoded offer,
      // and its first request over the tunnel is the project bootstrap.
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
      let settleBootstrap!: { resolve: (workspace: Workspace) => void; reject: (error: Error) => void }
      const bootstrap = new Promise<Workspace>((resolve, reject) => { settleBootstrap = { resolve, reject } })
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
          url: decoded!.relayEndpoint,
          token: decoded!.pairingToken,
          hostKeyB64: decoded!.hostPublicKeyB64,
          ourKeys: guestKeys,
          onSas: (session) => session.confirm(),
          onApproved: (session) => session.send(JSON.stringify({ t: 'req', id: 1, method: IPC.workspaceLoad, args: [] })),
          onFrame: (frame) => {
            const response = JSON.parse(frame) as RpcOk | RpcErr
            if (response.t !== 'res' || response.id !== 1) return
            if (response.ok) settleBootstrap.resolve(response.result as Workspace)
            else settleBootstrap.reject(new Error(`the host refused workspace:load over the relay: ${response.error.code} ${response.error.message}`))
          },
          onPtyData: () => {},
          onClose: closed
        })
      })
      await within('the owner opening the hosted session', STEP_MS, opened)
      await expect(within('the guest receiving its project bootstrap', STEP_MS, bootstrap)).resolves.toMatchObject({ projects: [{ id: shared.projectId, name: 'Brothers' }] })
      expect(hostSession!.clientId()).not.toBeNull()

      // Removal: the owner drops the member; the desktop's revoker then cuts every live session
      // with that peer key (hub-client's memberRevoker onRevoke), and the guest's session closes.
      await owner.removeMember(shared.projectId, pending.accountId)
      killRelayHostsByPeerKey(publicKeyToB64(guestKeys.publicKey))
      await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: STEP_MS })
      expect(hostSession!.clientId()).toBeNull()
      expect(await guest.listProjects()).toEqual([])
    } finally {
      owner?.stop()
      guest?.stop()
      guestSession?.close()
      hostSession?.close()
      resetPlatformForTests()
      await hub.close()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
