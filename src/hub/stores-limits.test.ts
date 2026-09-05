// The ceilings and sweeps the security review's finding 1 asked for, at the store level: every
// mint that used to grow a map for the life of the process is now capped per issuing address and
// overall, and expired rows are reclaimed by an explicit sweep rather than only by a lookup that
// happens to hit them.
import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import nacl from 'tweetnacl'
import { HubDirectory } from './directory'
import { DEFAULT_HUB_LIMITS, HubLimitError, type HubLimits } from './limits'
import { HubTokenStore } from './tokens'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-hub-limits-'))
  dirs.push(dir)
  return dir
}

function limits(overrides: Partial<HubLimits>): HubLimits {
  return { ...DEFAULT_HUB_LIMITS, ...overrides }
}

async function authenticate(directory: HubDirectory, keys: nacl.BoxKeyPair, name: string, issuer?: string) {
  const publicKeyB64 = Buffer.from(keys.publicKey).toString('base64')
  const challenge = directory.issueChallenge(publicKeyB64, issuer)
  const proof = nacl.box.open(
    Buffer.from(challenge.boxB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.hubPublicKeyB64, 'base64'),
    keys.secretKey
  )
  if (!proof) throw new Error('test challenge did not open')
  return directory.authenticate({ name, publicKeyB64, challengeId: challenge.challengeId, proofB64: Buffer.from(proof).toString('base64') })
}

describe('HubTokenStore ceilings and sweep', () => {
  it('caps live relay tokens per issuing address and overall, and frees the slots when they expire', async () => {
    let now = 1000
    const store = new HubTokenStore(await tmp(), () => now, limits({ maxTokens: 3, maxTokensPerIssuer: 2 }))
    await store.init()
    await store.mintPair(100, 'ip-a')
    await store.mintPair(100, 'ip-a')
    await expect(store.mintPair(100, 'ip-a')).rejects.toBeInstanceOf(HubLimitError)
    await store.mintStandingHost('room', 100, 'ip-b')
    await expect(store.mintStandingClient('room', 100, 'ip-c')).rejects.toThrow(/live relay token limit/)
    expect(store.liveCount('ip-a')).toMatchObject({ tokens: 3, issuerTokens: 2 })
    now = 1200
    expect(store.liveCount('ip-a')).toMatchObject({ tokens: 0, issuerTokens: 0 })
    await store.mintPair(100, 'ip-a')
    // A row minted before the ceilings existed carries no issuer and counts only overall.
    expect(store.liveCount('ip-a')).toMatchObject({ tokens: 1, issuerTokens: 1 })
  })

  it('frees a slot the moment its token is consumed', async () => {
    const store = new HubTokenStore(await tmp(), () => 1000, limits({ maxTokensPerIssuer: 1 }))
    await store.init()
    const first = await store.mintPair(1000, 'ip-a')
    await expect(store.mintPair(1000, 'ip-a')).rejects.toBeInstanceOf(HubLimitError)
    await store.consume([first.token])
    await expect(store.mintPair(1000, 'ip-a')).resolves.toMatchObject({ kind: 'pair' })
  })

  it('caps paired devices per issuing address but lets a device re-register itself', async () => {
    const store = new HubTokenStore(await tmp(), () => 1000, limits({ maxDevicesPerIssuer: 1 }))
    await store.init()
    const first = await store.registerDevice('host-1', 'phone-1', undefined, 'ip-a')
    await expect(store.registerDevice('host-1', 'phone-2', undefined, 'ip-a')).rejects.toThrow(/too many devices/)
    // Same device id: the old row is replaced first, so the ceiling never refuses a re-pair.
    const again = await store.registerDevice('host-1', 'phone-1', undefined, 'ip-a')
    expect(store.device(first.deviceToken)).toBeNull()
    expect(store.device(again.deviceToken)?.hostId).toBe('host-1')
    // Same through the prior-token path.
    const replaced = await store.registerDevice('host-1', undefined, again.deviceToken, 'ip-a')
    expect(store.device(again.deviceToken)).toBeNull()
    expect(store.device(replaced.deviceToken)?.hostId).toBe('host-1')
    expect(store.liveCount('ip-a')).toMatchObject({ devices: 1, issuerDevices: 1 })
  })

  it('sweep drops expired and consumed rows and persists the pruned file', async () => {
    let now = 1000
    const dir = await tmp()
    const store = new HubTokenStore(dir, () => now)
    await store.init()
    await store.mintPair(100)
    const standing = await store.mintStandingHost('room', 10_000)
    // Consumed LAST: a later mint would already have pruned it on its own ceiling check.
    const consumed = await store.mintPair(10_000)
    await store.consume([consumed.token])
    await store.registerDevice('room', 'phone-1')
    expect(store.size()).toEqual({ tokens: 3, devices: 1 })
    now = 1200
    expect(await store.sweep()).toBe(2)
    expect(store.size()).toEqual({ tokens: 1, devices: 1 })
    const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'tokens.json'), 'utf8')) as { tokens: Array<{ token: string }>; devices: unknown[] }
    expect(onDisk.tokens.map((item) => item.token)).toEqual([standing.token])
    expect(onDisk.devices).toHaveLength(1)
    // Nothing to drop: no write either.
    const stamp = (await fs.stat(path.join(dir, 'tokens.json'))).mtimeMs
    expect(await store.sweep()).toBe(0)
    expect((await fs.stat(path.join(dir, 'tokens.json'))).mtimeMs).toBe(stamp)
  })
})

