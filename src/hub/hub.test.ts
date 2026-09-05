import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import nacl from 'tweetnacl'
import { WebSocket } from 'ws'
import { createHub, type Hub } from './index'
import { HubTokenStore } from './tokens'

const hubs: Hub[] = []
const dirs: string[] = []

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.close()))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function boot(adminToken?: string): Promise<{ hub: Hub; base: string; ws: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-hub-'))
  dirs.push(dir)
  const hub = createHub({ dataDir: dir, host: '127.0.0.1', port: 0, adminToken, log: () => {} })
  hubs.push(hub)
  const address = await hub.listen()
  return { hub, base: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}`, dir }
}

async function post<T>(base: string, route: string, body: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((value as { error?: string }).error ?? String(response.status))
  return value as T
}

async function account(base: string, name: string): Promise<{ token: string; accountId: string; keys: nacl.BoxKeyPair }> {
  const keys = nacl.box.keyPair()
  const publicKeyB64 = Buffer.from(keys.publicKey).toString('base64')
  const challenge = await post<{ challengeId: string; hubPublicKeyB64: string; nonceB64: string; boxB64: string }>(base, '/v1/accounts/challenge', { publicKeyB64 })
  const proof = nacl.box.open(
    Buffer.from(challenge.boxB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.hubPublicKeyB64, 'base64'),
    keys.secretKey
  )
  expect(proof).not.toBeNull()
  const auth = await post<{ sessionToken: string; account: { accountId: string } }>(base, '/v1/accounts/register', {
    name,
    publicKeyB64,
    challengeId: challenge.challengeId,
    proofB64: Buffer.from(proof!).toString('base64')
  })
  return { token: auth.sessionToken, accountId: auth.account.accountId, keys }
}

/** A raw HTTP call with an explicit `Host` header. `fetch` cannot model a caller that dialled the
 *  Hub through another address: Host is a forbidden request header in the Fetch spec and undici
 *  silently drops it, so the Hub would only ever see 127.0.0.1. */
function request(base: string, route: string, init: { method: string; token?: string; host?: string; body?: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(`${base}${route}`)
  const payload = init.body === undefined ? undefined : JSON.stringify(init.body)
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }),
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.host === undefined ? {} : { host: init.host })
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) as Record<string, unknown> : {} })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function opened(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

/** Collect the `session-request` events a member's directory socket receives, in order, and hand
 *  them out one at a time with a bounded wait, so a missing push fails with its own message. */
function sessionRequests(socket: WebSocket): () => Promise<Record<string, unknown>> {
  const queue: Record<string, unknown>[] = []
  const waiters: Array<(event: Record<string, unknown>) => void> = []
  socket.on('message', (raw) => {
    const event = JSON.parse(raw.toString()) as Record<string, unknown>
    if (event.type !== 'session-request') return
    const waiter = waiters.shift()
    if (waiter) waiter(event)
    else queue.push(event)
  })
  return () => {
    const queued = queue.shift()
    if (queued) return Promise.resolve(queued)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no session-request reached the member within 2 s')), 2000)
      waiters.push((event) => {
        clearTimeout(timer)
        resolve(event)
      })
    })
  }
}

describe('OhLab Hub', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('bridges text and binary frames FIFO, then closes the peer', async () => {
    const { base, ws } = await boot()
    const minted = await post<{ pairingToken: string }>(base, '/v1/pair/token', {})
    const host = await opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)
    const client = await opened(`${ws}/relay?token=${encodeURIComponent(minted.pairingToken)}`)
    const received: Array<string | Buffer> = []
    client.on('message', (data, binary) => received.push(binary ? Buffer.from(data as Buffer) : data.toString()))
    host.send('one')
    host.send(Buffer.from([2, 3]), { binary: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(received).toEqual(['one', Buffer.from([2, 3])])
    const closed = new Promise<number>((resolve) => client.once('close', resolve))
    host.close()
    expect(await closed).toBe(1000)
  })

  it('expires and consumes tokens and restores unconsumed standing tokens', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-tokens-'))
    dirs.push(dir)
    let now = 100
    const store = new HubTokenStore(dir, () => now)
    await store.init()
    const pair = await store.mintPair(10)
    expect(store.resolve(pair.token)?.roomId).toBe(pair.pairingId)
    now = 111
    expect(store.resolve(pair.token)).toBeNull()
    const standing = await store.mintStandingHost('stable-host', 100)
    const restored = new HubTokenStore(dir, () => now)
    await restored.init()
    expect(restored.resolve(standing.token)?.roomId).toBe('stable-host')
    await restored.consume([standing.token])
    expect(restored.resolve(standing.token)).toBeNull()

    const device = await restored.registerDevice('stable-host', 'phone-1')
    expect(restored.device(device.deviceToken)?.hostId).toBe('stable-host')
    await restored.revokeDevice('phone-1')
    expect(restored.device(device.deviceToken)).toBeNull()
  })

  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('supports invite, pending approval, presence, connect brokering, admin auth, and restart persistence', async () => {
    const { hub, base, ws, dir } = await boot('admin-secret')
    const owner = await account(base, 'Owner')
    const member = await account(base, 'Member')
    const project = await post<{ projectId: string; inviteCode: string }>(base, '/v1/projects', { name: 'Demo', projectId: 'local-project-1' }, owner.token)
    expect(project.projectId).toBe('local-project-1')
    await post(base, '/v1/projects/join', { inviteCode: project.inviteCode }, member.token)
    const regenerated = await post<{ inviteCode: string }>(base, `/v1/projects/${project.projectId}/invite`, {}, owner.token)
    expect(regenerated.inviteCode).not.toBe(project.inviteCode)
    let members = await fetch(`${base}/v1/projects/${project.projectId}/members`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json()) as Array<{ accountId: string; status: string; online: boolean }>
    expect(members.find((item) => item.accountId === member.accountId)?.status).toBe('pending')
    await post(base, `/v1/projects/${project.projectId}/members/${member.accountId}/approve`, {}, owner.token)
    // The member reaches the Hub through its LAN address; the `/dir` upgrade carries that Host.
    const port = new URL(base).port
    const memberReachableHost = `192.168.1.128:${port}`
    const memberDir = await opened(`${ws}/dir?session=${encodeURIComponent(member.token)}`, { host: memberReachableHost })
    const nextSessionRequest = sessionRequests(memberDir)
    await new Promise((resolve) => setTimeout(resolve, 10))
    members = await fetch(`${base}/v1/projects/${project.projectId}/members`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json()) as typeof members
    expect(members.find((item) => item.accountId === member.accountId)?.online).toBe(true)

    // Each party is told the relay through the address IT dialled. The owner on the Hub's own
    // machine (an embedded Hub) dials loopback and is answered with loopback; the member is pushed
    // the LAN host its own socket came in on.
    const connection = await post<{ pairingToken: string; relayUrl: string }>(base, `/v1/projects/${project.projectId}/connect`, { toAccountId: member.accountId, machineLabel: "Owner's Mac" }, owner.token)
    expect(connection.pairingToken).toHaveLength(43)
    expect(connection.relayUrl).toBe(`ws://127.0.0.1:${port}/relay`)
    expect(await nextSessionRequest()).toMatchObject({
      fromAccountId: owner.accountId,
      machineLabel: "Owner's Mac",
      pairingToken: connection.pairingToken,
      relayUrl: `ws://${memberReachableHost}/relay`
    })
    // The same owner reaching the Hub through another interface gets THAT address back, and the
    // member's push is unaffected by how the caller dialled.
    const ownerReachableHost = `10.0.0.7:${port}`
    const lanConnection = await request(base, `/v1/projects/${project.projectId}/connect`, {
      method: 'POST', token: owner.token, host: ownerReachableHost, body: { toAccountId: member.accountId, machineLabel: "Owner's Mac" }
    })
    expect(lanConnection.status).toBe(201)
    expect(lanConnection.body.relayUrl).toBe(`ws://${ownerReachableHost}/relay`)
    expect(await nextSessionRequest()).toMatchObject({ pairingToken: lanConnection.body.pairingToken, relayUrl: `ws://${memberReachableHost}/relay` })
    const unauthorized = await fetch(`${base}/v1/admin/accounts`)
    expect(unauthorized.status).toBe(401)
    const accounts = await fetch(`${base}/v1/admin/accounts`, { headers: { authorization: 'Bearer admin-secret' } }).then((r) => r.json()) as unknown[]
    expect(accounts).toHaveLength(2)
    const removed = await fetch(`${base}/v1/projects/${project.projectId}/members/${member.accountId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${owner.token}` }
    })
    expect(removed.status).toBe(200)
    await post(base, '/v1/projects/join', { inviteCode: regenerated.inviteCode }, member.token)
    await post(base, `/v1/projects/${project.projectId}/members/${member.accountId}/approve`, {}, owner.token)
    memberDir.close()
    await hub.close()
    hubs.splice(hubs.indexOf(hub), 1)
    const restarted = createHub({ dataDir: dir, host: '127.0.0.1', port: 0, adminToken: 'admin-secret', log: () => {} })
    hubs.push(restarted)
    const address = await restarted.listen()
    const health = await fetch(`http://127.0.0.1:${address.port}/healthz`).then((r) => r.json())
    expect(health).toMatchObject({ ok: true, name: 'OhLab Hub' })
    const restoredProjects = await fetch(`http://127.0.0.1:${address.port}/v1/admin/projects`, {
      headers: { authorization: 'Bearer admin-secret' }
    }).then((r) => r.json()) as Array<{ projectId: string; members: unknown[] }>
    expect(restoredProjects).toEqual([expect.objectContaining({ projectId: 'local-project-1' })])
    expect(restoredProjects[0].members).toHaveLength(2)
  })
})

describe('token expiry on the wire', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('reports exp in UNIX seconds, the unit the desktop standing host multiplies by 1000', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-hub-exp-'))
    const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
    try {
      const address = await hub.listen()
      const res = await fetch(`http://127.0.0.1:${address.port}/v1/pair/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const json = (await res.json()) as { exp: number }
      const nowSeconds = Math.floor(Date.now() / 1000)
      expect(json.exp).toBeGreaterThan(nowSeconds)
      expect(json.exp).toBeLessThan(nowSeconds + 2 * 24 * 60 * 60)
      expect(json.exp * 1000 - Date.now()).toBeLessThan(2 ** 31 - 1)
    } finally {
      await hub.close()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
