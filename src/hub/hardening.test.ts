// The Hub's front door under hostile traffic (security review, findings 1, 2, 5 and 6): the
// caller-chosen room refusal, per-address metering of writes and upgrades, the ceilings, the
// body deadline, the periodic sweep, the proxy-address rule, and the constant-time admin compare.
// Everything here goes over a real socket against a real Hub; nothing about the wire contract the
// desktop relies on (`/v1/pair/token`, `/v1/relay/*`, `/relay?token=`, `/dir?session=`) changes.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import nacl from 'tweetnacl'
import { WebSocket } from 'ws'
import { createHub, type Hub, type HubConfig } from './index'

const hubs: Hub[] = []
const dirs: string[] = []
const sandboxed = process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1'

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function boot(config: Partial<HubConfig> = {}): Promise<{ hub: Hub; base: string; ws: string; port: number; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-hub-hardening-'))
  dirs.push(dir)
  const hub = createHub({ dataDir: dir, host: '127.0.0.1', port: 0, log: () => {}, ...config })
  hubs.push(hub)
  const address = await hub.listen()
  return { hub, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}`, port: address.port, dir }
}

function post(base: string, route: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

function publicKey(): string {
  return Buffer.from(nacl.box.keyPair().publicKey).toString('base64')
}

function opened(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function register(base: string, name: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const keys = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keys.publicKey).toString('base64')
  const challenge = await post(base, '/v1/accounts/challenge', { publicKeyB64 }).then((r) => r.json()) as { challengeId: string; hubPublicKeyB64: string; nonceB64: string; boxB64: string }
  const proof = nacl.box.open(Buffer.from(challenge.boxB64, 'base64'), Buffer.from(challenge.nonceB64, 'base64'), Buffer.from(challenge.hubPublicKeyB64, 'base64'), keys.secretKey)
  const response = await post(base, '/v1/accounts/register', { name, publicKeyB64, challengeId: challenge.challengeId, proofB64: Buffer.from(proof!).toString('base64') })
  return { status: response.status, body: await response.json() as Record<string, unknown> }
}

describe.skipIf(sandboxed)('Hub front door hardening', () => {
  it('refuses a caller-chosen room on /v1/pair/token and keeps the plain mint', async () => {
    const { base } = await boot()
    const squat = await post(base, '/v1/pair/token', { standing: true, hostId: 'victim-room' })
    expect(squat.status).toBe(400)
    expect(((await squat.json()) as { error: string }).error).toMatch(/\/v1\/relay\/host-token/)
    const bare = await post(base, '/v1/pair/token', { hostId: 'victim-room' })
    expect(bare.status).toBe(400)
    const plain = await post(base, '/v1/pair/token', {})
    expect(plain.status).toBe(201)
    expect(((await plain.json()) as { pairingToken: string }).pairingToken).toHaveLength(43)
  })

  it('meters non-GET requests per client address with a 429 and retry-after, and never GETs', async () => {
    const { base } = await boot({ limits: { writeRate: { capacity: 2, refillPerSecond: 0 } } })
    expect((await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })).status).toBe(201)
    expect((await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })).status).toBe(201)
    const refused = await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })
    expect(refused.status).toBe(429)
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/)
    expect(((await refused.json()) as { error: string }).error).toMatch(/too many requests/)
    // The mint routes are refused too, before their body is read.
    expect((await post(base, '/v1/pair/token', {})).status).toBe(429)
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
  })

  it('caps open key challenges per address, and the sweep reclaims them once they expire', async () => {
    let now = 1_000_000
    const { hub, base } = await boot({ now: () => now, sweepIntervalMs: 20, limits: { maxChallengesPerIssuer: 2 } })
    expect((await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })).status).toBe(201)
    expect((await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })).status).toBe(201)
    const refused = await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })
    expect(refused.status).toBe(429)
    expect(((await refused.json()) as { error: string }).error).toMatch(/too many open key challenges/)
    expect(hub.stats().challenges).toBe(2)
    now += 3 * 60_000
    await vi.waitFor(() => expect(hub.stats().challenges).toBe(0), { timeout: 2000 })
    expect((await post(base, '/v1/accounts/challenge', { publicKeyB64: publicKey() })).status).toBe(201)
  })

  it('sweeps expired relay tokens out of memory and off disk without anyone looking them up', async () => {
    let now = 1_000_000
    const { hub, base, dir } = await boot({ now: () => now, sweepIntervalMs: 20 })
    expect((await post(base, '/v1/pair/token', { ttlMs: 100 })).status).toBe(201)
    expect((await post(base, '/v1/pair/token', { ttlMs: 100 })).status).toBe(201)
    expect(hub.stats().tokens).toBe(2)
    now += 1000
    await vi.waitFor(async () => {
      expect(hub.stats().tokens).toBe(0)
      const onDisk = JSON.parse(await fs.readFile(path.join(dir, 'tokens.json'), 'utf8')) as { tokens: unknown[] }
      expect(onDisk.tokens).toEqual([])
    }, { timeout: 2000 })
  })

  it('cuts a body that never finishes arriving at the deadline (slow-loris)', async () => {
    const { port } = await boot({ limits: { bodyTimeoutMs: 200 } })
    const outcome = await new Promise<{ response: string; ms: number }>((resolve) => {
      const started = Date.now()
      let response = ''
      const socket = net.connect(port, '127.0.0.1')
      socket.on('connect', () => socket.write('POST /v1/pair/token HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'))
      socket.on('data', (chunk) => { response += chunk.toString() })
      socket.on('error', () => {})
      socket.on('close', () => resolve({ response, ms: Date.now() - started }))
    })
    expect(outcome.response).toMatch(/^HTTP\/1\.1 408/)
    expect(outcome.response).toMatch(/request body timed out/)
    expect(outcome.ms).toBeLessThan(3000)
  })

  it('refuses an oversized body by its declared length before reading it', async () => {
    const { base } = await boot()
    const response = await post(base, '/v1/pair/token', { pad: 'x'.repeat(2 * 1024 * 1024) })
    expect(response.status).toBe(413)
  })

  it('meters WebSocket upgrades per address', async () => {
    const { base, ws } = await boot({ limits: { upgradeRate: { capacity: 1, refillPerSecond: 0 } } })
    const minted = await post(base, '/v1/pair/token', {}).then((r) => r.json()) as { pairingToken: string }
    const first = await opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)
    await expect(opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)).rejects.toThrow(/429/)
    first.close()
  })

  it('keeps a bridged relay open past the HTTP request timeout (the timeouts never reach an upgraded socket)', async () => {
    const { base, ws } = await boot({ limits: { headersTimeoutMs: 200, requestTimeoutMs: 300 } })
    const minted = await post(base, '/v1/pair/token', {}).then((r) => r.json()) as { pairingToken: string }
    const host = await opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)
    const client = await opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)
    const received: string[] = []
    client.on('message', (data) => received.push(data.toString()))
    await new Promise((resolve) => setTimeout(resolve, 900))
    expect(host.readyState).toBe(WebSocket.OPEN)
    expect(client.readyState).toBe(WebSocket.OPEN)
    host.send('still here')
    await vi.waitFor(() => expect(received).toEqual(['still here']))
    host.close()
    client.close()
  })

  it('refuses new accounts past the ceiling with a 429 the client can read', async () => {
    const { base } = await boot({ limits: { maxAccounts: 1 } })
    expect((await register(base, 'Ada')).status).toBe(201)
    const refused = await register(base, 'Bob')
    expect(refused.status).toBe(429)
    expect(refused.body.error).toMatch(/account limit/)
  })

  it('takes the client address from x-forwarded-for only when told to trust a proxy', async () => {
    const naive = await boot({ limits: { writeRate: { capacity: 1, refillPerSecond: 0 } } })
    expect((await post(naive.base, '/v1/pair/token', {}, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(201)
    // Same real address: the header is ignored and the bucket is shared.
    expect((await post(naive.base, '/v1/pair/token', {}, { 'x-forwarded-for': '2.2.2.2' })).status).toBe(429)

    const proxied = await boot({ trustProxy: true, limits: { writeRate: { capacity: 1, refillPerSecond: 0 } } })
    expect((await post(proxied.base, '/v1/pair/token', {}, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(201)
    expect((await post(proxied.base, '/v1/pair/token', {}, { 'x-forwarded-for': '2.2.2.2, 10.0.0.1' })).status).toBe(201)
    expect((await post(proxied.base, '/v1/pair/token', {}, { 'x-forwarded-for': '1.1.1.1' })).status).toBe(429)
  })

  it('answers a wrong admin token of any length with a plain 401', async () => {
    const { base } = await boot({ adminToken: 'admin-secret' })
    const attempt = (token?: string): Promise<Response> => fetch(`${base}/v1/admin/accounts`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } })
    expect((await attempt()).status).toBe(401)
    expect((await attempt('x')).status).toBe(401)
    expect((await attempt('admin-secret-but-longer')).status).toBe(401)
    expect((await attempt('admin-secreT')).status).toBe(401)
    expect((await attempt('admin-secret')).status).toBe(200)
  })
})