describe('HubDirectory ceilings and sweep', () => {
  it('caps open key challenges per issuing address and overall, and the sweep reclaims expired ones', async () => {
    let now = 0
    const directory = new HubDirectory(await tmp(), () => now, limits({ maxChallenges: 3, maxChallengesPerIssuer: 2 }))
    await directory.init()
    const key = Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
    directory.issueChallenge(key, 'ip-a')
    directory.issueChallenge(key, 'ip-a')
    expect(() => directory.issueChallenge(key, 'ip-a')).toThrow(HubLimitError)
    directory.issueChallenge(key, 'ip-b')
    expect(() => directory.issueChallenge(key, 'ip-c')).toThrow(/too many open key challenges/)
    expect(directory.liveChallengeCount('ip-a')).toEqual({ total: 3, issuer: 2 })
    now = 3 * 60 * 1000
    expect(directory.size().challenges).toBe(3)
    expect(directory.sweep()).toEqual({ challenges: 3, sessions: 0 })
    expect(directory.size().challenges).toBe(0)
    expect(() => directory.issueChallenge(key, 'ip-a')).not.toThrow()
  })

  it('frees a challenge slot the moment it is answered', async () => {
    const directory = new HubDirectory(await tmp(), () => 0, limits({ maxChallengesPerIssuer: 1 }))
    await directory.init()
    const keys = nacl.box.keyPair()
    await authenticate(directory, keys, 'Ada', 'ip-a')
    await expect(authenticate(directory, keys, 'Ada', 'ip-a')).resolves.toMatchObject({ account: { name: 'Ada' } })
  })

  it('refuses a new account past the ceiling while a known key still signs in', async () => {
    const directory = new HubDirectory(await tmp(), () => 0, limits({ maxAccounts: 1 }))
    await directory.init()
    const known = nacl.box.keyPair()
    await authenticate(directory, known, 'Ada')
    await expect(authenticate(directory, nacl.box.keyPair(), 'Bob')).rejects.toThrow(/account limit/)
    await expect(authenticate(directory, known, 'Ada')).resolves.toMatchObject({ account: { name: 'Ada' } })
    expect(directory.size().accounts).toBe(1)
  })

  it('caps projects overall and per owner', async () => {
    const directory = new HubDirectory(await tmp(), () => 0, limits({ maxProjects: 3, maxProjectsPerAccount: 2 }))
    await directory.init()
    const a = (await authenticate(directory, nacl.box.keyPair(), 'Ada')).account.accountId
    const b = (await authenticate(directory, nacl.box.keyPair(), 'Bob')).account.accountId
    await directory.createProject(a, 'one')
    await directory.createProject(a, 'two')
    await expect(directory.createProject(a, 'three')).rejects.toThrow(/this account has reached its project limit/)
    await directory.createProject(b, 'three')
    await expect(directory.createProject(b, 'four')).rejects.toThrow(/the Hub has reached its project limit/)
    expect(directory.size().projects).toBe(3)
  })

  it('keeps at most N live sessions per account, evicting the oldest first', async () => {
    const directory = new HubDirectory(await tmp(), () => 0, limits({ maxSessionsPerAccount: 2 }))
    await directory.init()
    const keys = nacl.box.keyPair()
    const first = await authenticate(directory, keys, 'Ada')
    const second = await authenticate(directory, keys, 'Ada')
    const third = await authenticate(directory, keys, 'Ada')
    expect(directory.accountForSession(first.sessionToken)).toBeNull()
    expect(directory.accountForSession(second.sessionToken)?.name).toBe('Ada')
    expect(directory.accountForSession(third.sessionToken)?.name).toBe('Ada')
    expect(directory.liveSessionCount()).toBe(2)
  })

  it('sweep drops expired sessions', async () => {
    let now = 0
    const directory = new HubDirectory(await tmp(), () => now)
    await directory.init()
    const session = await authenticate(directory, nacl.box.keyPair(), 'Ada')
    expect(directory.size().sessions).toBe(1)
    now = 61 * 60 * 1000
    expect(directory.sweep()).toEqual({ challenges: 0, sessions: 1 })
    expect(directory.size().sessions).toBe(0)
    expect(directory.accountForSession(session.sessionToken)).toBeNull()
  })
})
