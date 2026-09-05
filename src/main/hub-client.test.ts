// The desktop's half of the brokered session flow, driven from the Hub events `initHubClient`
// consumes (security review, findings 3, 4 and 7). The Hub client, the relay host and the Electron
// shell are faked; the relay-URL guard, the member key pins (through their real disk wrapper, in a
// temp userData) and the verify-code memory run for real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HubEvent, HubProject, HubStatus, Settings } from '../shared/types'
import { IPC } from '../shared/ipc'

const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-hub-client-'))
const notifications: Array<{ title: string; body: string }> = []

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  Notification: class {
    static isSupported(): boolean { return true }
    constructor(readonly options: { title: string; body: string }) {}
    on(): void {}
    show(): void { notifications.push(this.options) }
  }
}))
vi.mock('./notifications', () => ({ retainUntilDismissed: () => {} }))

const peerKeys = { publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(32).fill(9) }
vi.mock('./remote/peer-identity', () => ({ loadOrCreatePeerKeyPair: async () => peerKeys }))

let approvedDisk = { pubkeys: [] as string[] }
vi.mock('./remote/approved-devices', () => ({
  loadApprovedDevices: async () => approvedDisk,
  saveApprovedDevices: async (next: { pubkeys: string[] }) => { approvedDisk = next }
}))

interface FakeHostSession {
  opts: ConnectRelayHostOptions
  close: ReturnType<typeof vi.fn>
  confirm: ReturnType<typeof vi.fn>
  sas: () => string | null
  peerKeyB64: () => string | null
  clientId: () => number | null
  sharedProjectId: () => string | undefined
}
const hostSessions: FakeHostSession[] = []
vi.mock('./remote/relay-host', () => ({
  connectRelayHost: vi.fn((opts: ConnectRelayHostOptions) => {
    const session: FakeHostSession = {
      opts,
      close: vi.fn(),
      confirm: vi.fn(),
      sas: () => null,
      peerKeyB64: () => null,
      clientId: () => null,
      sharedProjectId: () => opts.sharedProjectId
    }
    hostSessions.push(session)
    return session
  }),
  killRelayHostsByPeerKey: vi.fn()
}))

let projects: HubProject[] = []
const fakeHub = {
  approveMember: vi.fn(async () => projects[0]),
  removeMember: vi.fn(async () => projects[0]),
  setSharing: vi.fn(async (projectId: string, sharing: boolean) => {
    const project = projects.find((candidate) => candidate.projectId === projectId)!
    project.members = project.members?.map((candidate) => candidate.accountId === 'me' ? { ...candidate, sharing } : candidate)
    return project
  }),
  connectMember: vi.fn(async () => ({ pairingToken: 'tok', relayUrl: 'ws://127.0.0.1:8791/relay', toPublicKeyB64: 'OWNER-KEY' }))
}
let clientOptions: { onStatus?: (status: HubStatus) => void; onEvent?: (event: HubEvent) => void } | null = null
vi.mock('../core/hub/client', () => ({
  HubClient: class {
    constructor(readonly options: { onStatus?: (status: HubStatus) => void; onEvent?: (event: HubEvent) => void }) {
      clientOptions = options
    }
    async start(): Promise<HubStatus> {
      const status: HubStatus = { state: 'connected', accountId: 'me', accountName: 'Me' }
      this.options.onStatus?.(status)
      return status
    }
    stop(): void {}
    async listProjects(): Promise<HubProject[]> { return projects }
    approveMember = fakeHub.approveMember
    removeMember = fakeHub.removeMember
    setSharing = fakeHub.setSharing
    connectMember = fakeHub.connectMember
  }
}))

import type { ConnectRelayHostOptions } from './remote/relay-host'
import { connectRelayHost } from './remote/relay-host'
import { initHubClient } from './hub-client'
import { clearVerifyCodesForTests } from './hub-verify-codes'

const HUB_URL = 'http://127.0.0.1:8791'
const GUEST_KEY = 'GUEST-KEY'

function member(publicKeyB64 = GUEST_KEY): NonNullable<HubProject['members']>[number] {
  return { accountId: 'guest', name: 'Jorge', publicKeyB64, role: 'member', status: 'approved', joinedAt: 1, online: true }
}

function project(projectId: string, members = [member()]): HubProject {
  return { projectId, name: projectId, ownerAccountId: 'me', inviteCode: 'code', createdAt: 1, members }
}

