import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../core/fs-atomic'
import { DEFAULT_HUB_LIMITS, HubLimitError, type HubLimits } from './limits'

export type HubTokenKind = 'pair' | 'standing-host' | 'standing-client'

export interface HubRelayToken {
  token: string
  pairingId: string
  roomId: string
  kind: HubTokenKind
  exp: number
  consumed: boolean
  /** The client address that minted it, so per-address ceilings survive a restart. Absent on rows
   *  written before the ceilings existed; those count only against the overall ceiling. */
  issuer?: string
}

interface DeviceRow {
  deviceToken: string
  deviceId?: string
  hostId: string
  exp: number
  issuer?: string
}

interface TokenFile {
  tokens: HubRelayToken[]
  devices: DeviceRow[]
}

const TEN_MINUTES = 10 * 60 * 1000
const STANDING_TTL = 24 * 60 * 60 * 1000
const DEVICE_TTL = 365 * 24 * 60 * 60 * 1000

type TokenLimits = Pick<HubLimits, 'maxTokens' | 'maxTokensPerIssuer' | 'maxDevices' | 'maxDevicesPerIssuer'>

function secret(): string {
  return randomBytes(32).toString('base64url')
}

export class HubTokenStore {
  private readonly file: string
  private tokens = new Map<string, HubRelayToken>()
  private devices = new Map<string, DeviceRow>()
  private saveTail: Promise<void> = Promise.resolve()

  constructor(
    dataDir: string,
    private readonly now: () => number = Date.now,
    private readonly limits: TokenLimits = DEFAULT_HUB_LIMITS
  ) {
    this.file = path.join(dataDir, 'tokens.json')
  }

  async init(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8')) as Partial<TokenFile>
      for (const item of parsed.tokens ?? []) {
        if (item.exp > this.now() && !item.consumed) this.tokens.set(item.token, item)
      }
      for (const item of parsed.devices ?? []) {
        if (item.exp > this.now()) this.devices.set(item.deviceToken, item)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async mintPair(ttlMs = TEN_MINUTES, issuer?: string): Promise<HubRelayToken> {
    const pairingId = randomUUID()
    return this.mint('pair', pairingId, ttlMs, pairingId, issuer)
  }

  async mintStandingHost(hostId: string, ttlMs = STANDING_TTL, issuer?: string): Promise<HubRelayToken> {
    return this.mint('standing-host', randomUUID(), ttlMs, hostId, issuer)
  }

  async mintStandingClient(hostId: string, ttlMs = TEN_MINUTES, issuer?: string): Promise<HubRelayToken> {
    return this.mint('standing-client', randomUUID(), ttlMs, hostId, issuer)
  }

  private async mint(kind: HubTokenKind, pairingId: string, ttlMs: number, roomId: string, issuer?: string): Promise<HubRelayToken> {
    const live = this.pruneTokens(issuer)
    if (live.total >= this.limits.maxTokens) throw new HubLimitError('the Hub has reached its live relay token limit')
    if (issuer && live.mine >= this.limits.maxTokensPerIssuer) throw new HubLimitError('too many live relay tokens were minted from this address')
    const item: HubRelayToken = {
      token: secret(),
      pairingId,
      roomId,
      kind,
      exp: this.now() + Math.max(1, ttlMs),
      consumed: false,
      ...(issuer ? { issuer } : {})
    }
    this.tokens.set(item.token, item)
    await this.save()
    return item
  }

  resolve(token: string): HubRelayToken | null {
    const item = this.tokens.get(token)
    if (!item || item.consumed || item.exp <= this.now()) {
      if (item) this.tokens.delete(token)
      return null
    }
    return item
  }

  async consume(tokens: string[]): Promise<void> {
    for (const token of tokens) {
      const item = this.tokens.get(token)
      if (item) item.consumed = true
    }
    await this.save()
  }

  async registerDevice(hostId: string, deviceId?: string, priorDeviceToken?: string, issuer?: string): Promise<{ deviceToken: string; hostId: string; exp: number }> {
    // Replace before counting: a device re-registering itself must never be refused by the slot
    // its own previous token holds.
    if (priorDeviceToken) this.devices.delete(priorDeviceToken)
    if (deviceId) {
      for (const [token, device] of this.devices) {
        if (device.hostId === hostId && device.deviceId === deviceId) this.devices.delete(token)
      }
    }
    const live = this.pruneDevices(issuer)
    if (live.total >= this.limits.maxDevices) throw new HubLimitError('the Hub has reached its paired device limit')
    if (issuer && live.mine >= this.limits.maxDevicesPerIssuer) throw new HubLimitError('too many devices were paired from this address')
    const item: DeviceRow = { deviceToken: secret(), deviceId, hostId, exp: this.now() + DEVICE_TTL, ...(issuer ? { issuer } : {}) }
    this.devices.set(item.deviceToken, item)
    await this.save()
    return { deviceToken: item.deviceToken, hostId: item.hostId, exp: item.exp }
  }

  device(deviceToken: string): { deviceToken: string; deviceId?: string; hostId: string; exp: number } | null {
    const item = this.devices.get(deviceToken)
    if (!item || item.exp <= this.now()) {
      if (item) this.devices.delete(deviceToken)
      return null
    }
    return item
  }

  async revokeDevice(deviceTokenOrId: string): Promise<void> {
    this.devices.delete(deviceTokenOrId)
    for (const [token, device] of this.devices) {
      if (device.deviceId === deviceTokenOrId) this.devices.delete(token)
    }
    await this.save()
  }

  /** Live rows right now (expired and consumed ones are dropped on the way), overall and for one
   *  issuing address. What the mint ceilings are measured against. */
  liveCount(issuer?: string): { tokens: number; devices: number; issuerTokens: number; issuerDevices: number } {
    const tokens = this.pruneTokens(issuer)
    const devices = this.pruneDevices(issuer)
    return { tokens: tokens.total, devices: devices.total, issuerTokens: tokens.mine, issuerDevices: devices.mine }
  }

  /** Raw row counts, expired and consumed rows included (nothing is pruned on the way). */
  size(): { tokens: number; devices: number } {
    return { tokens: this.tokens.size, devices: this.devices.size }
  }

  /** Drop expired/consumed tokens and expired devices, persisting when anything went. Called on
   *  the Hub's periodic sweep: before it, a token nobody ever looked up again lived forever, and
   *  every mint rewrote the whole file with the dead rows still in it. Returns how many were dropped. */
  async sweep(): Promise<number> {
    const before = this.tokens.size + this.devices.size
    this.pruneTokens()
    this.pruneDevices()
    const dropped = before - (this.tokens.size + this.devices.size)
    if (dropped > 0) await this.save()
    return dropped
  }

  private pruneTokens(issuer?: string): { total: number; mine: number } {
    const at = this.now()
    let total = 0
    let mine = 0
    for (const [token, item] of this.tokens) {
      if (item.consumed || item.exp <= at) {
        this.tokens.delete(token)
        continue
      }
      total++
      if (issuer && item.issuer === issuer) mine++
    }
    return { total, mine }
  }

  private pruneDevices(issuer?: string): { total: number; mine: number } {
    const at = this.now()
    let total = 0
    let mine = 0
    for (const [token, item] of this.devices) {
      if (item.exp <= at) {
        this.devices.delete(token)
        continue
      }
      total++
      if (issuer && item.issuer === issuer) mine++
    }
    return { total, mine }
  }

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const value: TokenFile = { tokens: [...this.tokens.values()], devices: [...this.devices.values()] }
      await writeFileAtomic(this.file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    })
    return this.saveTail
  }
}
