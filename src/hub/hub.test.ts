import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
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

function opened(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
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
    const memberDir = await opened(`${ws}/dir?session=${encodeURIComponent(member.token)}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    members = await fetch(`${base}/v1/projects/${project.projectId}/members`, { headers: { authorization: `Bearer ${owner.token}` } }).then((r) => r.json()) as typeof members
    expect(members.find((item) => item.accountId === member.accountId)?.online).toBe(true)
    const request = new Promise<Record<string, unknown>>((resolve) => memberDir.on('message', (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>
      if (event.type === 'session-request') resolve(event)
    }))
    const connection = await post<{ pairingToken: string }>(base, `/v1/projects/${project.projectId}/connect`, { toAccountId: member.accountId }, owner.token)
    expect(connection.pairingToken).toHaveLength(43)
    expect((await request).fromAccountId).toBe(owner.accountId)
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
