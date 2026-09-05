import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { HubClient } from './client'

class FakeSocket {
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  close = vi.fn()
  on(event: string, callback: (...args: unknown[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback])
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(event) ?? []) callback(...args)
  }
}

describe('HubClient', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('proves possession of the peer box key and preserves a local project id', async () => {
    const keys = nacl.box.keyPair()
    const hubKeys = nacl.box.keyPair()
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const challenge = nacl.randomBytes(32)
    const boxed = nacl.box(challenge, nonce, keys.publicKey, hubKeys.secretKey)
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>
      calls.push({ url: input, body })
      if (input.endsWith('/v1/accounts/challenge')) {
        return new Response(JSON.stringify({
          challengeId: 'challenge-1',
          hubPublicKeyB64: Buffer.from(hubKeys.publicKey).toString('base64'),
          nonceB64: Buffer.from(nonce).toString('base64'),
          boxB64: Buffer.from(boxed).toString('base64')
        }), { status: 201 })
      }
      if (input.endsWith('/v1/accounts/register')) {
        expect(body.proofB64).toBe(Buffer.from(challenge).toString('base64'))
        return new Response(JSON.stringify({ account: { accountId: 'a1', name: 'Ada' }, sessionToken: 'session-1' }), { status: 201 })
      }
      return new Response(JSON.stringify({ projectId: body.projectId, name: body.name }), { status: 201 })
    }))
    const socket = new FakeSocket()
    const client = new HubClient({
      hubUrl: 'http://hub.test:8791', accountName: 'Ada', keys,
      webSocket: () => {
        queueMicrotask(() => socket.emit('open'))
        return socket
      }
    })

    expect(await client.start()).toMatchObject({ state: 'connected', accountId: 'a1' })
    await client.createProject('Demo', 'local-project')
    expect(calls.at(-1)?.body).toEqual({ name: 'Demo', projectId: 'local-project' })
    client.stop()
  })

  it('re-proves the key once and retries when a Hub restart turned the session into a 401', async () => {
    const keys = nacl.box.keyPair()
    const hubKeys = nacl.box.keyPair()
    const nonce = nacl.randomBytes(nacl.box.nonceLength)
    const challenge = nacl.randomBytes(32)
    const boxed = nacl.box(challenge, nonce, keys.publicKey, hubKeys.secretKey)
    let registrations = 0
    const authHeaders: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      if (input.endsWith('/v1/accounts/challenge')) {
        return new Response(JSON.stringify({
          challengeId: 'challenge-1',
          hubPublicKeyB64: Buffer.from(hubKeys.publicKey).toString('base64'),
          nonceB64: Buffer.from(nonce).toString('base64'),
          boxB64: Buffer.from(boxed).toString('base64')
        }), { status: 201 })
      }
      if (input.endsWith('/v1/accounts/register')) {
        registrations++
        return new Response(JSON.stringify({ account: { accountId: 'a1', name: 'Ada' }, sessionToken: `session-${registrations}` }), { status: 201 })
      }
      const auth = String((init.headers as Record<string, string>).authorization ?? '')
      authHeaders.push(auth)
      // The Hub restarted: only the session minted after the restart is known to it.
      if (auth !== 'Bearer session-2') return new Response(JSON.stringify({ error: 'session authorization required' }), { status: 401 })
      return new Response(JSON.stringify([]), { status: 200 })
    }))
    const socket = new FakeSocket()
    const client = new HubClient({
      hubUrl: 'http://hub.test:8791', accountName: 'Ada', keys,
      webSocket: () => {
        queueMicrotask(() => socket.emit('open'))
        return socket
      }
    })
    await client.start()

    await expect(client.listProjects()).resolves.toEqual([])
    expect(registrations).toBe(2)
    expect(authHeaders).toEqual(['Bearer session-1', 'Bearer session-2'])

    // A second 401 in a row is a real refusal, not a lost session: no third registration.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })))
    await expect(client.listProjects()).rejects.toThrow('nope')
    client.stop()
  })

  it('refuses to register a placeholder identity when the account name is empty', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const client = new HubClient({ hubUrl: 'http://hub.test:8791', accountName: '  ', keys: nacl.box.keyPair() })
    await expect(client.start()).resolves.toMatchObject({
      state: 'error',
      error: 'Enter an account name before connecting to the Hub.'
    })
    expect(fetch).not.toHaveBeenCalled()
    client.stop()
  })
})
