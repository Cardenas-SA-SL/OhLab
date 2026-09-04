import { describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHub } from '../../src/hub'
import { connectRelayHost } from '../../src/main/remote/relay-host'
import { connectRelayClient } from '../../src/main/remote/relay-client'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { peerRegistry } from '../../src/main/peer-registry'
import { IPC } from '../../src/shared/ipc'

describe('real Hub tunnel compatibility', () => {
  it.skipIf(process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1')('bridges the existing E2EE host and client unchanged', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ohlab-tunnel-'))
    const hub = createHub({ dataDir, host: '127.0.0.1', port: 0, log: () => {} })
    try {
      const address = await hub.listen()
      const api = `http://127.0.0.1:${address.port}`
      const url = `ws://127.0.0.1:${address.port}/relay`
      const minted = await fetch(`${api}/v1/pair/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((response) => response.json()) as { pairingToken: string }
      const hostKeys = genKeyPair()
      const clientKeys = genKeyPair()
      const responses: string[] = []
      const binary: Array<{ sessionId: string; data: string }> = []
      const clientClosed = vi.fn()
      let hostSession!: ReturnType<typeof connectRelayHost>
      let clientSession!: ReturnType<typeof connectRelayClient>
      const opened = new Promise<void>((resolve) => {
        const platform = {
          dispatch: async (_id: number, request: { id: number; args: unknown[] }) => ({ t: 'res' as const, id: request.id, ok: true as const, result: request.args[0] }),
          cast: vi.fn()
        }
        initPlatform({
          userDataDir: dataDir, appVersion: 'test', isPackaged: false,
          handle: () => {}, on: () => {}, handleWithSender: () => {}, onWithSender: () => {},
          sendTo: () => {}, broadcast: () => {}, clientIds: () => [], openExternal: async () => {}
        })
        hostSession = connectRelayHost({
          url, token: minted.pairingToken, ourKeys: hostKeys, platform: platform as never,
          onPeerPending: (session) => session.confirm(), onOpen: () => resolve(), onClose: () => {}
        })
        clientSession = connectRelayClient({
          url, token: minted.pairingToken, hostKeyB64: publicKeyToB64(hostKeys.publicKey), ourKeys: clientKeys,
          onSas: (session) => session.confirm(), onApproved: () => {}, onFrame: (frame) => responses.push(frame),
          onPtyData: (sessionId, data) => binary.push({ sessionId, data }), onClose: clientClosed
        })
      })
      await opened
      expect(hostSession.sas()).toBe(clientSession.sas())
      expect(clientSession.send(JSON.stringify({ t: 'req', id: 7, method: 'echo', args: ['hello'] }))).toBe(true)
      await vi.waitFor(() => expect(JSON.parse(responses[0])).toMatchObject({ t: 'res', id: 7, ok: true, result: 'hello' }))
      peerRegistry().sendTo(hostSession.clientId()!, IPC.ptyData('s1'), 'binary')
      await vi.waitFor(() => expect(binary).toEqual([{ sessionId: 's1', data: 'binary' }]))
      hostSession.close()
      await vi.waitFor(() => expect(clientClosed).toHaveBeenCalled())
    } finally {
      await hub.close()
      resetPlatformForTests()
      await fs.rm(dataDir, { recursive: true, force: true })
    }
  })
})