function sessionRequest(overrides: Partial<{ projectId: string; relayUrl: string; fromPublicKeyB64: string }> = {}): HubEvent {
  return {
    type: 'session-request',
    projectId: 'p1',
    fromAccountId: 'guest',
    fromPublicKeyB64: GUEST_KEY,
    pairingToken: 'tok',
    relayUrl: 'ws://127.0.0.1:8791/relay',
    machineLabel: "Jorge's Mac",
    ...overrides
  } as unknown as HubEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

async function boot(
  resolveLocalProjectId: (shared: HubProject) => Promise<string | null> = async (shared) => `local:${shared.projectId}`
): Promise<{ handlers: Record<string, (...args: unknown[]) => unknown>; sent: Array<{ channel: string; event: HubEvent }>; emit: (event: HubEvent) => Promise<void>; stop: () => void }> {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {}
  const sent: Array<{ channel: string; event: HubEvent }> = []
  const win = { isDestroyed: () => false, webContents: { send: (channel: string, event: HubEvent) => sent.push({ channel, event }) } }
  const platform = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => { handlers[channel] = fn } }
  const client = initHubClient(
    win as never,
    platform as never,
    () => ({ hubUrl: HUB_URL, hubAccountName: 'Me' }) as unknown as Settings,
    resolveLocalProjectId
  )
  await client.sync()
  return {
    handlers,
    sent,
    emit: async (event) => {
      clientOptions?.onEvent?.(event)
      await flush()
    },
    stop: () => client.stop()
  }
}

beforeEach(async () => {
  projects = [project('p1'), project('p2')]
  hostSessions.length = 0
  notifications.length = 0
  approvedDisk = { pubkeys: [] }
  fakeHub.setSharing.mockClear()
  clearVerifyCodesForTests()
  vi.mocked(connectRelayHost).mockClear()
  await fs.rm(path.join(userData, 'hub-member-pins.json'), { force: true })
})

