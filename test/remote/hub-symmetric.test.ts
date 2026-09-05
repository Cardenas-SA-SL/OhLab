/**
 * Symmetric sharing, cross-layer: ONE real Hub, THREE in-process cores (Sebastián, Jorge, Ana).
 *
 * Reuses the Task 2/3 harness (a real `createHub`, real `HubClient`s on its directory socket, the
 * real E2EE `connectRelayHost`/`connectRelayClient` pair over its relay) and drives each member's
 * side the way the app does: main's `acceptSessionRequest` shape hosts on every `session-request`,
 * and the renderer's auto-connect DECISION (`autoConnectTargets`, the pure half of the controller)
 * says whom to dial. What it proves, end to end:
 *   - after approvals every member holds exactly two remote sessions (one per other member) and
 *     hosts exactly two (one per other member) — the symmetric model, brokered by the Hub;
 *   - a member going offline drops the sessions the other two hold with them (their tab greys);
 *   - a muted member is not redialled by the decision layer;
 *   - `list` on member A (the renderer's `relayListRows` over the sessions A holds) includes B's
 *     and C's nodes with their member labels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../src/hub'
import { connectRelayHost } from '../../src/main/remote/relay-host'
import { connectRelayClient } from '../../src/main/remote/relay-client'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { HubClient } from '../../src/core/hub/client'
import { IPC } from '../../src/shared/ipc'
import { memberTabKey, resolveLocalSide } from '../../src/shared/hub-local-side'
import { autoConnectTargets } from '../../src/renderer/lib/hubAutoConnect'
import { relayListRows } from '../../src/renderer/lib/nodeHome'
import type { CanvasNodeState, HubEvent, HubProject, NodeTerminalApi, Project, Workspace } from '../../src/shared/types'
import type { RpcErr, RpcOk } from '../../src/shared/rpc'
import { decodeOffer, encodeHubConnectOffer } from '../../src/main/remote/pairing'
import type { WorkspaceSession } from '../../src/renderer/session/session'

const STEP_MS = 8_000
type Host = ReturnType<typeof connectRelayHost>
type Client = ReturnType<typeof connectRelayClient>

function within<T>(what: string, promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within ${STEP_MS} ms`)), STEP_MS)
    promise.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

const node = (id: string, title: string): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title, color: '#fff', group: null, agentId: 'claude'
})

/** One member: a Hub account, a local project bound as their side, and the sessions they hold. */
interface Member {
  name: string
  machine: string
  keys: ReturnType<typeof genKeyPair>
  client: HubClient
  accountId: string
  events: HubEvent[]
  local: Project
  hosted: Map<string, Host>
  /** The remote sessions this member holds: key → {client, bootstrap} (the renderer's relay tab). */
  held: Map<string, { client: Client; workspace: Workspace; closed: () => boolean; hostAccountId: string; memberName: string; machineLabel: string }>
  muted: Set<string>
}

afterEach(() => resetPlatformForTests())

