import nacl from 'tweetnacl'
import type { HubEvent, HubProject, HubProjectMember, HubStatus } from '../../shared/types'
import { hubApiBase, hubDirectoryUrl, normalizeHubUrl } from './url'

interface KeyPair {
  publicKey: Uint8Array
  secretKey: Uint8Array
}

type WsLike = {
  close(): void
  on(event: 'open' | 'close' | 'error' | 'message', cb: (...args: any[]) => void): void
}

export interface HubClientOptions {
  hubUrl: string
  accountName: string
  keys: KeyPair
  onStatus?(status: HubStatus): void
  onEvent?(event: HubEvent): void
  webSocket?(url: string): WsLike
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000, 15_000]

export class HubClient {
  private session = ''
  private accountId = ''
  private socket: WsLike | null = null
  private stopped = false
  private reconnect: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private current: HubStatus = { state: 'disabled' }

  constructor(private readonly options: HubClientOptions) {}

  status(): HubStatus {
    return this.current
  }

  async start(): Promise<HubStatus> {
    this.stopped = false
    if (!normalizeHubUrl(this.options.hubUrl)) return this.setStatus({ state: 'disabled' })
    this.setStatus({ state: 'connecting' })
    try {
      const auth = await this.authenticate()
      this.session = auth.sessionToken
      this.accountId = auth.account.accountId
      this.openSocket()
      return this.setStatus({ state: 'connected', accountId: this.accountId, accountName: auth.account.name })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not connect to the Hub'
      this.scheduleReconnect()
      return this.setStatus({ state: 'error', error: message })
    }
  }

  stop(): void {
    this.stopped = true
    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = null
    this.socket?.close()
    this.socket = null
    this.session = ''
    this.setStatus({ state: 'disabled' })
  }

  listProjects(): Promise<HubProject[]> {
    return this.request<HubProject[]>('GET', '/v1/projects').then(async (projects) =>
      Promise.all(projects.map(async (project) => ({ ...project, members: await this.request<HubProjectMember[]>('GET', `/v1/projects/${encodeURIComponent(project.projectId)}/members`) })))
    )
  }

  createProject(name: string, projectId?: string): Promise<HubProject> {
    return this.request('POST', '/v1/projects', { name, projectId })
  }

  joinProject(inviteCode: string): Promise<HubProject> {
    return this.request('POST', '/v1/projects/join', { inviteCode })
  }

  approveMember(projectId: string, accountId: string): Promise<HubProject> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(accountId)}/approve`)
  }

  removeMember(projectId: string, accountId: string): Promise<HubProject> {
    return this.request('DELETE', `/v1/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(accountId)}`)
  }

  regenerateInvite(projectId: string): Promise<HubProject> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/invite`)
  }

  connectMember(projectId: string, toAccountId: string): Promise<{ pairingToken: string; relayUrl: string; toPublicKeyB64: string }> {
    return this.request('POST', `/v1/projects/${encodeURIComponent(projectId)}/connect`, { toAccountId })
  }

  private async authenticate(): Promise<{ account: { accountId: string; name: string }; sessionToken: string }> {
    const publicKeyB64 = Buffer.from(this.options.keys.publicKey).toString('base64')
    const challenge = await this.requestUnauthed<{ challengeId: string; hubPublicKeyB64: string; nonceB64: string; boxB64: string }>('POST', '/v1/accounts/challenge', { publicKeyB64 })
    const plain = nacl.box.open(
      Uint8Array.from(Buffer.from(challenge.boxB64, 'base64')),
      Uint8Array.from(Buffer.from(challenge.nonceB64, 'base64')),
      Uint8Array.from(Buffer.from(challenge.hubPublicKeyB64, 'base64')),
      this.options.keys.secretKey
    )
    if (!plain) throw new Error('Hub key challenge could not be opened')
    return this.requestUnauthed('POST', '/v1/accounts/register', {
      name: this.options.accountName.trim() || 'Someone',
      publicKeyB64,
      challengeId: challenge.challengeId,
      proofB64: Buffer.from(plain).toString('base64')
    })
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    if (!this.session) throw new Error('Hub is not connected')
    return this.fetchJson<T>(method, route, body, this.session)
  }

  private requestUnauthed<T>(method: string, route: string, body?: unknown): Promise<T> {
    return this.fetchJson<T>(method, route, body)
  }

  private async fetchJson<T>(method: string, route: string, body?: unknown, session?: string): Promise<T> {
    const response = await fetch(`${hubApiBase(this.options.hubUrl)}${route}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(session ? { authorization: `Bearer ${session}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const value = await response.json().catch(() => ({})) as { error?: string }
    if (!response.ok) throw new Error(value.error || `Hub request failed (${response.status})`)
    return value as T
  }

  private openSocket(): void {
    if (this.stopped || !this.session) return
    const make = this.options.webSocket ?? ((url: string): WsLike => {
      const WS = require('ws') as typeof import('ws')
      return new WS.WebSocket(url) as WsLike
    })
    const socket = make(hubDirectoryUrl(this.options.hubUrl, this.session))
    this.socket = socket
    socket.on('open', () => { this.reconnectAttempt = 0 })
    socket.on('message', (raw: unknown) => {
      try {
        const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
        const event = JSON.parse(text) as HubEvent | { type: 'connected' }
        if (event.type !== 'connected') this.options.onEvent?.(event)
      } catch {
        // Ignore malformed directory events. They never enter the tunnel protocol.
      }
    })
    const closed = (): void => {
      if (this.socket !== socket) return
      this.socket = null
      if (!this.stopped) {
        this.setStatus({ state: 'error', accountId: this.accountId, error: 'Hub directory connection closed' })
        this.scheduleReconnect()
      }
    }
    let fired = false
    const once = (): void => { if (!fired) { fired = true; closed() } }
    socket.on('close', once)
    socket.on('error', once)
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return
    const delay = RETRY_MS[Math.min(this.reconnectAttempt++, RETRY_MS.length - 1)]
    this.reconnect = setTimeout(() => { this.reconnect = null; void this.start() }, delay)
    this.reconnect.unref?.()
  }

  private setStatus(status: HubStatus): HubStatus {
    this.current = status
    this.options.onStatus?.(status)
    return status
  }
}
