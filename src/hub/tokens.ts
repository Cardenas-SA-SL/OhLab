import { randomBytes, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../core/fs-atomic'

export type HubTokenKind = 'pair' | 'standing-host' | 'standing-client'

export interface HubRelayToken {
  token: string
  pairingId: string
  roomId: string
  kind: HubTokenKind
  exp: number
  consumed: boolean
}

interface TokenFile {
  tokens: HubRelayToken[]
  devices: Array<{ deviceToken: string; deviceId?: string; hostId: string; exp: number }>
}

const TEN_MINUTES = 10 * 60 * 1000
const STANDING_TTL = 24 * 60 * 60 * 1000
const DEVICE_TTL = 365 * 24 * 60 * 60 * 1000

function secret(): string {
  return randomBytes(32).toString('base64url')
}

export class HubTokenStore {
  private readonly file: string
  private tokens = new Map<string, HubRelayToken>()
  private devices = new Map<string, { deviceToken: string; deviceId?: string; hostId: string; exp: number }>()
  private saveTail: Promise<void> = Promise.resolve()

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
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

  async mintPair(ttlMs = TEN_MINUTES): Promise<HubRelayToken> {
    const pairingId = randomUUID()
    return this.mint('pair', pairingId, ttlMs, pairingId)
  }

  async mintStandingHost(hostId: string, ttlMs = STANDING_TTL): Promise<HubRelayToken> {
    return this.mint('standing-host', randomUUID(), ttlMs, hostId)
  }

  async mintStandingClient(hostId: string, ttlMs = TEN_MINUTES): Promise<HubRelayToken> {
    return this.mint('standing-client', randomUUID(), ttlMs, hostId)
  }

  private async mint(kind: HubTokenKind, pairingId: string, ttlMs: number, roomId: string): Promise<HubRelayToken> {
    const item: HubRelayToken = {
      token: secret(),
      pairingId,
      roomId,
      kind,
      exp: this.now() + Math.max(1, ttlMs),
      consumed: false
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

  async registerDevice(hostId: string, deviceId?: string, priorDeviceToken?: string): Promise<{ deviceToken: string; hostId: string; exp: number }> {
    if (priorDeviceToken) this.devices.delete(priorDeviceToken)
    if (deviceId) {
      for (const [token, device] of this.devices) {
        if (device.hostId === hostId && device.deviceId === deviceId) this.devices.delete(token)
      }
    }
    const item = { deviceToken: secret(), deviceId, hostId, exp: this.now() + DEVICE_TTL }
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

  private save(): Promise<void> {
    this.saveTail = this.saveTail.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const value: TokenFile = { tokens: [...this.tokens.values()], devices: [...this.devices.values()] }
      await writeFileAtomic(this.file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
    })
    return this.saveTail
  }
}