describe('symmetric sharing across three members over the real Hub', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('every member holds one session per other member; offline greys, muted is not redialled, list carries member labels', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-symmetric-'))
    const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
    const members: Member[] = []
    try {
      const address = await within('the Hub listening', hub.listen())
      const hubUrl = `http://127.0.0.1:${address.port}`
      initPlatform({
        userDataDir: dataDir, appVersion: 'test', isPackaged: false,
        handle: () => {}, on: () => {}, handleWithSender: () => {}, onWithSender: () => {},
        sendTo: () => {}, broadcast: () => {}, clientIds: () => [], openExternal: async () => {}
      })

      const makeMember = async (name: string, machine: string, localId: string, nodes: CanvasNodeState[]): Promise<Member> => {
        const keys = genKeyPair()
        const events: HubEvent[] = []
        const member: Member = {
          name, machine, keys, accountId: '', events,
          local: { id: localId, name: 'Horacio Team', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes },
          hosted: new Map(), held: new Map(), muted: new Set(),
          client: null as unknown as HubClient
        }
        member.client = new HubClient({
          hubUrl, accountName: name, machineLabel: machine, keys,
          onEvent: (event) => {
            events.push(event)
            // main's acceptSessionRequest: host our local side for an approved member's request.
            if (event.type === 'session-request') void host(member, event as never)
          }
        })
        const status = await within(`${name} joining the Hub`, member.client.start())
        expect(status).toMatchObject({ state: 'connected' })
        member.accountId = status.accountId!
        return member
      }

      // Serve `workspace:load` from the member's local project — what the relay host scopes to.
      const platformFor = (member: Member) => ({
        dispatch: async (_id: number, rpc: { id: number; method: string }) => ({
          t: 'res' as const, id: rpc.id, ok: true as const,
          result: rpc.method === IPC.workspaceLoad
            ? ({ version: 2, activeProjectId: member.local.id, projects: [member.local] } satisfies Workspace)
            : null
        }),
        cast: vi.fn()
      })

      async function host(member: Member, request: { projectId: string; fromAccountId: string; fromPublicKeyB64: string; pairingToken: string; relayUrl: string; machineLabel: string }): Promise<void> {
        const projects = await member.client.listProjects()
        const project = projects.find((p) => p.projectId === request.projectId)
        const from = project?.members?.find((m) => m.accountId === request.fromAccountId)
        if (!project || from?.status !== 'approved' || from.publicKeyB64 !== request.fromPublicKeyB64) return
        const localId = resolveLocalSide(project.projectId, [member.local])
        if (!localId) return
        const key = `${project.projectId}:${from.accountId}`
        const session = connectRelayHost({
          url: request.relayUrl, token: request.pairingToken, ourKeys: member.keys, platform: platformFor(member) as never,
          sharedProjectId: localId,
          peerScope: { accountId: from.accountId, memberName: from.name, machineLabel: from.machineLabel || request.machineLabel },
          onPeerPending: (pending) => pending.confirm(),
          onOpen: () => {},
          onClose: () => { if (member.hosted.get(key) === session) member.hosted.delete(key) }
        })
        member.hosted.get(key)?.close()
        member.hosted.set(key, session)
      }

      /** The renderer's auto-connect: decide, then dial each target (connectMember + relay client + bootstrap). */
      async function autoConnect(member: Member): Promise<void> {
        const hubProjects = await member.client.listProjects()
        const bindings = new Map<string, string>()
        for (const shared of hubProjects) {
          const local = resolveLocalSide(shared.projectId, [member.local])
          if (local) bindings.set(shared.projectId, local)
        }
        const targets = autoConnectTargets({
          myAccountId: member.accountId, hubProjects, bindings,
          muted: member.muted, open: new Set(member.held.keys()), inFlight: new Set()
        })
        for (const target of targets) {
          const brokered = await member.client.connectMember(target.hubProjectId, target.accountId)
          const offer = decodeOffer(encodeHubConnectOffer(brokered))!
          let closed = false
          let settle!: { resolve: (ws: Workspace) => void; reject: (e: Error) => void }
          const bootstrap = new Promise<Workspace>((resolve, reject) => { settle = { resolve, reject } })
          const client = connectRelayClient({
            url: offer.relayEndpoint, token: offer.pairingToken, hostKeyB64: offer.hostPublicKeyB64, ourKeys: member.keys,
            onSas: (s) => s.confirm(),
            onApproved: (s) => s.send(JSON.stringify({ t: 'req', id: 1, method: IPC.workspaceLoad, args: [] })),
            onFrame: (frame) => {
              const response = JSON.parse(frame) as RpcOk | RpcErr
              if (response.t !== 'res' || response.id !== 1) return
              if (response.ok) settle.resolve(response.result as Workspace)
              else settle.reject(new Error(`${response.error.code} ${response.error.message}`))
            },
            onPtyData: () => {},
            onClose: () => { closed = true }
          })
          const workspace = await within(`${member.name} bootstrapping ${target.label}`, bootstrap)
          member.held.set(target.key, {
            client, workspace, closed: () => closed,
            hostAccountId: target.accountId, memberName: target.memberName, machineLabel: target.machineLabel
          })
        }
      }

      // Three members, three local sides, each with their own agents.
      const seb = await makeMember('Sebastián', "Sebastián's MacBook", 'seb-local', [node('seb-1', 'Seb reviewer')])
      const jorge = await makeMember('Jorge', "Jorge's PC", 'jorge-local', [node('jorge-1', 'Jorge builder'), node('jorge-2', 'Jorge tester')])
      const ana = await makeMember('Ana', "Ana's laptop", 'ana-local', [node('ana-1', 'Ana designer')])
      members.push(seb, jorge, ana)

      // Owner shares (binding = the legacy id match: the Hub project carries the local id) and
      // publishes the flag; guests join, bind their side (sharing flag) and get approved.
      const shared = await seb.client.createProject('Horacio Team', seb.local.id)
      await seb.client.setSharing(shared.projectId, true)
      for (const guest of [jorge, ana]) {
        await guest.client.joinProject(shared.inviteCode)
        guest.local.hubProjectId = shared.projectId
        await guest.client.setSharing(shared.projectId, true)
      }
      await vi.waitFor(() => expect(seb.events.filter((e) => e.type === 'member-joined')).toHaveLength(2), { timeout: STEP_MS })
      for (const guest of [jorge, ana]) await seb.client.approveMember(shared.projectId, guest.accountId)
      await vi.waitFor(async () => {
        const rows = (await seb.client.listProjects())[0].members!
        expect(rows.filter((m) => m.status === 'approved' && m.online && m.sharing)).toHaveLength(3)
      }, { timeout: STEP_MS })

      // Every member's auto-connect runs (the order does not matter — each direction is its own
      // host/client pair, brokered with its own token).
      for (const member of members) await autoConnect(member)
      await vi.waitFor(() => {
        for (const member of members) {
          expect([...member.held.keys()].sort()).toEqual(
            members.filter((m) => m !== member).map((m) => memberTabKey(shared.projectId, m.accountId)).sort()
          )
          expect(member.hosted.size).toBe(2)
        }
      }, { timeout: STEP_MS })
      // A second evaluation opens nothing new: the keys are already held.
      for (const member of members) await autoConnect(member)
      for (const member of members) expect(member.held.size).toBe(2)

      // Each held session bootstrapped the OTHER member's local side, scoped to that one project.
      for (const member of members) {
        for (const [key, held] of member.held) {
          const other = members.find((m) => memberTabKey(shared.projectId, m.accountId) === key)!
          expect(held.workspace.projects.map((p) => p.id)).toEqual([other.local.id])
          expect(held.workspace.projects[0].nodes.map((n) => n.id)).toEqual(other.local.nodes.map((n) => n.id))
        }
      }

      // `list` on Sebastián: the renderer's rows over the sessions he holds, with member labels.
      const sessionsOf = (member: Member): { projects: Project[]; sessions: Map<string, WorkspaceSession> } => {
        const projects: Project[] = []
        const sessions = new Map<string, WorkspaceSession>()
        for (const [key, held] of member.held) {
          const remote = held.workspace.projects[0]
          const projectId = `tab-${key}`
          projects.push({ ...remote, id: projectId, remote: true })
          sessions.set(projectId, {
            id: `relay-${key}`, source: 'relay', label: key, api: {} as NodeTerminalApi,
            status: held.closed() ? 'offline' : 'connected',
            hostAccountId: held.hostAccountId, memberName: held.memberName, machineLabel: held.machineLabel, hubProjectId: shared.projectId
          })
        }
        return { projects, sessions }
      }
      const sebView = sessionsOf(seb)
      const rows = relayListRows({
        projects: sebView.projects,
        sessionForProject: (id) => sebView.sessions.get(id)!,
        relayNodes: () => [],
        linked: () => false,
        unavailable: () => false
      })
      expect(rows.map((r) => `${r.id} ${r.member} / ${r.machine} ${r.online ? 'online' : 'offline'}`).sort()).toEqual([
        "ana-1 Ana / Ana's laptop online",
        "jorge-1 Jorge / Jorge's PC online",
        "jorge-2 Jorge / Jorge's PC online"
      ])

      // Ana goes offline: her directory socket and her relay sessions drop; the other two see
      // `member-offline` and the sessions they hold with her close (their tab greys).
      ana.client.stop()
      for (const session of ana.hosted.values()) session.close()
      for (const held of ana.held.values()) held.client.close()
      const anaKey = memberTabKey(shared.projectId, ana.accountId)
      await vi.waitFor(() => {
        expect(seb.events.some((e) => e.type === 'member-offline' && e.accountId === ana.accountId)).toBe(true)
        expect(jorge.events.some((e) => e.type === 'member-offline' && e.accountId === ana.accountId)).toBe(true)
        expect(seb.held.get(anaKey)!.closed()).toBe(true)
        expect(jorge.held.get(anaKey)!.closed()).toBe(true)
      }, { timeout: STEP_MS })
      const greyed = sessionsOf(seb)
      expect(greyed.sessions.get(`tab-${anaKey}`)!.status).toBe('offline')
      expect(relayListRows({
        projects: greyed.projects, sessionForProject: (id) => greyed.sessions.get(id)!,
        relayNodes: () => [], linked: () => false, unavailable: () => false
      }).find((r) => r.id === 'ana-1')?.online).toBe(false)
      // …and Sebastián's still-live session with Jorge is untouched.
      expect(seb.held.get(memberTabKey(shared.projectId, jorge.accountId))!.closed()).toBe(false)
      // The decision layer does not redial Ana while she is offline.
      seb.held.delete(anaKey)
      await autoConnect(seb)
      expect(seb.held.has(anaKey)).toBe(false)

      // Jorge muted Sebastián (closed his tab): even with Sebastián online and sharing, no redial.
      const sebKey = memberTabKey(shared.projectId, seb.accountId)
      jorge.held.get(sebKey)!.client.close()
      jorge.held.delete(sebKey)
      jorge.muted.add(sebKey)
      await autoConnect(jorge)
      expect(jorge.held.has(sebKey)).toBe(false)
      // Unmuting (Open in Team) dials again and lands a fresh session.
      jorge.muted.delete(sebKey)
      await autoConnect(jorge)
      expect(jorge.held.has(sebKey)).toBe(true)
      expect(jorge.held.get(sebKey)!.workspace.projects[0].id).toBe(seb.local.id)
    } finally {
      for (const member of members) {
        member.client.stop()
        for (const held of member.held.values()) held.client.close()
        for (const session of member.hosted.values()) session.close()
      }
      await hub.close()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  }, 60_000)
})
