import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { HubEvent, HubProject, HubStatus, Settings } from '../shared/types'
import { HubClient } from '../core/hub/client'
import type { ElectronPlatform } from './platform-electron'
import { loadOrCreatePeerKeyPair } from './remote/peer-identity'
import { connectRelayHost, type RelayHostSession } from './remote/relay-host'
import { encodeOffer } from './remote/pairing'
import { loadApprovedDevices, saveApprovedDevices } from './remote/approved-devices'
import { pinDevice } from './remote/approved-devices-core'

type SessionRequest = {
  type: 'session-request'
  projectId: string
  fromAccountId: string
  fromPublicKeyB64: string
  pairingToken: string
  relayUrl: string
}

export interface MainHubClient {
  sync(): Promise<HubStatus>
  stop(): void
}

export function initHubClient(
  win: BrowserWindow,
  platform: ElectronPlatform,
  getSettings: () => Settings,
  resolveLocalProjectId: (project: HubProject) => Promise<string | null> = async (project) => project.projectId
): MainHubClient {
  let client: HubClient | null = null
  let configuredUrl = ''
  const hosted = new Set<RelayHostSession>()
  let status: HubStatus = { state: 'disabled' }

  const send = (event: HubEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.hubEvent, event)
  }
  const updateStatus = (next: HubStatus): void => {
    status = next
    send({ type: 'status', status: next })
  }

  async function acceptSessionRequest(event: SessionRequest): Promise<void> {
    if (!client) return
    const projects = await client.listProjects()
    const project = projects.find((item) => item.projectId === event.projectId)
    const member = project?.members?.find((item) => item.accountId === event.fromAccountId)
    if (!project || member?.status !== 'approved' || member.publicKeyB64 !== event.fromPublicKeyB64) {
      console.warn('[hub] refused session request from a non-approved project member')
      return
    }
    const localProjectId = await resolveLocalProjectId(project)
    if (!localProjectId) {
      console.warn('[hub] refused session request because the shared project has no local copy')
      return
    }
    const keys = await loadOrCreatePeerKeyPair()
    let session: RelayHostSession
    session = connectRelayHost({
      url: event.relayUrl,
      token: event.pairingToken,
      ourKeys: keys,
      platform,
      sharedProjectId: localProjectId,
      onPeerPending: (pending) => {
        if (pending.peerKeyB64() !== event.fromPublicKeyB64) {
          console.warn('[hub] refused session request whose tunnel key did not match the directory')
          pending.close()
          return
        }
        void loadApprovedDevices().then((saved) => saveApprovedDevices(pinDevice(saved, event.fromPublicKeyB64)))
        pending.confirm()
      },
      onOpen: () => {},
      onClose: () => hosted.delete(session)
    })
    hosted.add(session)
  }

  async function sync(): Promise<HubStatus> {
    const settings = getSettings()
    const url = settings.hubUrl.trim()
    if (!url) {
      client?.stop()
      client = null
      configuredUrl = ''
      updateStatus({ state: 'disabled' })
      return status
    }
    if (client && configuredUrl === url && status.state === 'connected') return status
    client?.stop()
    configuredUrl = url
    const keys = await loadOrCreatePeerKeyPair()
    client = new HubClient({
      hubUrl: url,
      accountName: settings.hubAccountName,
      keys,
      onStatus: updateStatus,
      onEvent: (event) => {
        send(event)
        if (event.type === 'session-request') {
          void acceptSessionRequest(event as unknown as SessionRequest).catch((error) =>
            console.warn('[hub] session request failed:', error)
          )
        }
      }
    })
    return client.start()
  }

  const needClient = async (): Promise<HubClient> => {
    if (!client || status.state !== 'connected') await sync()
    if (!client || status.state !== 'connected') throw new Error(status.error || 'Hub is not connected')
    return client
  }

  platform.handle(IPC.hubStatus, () => status)
  platform.handle(IPC.hubConnect, () => sync())
  platform.handle(IPC.hubProjectsList, async () => (await needClient()).listProjects())
  platform.handle(IPC.hubProjectsCreate, async (name: unknown, projectId?: unknown) =>
    (await needClient()).createProject(String(name ?? ''), typeof projectId === 'string' ? projectId : undefined)
  )
  platform.handle(IPC.hubProjectsJoin, async (code: unknown) => (await needClient()).joinProject(String(code ?? '')))
  platform.handle(IPC.hubProjectsApprove, async (projectId: unknown, accountId: unknown) => (await needClient()).approveMember(String(projectId), String(accountId)))
  platform.handle(IPC.hubProjectsRemove, async (projectId: unknown, accountId: unknown) => (await needClient()).removeMember(String(projectId), String(accountId)))
  platform.handle(IPC.hubInviteRegenerate, async (projectId: unknown) => (await needClient()).regenerateInvite(String(projectId)))
  platform.handle(IPC.hubProjectsConnect, async (projectId: unknown, toAccountId: unknown) => {
    const hub = await needClient()
    const result = await hub.connectMember(String(projectId), String(toAccountId))
    const keys = await loadOrCreatePeerKeyPair()
    return {
      offer: encodeOffer({ relayEndpoint: result.relayUrl, pairingToken: result.pairingToken, hostPublicKeyB64: result.toPublicKeyB64 }),
      clientPublicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    }
  })

  return {
    sync,
    stop() {
      client?.stop()
      client = null
      for (const session of hosted) session.close()
      hosted.clear()
    }
  }
}