afterEach(async () => {
  await fs.rm(userData, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(userData, { recursive: true })
})

describe('initHubClient brokered sessions', () => {
  it('dials only the configured Hub\'s relay, never an address the request carried (finding 4)', async () => {
    const hub = await boot()
    await hub.emit(sessionRequest({ relayUrl: 'ws://evil.example:8791/relay' }))
    await hub.emit(sessionRequest({ relayUrl: 'wss://127.0.0.1:8791/relay' }))
    await hub.emit(sessionRequest({ relayUrl: 'ws://127.0.0.1:8791/relay?x=1' }))
    expect(connectRelayHost).not.toHaveBeenCalled()
    await hub.emit(sessionRequest())
    expect(connectRelayHost).toHaveBeenCalledTimes(1)
    expect(hostSessions[0].opts).toMatchObject({ url: 'ws://127.0.0.1:8791/relay', token: 'tok', sharedProjectId: 'local:p1' })
    hub.stop()
  })

  it('pins a member\'s key on first sight and refuses the same account with another key, loudly (finding 3)', async () => {
    const hub = await boot()
    await hub.emit(sessionRequest())
    expect(connectRelayHost).toHaveBeenCalledTimes(1)
    const pins = JSON.parse(await fs.readFile(path.join(userData, 'hub-member-pins.json'), 'utf8')) as { pins: Array<{ accountId: string; publicKeyB64: string }> }
    expect(pins.pins).toEqual([expect.objectContaining({ accountId: 'guest', publicKeyB64: GUEST_KEY })])

    // The Hub now reports another key for the same account, and the request carries it too.
    projects = [project('p1', [member('SUBSTITUTED-KEY')]), project('p2')]
    await hub.emit(sessionRequest({ fromPublicKeyB64: 'SUBSTITUTED-KEY' }))
    expect(connectRelayHost).toHaveBeenCalledTimes(1)
    const warned = hub.sent.filter((item) => item.event.type === 'status').map((item) => (item.event as { status: HubStatus }).status)
    expect(warned.at(-1)).toMatchObject({ state: 'connected', error: expect.stringMatching(/Jorge's key differs/) })
    expect(notifications).toEqual([expect.objectContaining({ title: 'OhLab refused a Hub session' })])
    // The original key is still the pinned one.
    projects = [project('p1'), project('p2')]
    await hub.emit(sessionRequest())
    expect(connectRelayHost).toHaveBeenCalledTimes(2)
    hub.stop()
  })

  it('refuses a tunnel whose key is not the pinned directory key, and remembers the SAS as the member\'s verify code', async () => {
    const hub = await boot()
    await hub.emit(sessionRequest())
    const session = hostSessions[0]
    const pending = { peerKeyB64: () => 'MITM-KEY', sas: () => '111 111', confirm: vi.fn(), close: vi.fn() }
    session.opts.onPeerPending(pending as never)
    expect(pending.close).toHaveBeenCalled()
    expect(pending.confirm).not.toHaveBeenCalled()

    const genuine = { peerKeyB64: () => GUEST_KEY, sas: () => '123 456', confirm: vi.fn(), close: vi.fn() }
    session.opts.onPeerPending(genuine as never)
    expect(genuine.confirm).toHaveBeenCalled()
    await flush()
    expect(approvedDisk.pubkeys).toEqual([GUEST_KEY])
    const status = await hub.handlers[IPC.hubStatus]() as HubStatus
    expect(status.verifyCodes).toEqual({ [GUEST_KEY]: '123 456' })
    const pushed = hub.sent.filter((item) => item.event.type === 'status').map((item) => (item.event as { status: HubStatus }).status)
    expect(pushed.at(-1)?.verifyCodes).toEqual({ [GUEST_KEY]: '123 456' })
    hub.stop()
  })

  it('keys hosted sessions by member AND project, and a superseded session\'s drop never orphans its successor (finding 7)', async () => {
    const hub = await boot()
    await hub.emit(sessionRequest({ projectId: 'p1' }))
    await hub.emit(sessionRequest({ projectId: 'p2' }))
    const [firstP1, firstP2] = hostSessions
    // Same member, other project: nothing is replaced.
    expect(firstP1.close).not.toHaveBeenCalled()
    expect(firstP2.close).not.toHaveBeenCalled()
    // Same member, same project: the earlier session for THAT project is replaced.
    await hub.emit(sessionRequest({ projectId: 'p1' }))
    const secondP1 = hostSessions[2]
    expect(firstP1.close).toHaveBeenCalledTimes(1)
    expect(firstP2.close).not.toHaveBeenCalled()
    // The superseded session's wire drop lands late: the live successor stays tracked...
    firstP1.opts.onClose()
    hub.stop()
    // ...so stop() still closes it, and the untouched p2 session with it.
    expect(secondP1.close).toHaveBeenCalledTimes(1)
    expect(firstP2.close).toHaveBeenCalledTimes(1)
  })

  it('refuses to approve a member whose account already carries a different pinned key', async () => {
    const hub = await boot()
    await hub.emit(sessionRequest())
    projects = [project('p1', [{ ...member('SUBSTITUTED-KEY'), status: 'pending' }])]
    await expect(hub.handlers[IPC.hubProjectsApprove]('p1', 'guest')).rejects.toThrow(/Jorge's key differs/)
    expect(fakeHub.approveMember).not.toHaveBeenCalled()
    hub.stop()
  })

  it('on the guest side dials only the Hub\'s relay and only the pinned key, and forgets a removed member\'s pin', async () => {
    const hub = await boot()
    projects = [project('p1', [{ ...member('OWNER-KEY'), accountId: 'owner', name: 'Sebastián', role: 'owner' }])]
    const first = await hub.handlers[IPC.hubProjectsConnect]('p1', 'owner', 'My Mac') as { offer: string }
    expect(first.offer).toMatch(/^nodeterm:\/\/pair\?code=/)

    fakeHub.connectMember.mockResolvedValueOnce({ pairingToken: 'tok', relayUrl: 'ws://evil.example:8791/relay', toPublicKeyB64: 'OWNER-KEY' })
    await expect(hub.handlers[IPC.hubProjectsConnect]('p1', 'owner')).rejects.toThrow(/outside its own address/)

    fakeHub.connectMember.mockResolvedValueOnce({ pairingToken: 'tok', relayUrl: 'ws://127.0.0.1:8791/relay', toPublicKeyB64: 'SUBSTITUTED-KEY' })
    await expect(hub.handlers[IPC.hubProjectsConnect]('p1', 'owner')).rejects.toThrow(/Sebastián's key differs/)

    // Removing the member forgets the pin, so a re-invite with a fresh identity starts clean.
    await hub.handlers[IPC.hubProjectsRemove]('p1', 'owner')
    fakeHub.connectMember.mockResolvedValueOnce({ pairingToken: 'tok', relayUrl: 'ws://127.0.0.1:8791/relay', toPublicKeyB64: 'SUBSTITUTED-KEY' })
    await expect(hub.handlers[IPC.hubProjectsConnect]('p1', 'owner')).resolves.toMatchObject({ offer: expect.any(String) })
    hub.stop()
  })

  it('rebinding one local canvas stops advertising an accidental second Hub project', async () => {
    const me = (sharing: boolean) => ({
      accountId: 'me', name: 'Me', publicKeyB64: 'ME-KEY', role: 'member' as const,
      status: 'approved' as const, joinedAt: 1, online: true, sharing
    })
    projects = [
      { ...project('intended', [me(false)]), ownerAccountId: 'owner' },
      { ...project('accidental', [me(true)]), ownerAccountId: 'me' }
    ]
    const hub = await boot(async () => 'same-local-canvas')
    await flush()
    fakeHub.setSharing.mockClear()

    await hub.handlers[IPC.hubProjectsBind]('intended', 'same-local-canvas')

    expect(fakeHub.setSharing.mock.calls).toEqual([['accidental', false]])
    expect(projects.find((project) => project.projectId === 'intended')?.members?.[0].sharing).toBe(true)
    hub.stop()
  })
})
