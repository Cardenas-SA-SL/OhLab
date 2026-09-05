import { Notification, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { HubEvent, HubProject, HubStatus, Settings } from '../shared/types'
import { HubClient } from '../core/hub/client'
import { sharingUpdates } from '../core/hub/sharing'
import type { ElectronPlatform } from './platform-electron'
import { loadOrCreatePeerKeyPair } from './remote/peer-identity'
import { connectRelayHost, killRelayHostsByPeerKey, type RelayHostSession } from './remote/relay-host'
import { encodeHubConnectOffer } from './remote/pairing'
import { loadApprovedDevices, saveApprovedDevices } from './remote/approved-devices'
import { pinDevice } from './remote/approved-devices-core'
import { hostname, userInfo } from 'node:os'
import { retainUntilDismissed } from './notifications'
import { createRevoker } from './remote/revocation'

type SessionRequest = {
  type: 'session-request'
  projectId: string
  fromAccountId: string
  fromPublicKeyB64: string
  pairingToken: string
  relayUrl: string
  machineLabel?: string
}

export interface MainHubClient {
  sync(): Promise<HubStatus>
  stop(): void
}

function localUserName(): string {
  try {
    return userInfo().username.trim()
  } catch {
    return ''
  }
}

export function initHubClient(
  win: BrowserWindow,
  platform: ElectronPlatform,
  getSettings: () => Settings,
  resolveLocalProjectId: (project: HubProject) => Promise<string | null> = async (project) => project.projectId
): MainHubClient {
  let client: HubClient | null = null
  let configuredUrl = ''
  let configuredAccountName = ''
  let syncTail: Promise<HubStatus> = Promise.resolve({ state: 'disabled' })
  const hosted = new Map<string, RelayHostSession>()
  // The renderer's word on which local project is this machine's side of a shared project,
  // consulted BEFORE the on-disk workspace: the renderer persists the binding through its
  // debounced workspace save, and a member's session request (or the sharing flag we publish) must
  // not depend on that save having landed. `null` is an explicit unbind. Cleared on `stop()`.
  const bindings = new Map<string, string | null>()
  const machineLabel = hostname()
  const memberRevoker = createRevoker({
    load: loadApprovedDevices,
    save: saveApprovedDevices,
    onRevoke: (publicKey) => killRelayHostsByPeerKey(publicKey)
  })
  let status: HubStatus = { state: 'disabled' }

  const send = (event: HubEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.hubEvent, event)
  }
  const updateStatus = (next: HubStatus): void => {
    status = next.state === 'connected' ? { ...next, machineLabel } : next
    send({ type: 'status', status })
  }

  /** The local side of a shared project: the renderer's live binding first, then the workspace on
   *  disk (`resolveLocalSide` in index.ts — bound id, then the legacy id match). */
  const localSideOf = async (project: HubProject): Promise<string | null> => {
    if (bindings.has(project.projectId)) return bindings.get(project.projectId) ?? null
    return resolveLocalProjectId(project)
  }

  /** Tell the Hub which of our member rows have a local side, so the other members' auto-connect
   *  knows whether there is a canvas to open. Best effort — a failed publish is retried on the next
   *  sync/bind, and a wrong flag only delays an auto-connect; it never grants anything. */
  async function publishSharing(onlyProjectId?: string): Promise<void> {
    if (!client || status.state !== 'connected' || !status.accountId) return
    const hub = client
    const projects = (await hub.listProjects()).filter((project) => !onlyProjectId || project.projectId === onlyProjectId)
    const sides = new Map<string, boolean>()
    for (const project of projects) sides.set(project.projectId, !!(await localSideOf(project)))
    for (const update of sharingUpdates(projects, status.accountId, (project) => sides.get(project.projectId) === true)) {
      await hub.setSharing(update.projectId, update.sharing).catch((error) =>
        console.warn('[hub] could not publish the sharing flag:', error)
      )
    }
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
    const localProjectId = await localSideOf(project)
    if (!localProjectId) {
      console.warn('[hub] refused session request because the shared project has no local copy')
      return
    }
    const keys = await loadOrCreatePeerKeyPair()
    const hostedKey = `${project.projectId}:${member.accountId}`
    let session: RelayHostSession
    session = connectRelayHost({
      url: event.relayUrl,
      token: event.pairingToken,
      ourKeys: keys,
      platform,
      sharedProjectId: localProjectId,
      // The label other members' agents are attributed to is the one the member REGISTERED with
      // the Hub (its hostname) — the directory row is the authority. The request's label is the
      // Hub's own fallback for a member that registered none; it is never a renderer's "this Mac".
      peerScope: {
        accountId: member.accountId,
        memberName: member.name,
        machineLabel: member.machineLabel || event.machineLabel || `${member.name}'s computer`
      },
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
      onClose: () => { if (hosted.get(hostedKey) === session) hosted.delete(hostedKey) }
    })
    // One hosting session per member PER shared project: a member in two projects with us holds
    // two, and a re-dial for one project must not cut the other. A re-dial for the same pair
    // replaces the stale session (the guest's old socket is dead or about to be).
    hosted.get(hostedKey)?.close()
    hosted.set(hostedKey, session)
  }

  async function syncNow(): Promise<HubStatus> {
    const settings = getSettings()
    const url = settings.hubUrl.trim()
    const accountName = settings.hubAccountName.trim() || localUserName()
    if (!url) {
      client?.stop()
      client = null
      configuredUrl = ''
      configuredAccountName = ''
      updateStatus({ state: 'disabled' })
      return status
    }
    if (!accountName) {
      client?.stop()
      client = null
      configuredUrl = ''
      configuredAccountName = ''
      updateStatus({ state: 'error', error: 'Enter an account name before connecting to the Hub.' })
      return status
    }
    if (client && configuredUrl === url && configuredAccountName === accountName && status.state === 'connected') return status
    client?.stop()
    configuredUrl = url
    configuredAccountName = accountName
    const keys = await loadOrCreatePeerKeyPair()
    client = new HubClient({
      hubUrl: url,
      accountName,
      machineLabel,
      keys,
      onStatus: updateStatus,
      onEvent: (event) => {
        send(event)
        if (event.type === 'member-joined' && Notification.isSupported()) {
          void client?.listProjects().then((projects) => {
            const project = projects.find((item) => item.projectId === event.projectId)
            const member = project?.members?.find((item) => item.accountId === event.accountId)
            if (project && member) {
              const notification = new Notification({
                title: `${member.name} wants to join ${project.name}`,
                body: 'Open Settings > Team to approve or decline.'
              })
              retainUntilDismissed(notification)
              notification.on('click', () => {
                if (!win.isDestroyed()) win.webContents.send(IPC.appOpenSettings)
              })
              notification.show()
            }
          }).catch(() => undefined)
        }
        if (event.type === 'session-request') {
          void acceptSessionRequest(event as unknown as SessionRequest).catch((error) =>
            console.warn('[hub] session request failed:', error)
          )
        }
      }
    })
    const started = await client.start()
    // Every (re)connect re-asserts our local sides: the Hub's copy of the flag is what the other
    // members' auto-connect reads, and it must not lag a binding made while we were offline.
    void publishSharing().catch((error) => console.warn('[hub] sharing publish failed:', error))
    return started
  }

  function sync(): Promise<HubStatus> {
    const run = syncTail.then(syncNow, syncNow)
    syncTail = run.catch(() => status)
    return run
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
  platform.handle(IPC.hubProjectsApprove, async (projectId: unknown, accountId: unknown) => {
    const hub = await needClient()
    const member = (await hub.listProjects()).find((p) => p.projectId === String(projectId))?.members?.find((m) => m.accountId === String(accountId))
    const result = await hub.approveMember(String(projectId), String(accountId))
    if (member?.publicKeyB64) await saveApprovedDevices(pinDevice(await loadApprovedDevices(), member.publicKeyB64))
    return result
  })
  platform.handle(IPC.hubProjectsRemove, async (projectId: unknown, accountId: unknown) => {
    const hub = await needClient()
    const member = (await hub.listProjects()).find((p) => p.projectId === String(projectId))?.members?.find((m) => m.accountId === String(accountId))
    const result = await hub.removeMember(String(projectId), String(accountId))
    if (member?.publicKeyB64) {
      const revoked = await memberRevoker.revoke(member.publicKeyB64)
      if (!revoked.persisted || !revoked.killed) throw new Error('The member was removed, but relay access could not be fully revoked. Retry before sharing this project again.')
    }
    for (const key of [...hosted.keys()]) if (key.endsWith(`:${String(accountId)}`)) hosted.delete(key)
    return result
  })
  platform.handle(IPC.hubInviteRegenerate, async (projectId: unknown) => (await needClient()).regenerateInvite(String(projectId)))
  platform.handle(IPC.hubProjectsBind, async (hubProjectId: unknown, localProjectId: unknown) => {
    const shared = String(hubProjectId ?? '')
    if (!shared) return
    bindings.set(shared, typeof localProjectId === 'string' && localProjectId ? localProjectId : null)
    await publishSharing(shared)
  })
  platform.handle(IPC.hubProjectsConnect, async (projectId: unknown, toAccountId: unknown, machineLabel?: unknown) => {
    const hub = await needClient()
    const result = await hub.connectMember(
      String(projectId),
      String(toAccountId),
      typeof machineLabel === 'string' ? machineLabel : undefined
    )
    const keys = await loadOrCreatePeerKeyPair()
    return {
      offer: encodeHubConnectOffer(result),
      clientPublicKeyB64: Buffer.from(keys.publicKey).toString('base64')
    }
  })

  return {
    sync,
    stop() {
      client?.stop()
      client = null
      configuredUrl = ''
      configuredAccountName = ''
      bindings.clear()
      for (const session of hosted.values()) session.close()
      hosted.clear()
    }
  }
}
