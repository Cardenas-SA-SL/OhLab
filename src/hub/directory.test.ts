import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import nacl from 'tweetnacl'
import { WebSocket } from 'ws'
import { HubDirectory } from './directory'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function authenticate(directory: HubDirectory, keys: nacl.BoxKeyPair, name: string) {
  const publicKeyB64 = Buffer.from(keys.publicKey).toString('base64')
  const challenge = directory.issueChallenge(publicKeyB64)
  const proof = nacl.box.open(
    Buffer.from(challenge.boxB64, 'base64'),
    Buffer.from(challenge.nonceB64, 'base64'),
    Buffer.from(challenge.hubPublicKeyB64, 'base64'),
    keys.secretKey
  )
  if (!proof) throw new Error('test challenge did not open')
  return directory.authenticate({
    name,
    publicKeyB64,
    challengeId: challenge.challengeId,
    proofB64: Buffer.from(proof).toString('base64')
  })
}

describe('HubDirectory account identity', () => {
  it('updates the account name when an existing peer key registers again', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-directory-'))
    dirs.push(dataDir)
    const directory = new HubDirectory(dataDir)
    await directory.init()
    const keys = nacl.box.keyPair()

    const first = await authenticate(directory, keys, 'Someone')
    const renamed = await authenticate(directory, keys, 'Sebastián')

    expect(renamed.account).toMatchObject({ accountId: first.account.accountId, name: 'Sebastián' })
    expect(directory.accountForSession(first.sessionToken)?.name).toBe('Sebastián')
  })
})

/** The slice of a `ws` socket the directory touches: readyState, send, and the close event. */
function fakeSocket(): { ws: WebSocket; sent: string[]; close: () => void } {
  const sent: string[] = []
  const emitter = new EventEmitter() as EventEmitter & { readyState: number; send: (data: string) => void }
  emitter.readyState = WebSocket.OPEN
  emitter.send = (data) => { sent.push(data) }
  return {
    ws: emitter as unknown as WebSocket,
    sent,
    close: () => {
      emitter.readyState = WebSocket.CLOSED
      emitter.emit('close')
    }
  }
}

describe('HubDirectory presence links', () => {
  it('shapes a pushed event per socket, so each of a member\'s connections is told its own relay URL', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-directory-'))
    dirs.push(dataDir)
    const directory = new HubDirectory(dataDir)
    await directory.init()
    const { account } = await authenticate(directory, nacl.box.keyPair(), 'Member')
    const lan = fakeSocket()
    const tailscale = fakeSocket()
    directory.attach(account.accountId, lan.ws, { relayUrl: 'ws://192.168.1.128:8791/relay' })
    directory.attach(account.accountId, tailscale.ws, { relayUrl: 'ws://100.72.1.5:8791/relay' })
    expect(directory.isOnline(account.accountId)).toBe(true)

    const delivered = directory.push(account.accountId, (link) => ({
      type: 'session-request',
      projectId: 'p1',
      fromAccountId: 'caller',
      fromPublicKeyB64: 'caller-key',
      pairingToken: 'token',
      relayUrl: link.relayUrl,
      machineLabel: "Caller's Mac"
    }))
    expect(delivered).toBe(true)
    expect(lan.sent.map((raw) => JSON.parse(raw))).toEqual([expect.objectContaining({ type: 'session-request', relayUrl: 'ws://192.168.1.128:8791/relay' })])
    expect(tailscale.sent.map((raw) => JSON.parse(raw))).toEqual([expect.objectContaining({ type: 'session-request', relayUrl: 'ws://100.72.1.5:8791/relay' })])

    lan.close()
    expect(directory.isOnline(account.accountId)).toBe(true)
    expect(directory.push(account.accountId, { type: 'member-online', accountId: 'x' })).toBe(true)
    expect(lan.sent).toHaveLength(1)
    expect(tailscale.sent).toHaveLength(2)
    tailscale.close()
    expect(directory.isOnline(account.accountId)).toBe(false)
    expect(directory.push(account.accountId, { type: 'member-online', accountId: 'x' })).toBe(false)
  })
})
