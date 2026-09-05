import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { HubDirectory, type DirectoryLink } from './directory'
import { createRelay } from './relay'
import { HubTokenStore } from './tokens'

/** Wire `exp` is UNIX SECONDS (the contract the desktop's standing host applies as `exp * 1000`);
 *  the store keeps milliseconds internally. Emitting ms here overflowed the refresh timer into a
 *  1 ms re-mint loop (36k relay connects in one session). */
function expSeconds(expMs: number): number {
  return Math.floor(expMs / 1000)
}

export interface HubConfig {
  host?: string
  port?: number
  dataDir: string
  adminToken?: string
  version?: string
  log?: (line: string) => void
}

export interface Hub {
  listen(): Promise<AddressInfo>
  close(): Promise<void>
  address(): AddressInfo | null
}

const MAX_JSON_BYTES = 1024 * 1024

function send(res: ServerResponse, status: number, value?: unknown): void {
  if (value === undefined) {
    res.writeHead(status).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }).end(JSON.stringify(value))
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const raw of req) {
    const chunk = Buffer.from(raw)
    size += chunk.length
    if (size > MAX_JSON_BYTES) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

function hostId(publicKeyB64: string): string {
  return createHash('sha256').update(publicKeyB64).digest('base64url').slice(0, 22)
}

function routeUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://hub.invalid')
}

/** The relay URL to advertise to the party that sent `req`: the Hub as THAT party reached it (its
 *  Host, honouring a TLS-terminating proxy's x-forwarded-proto), never an address chosen for it by
 *  someone else. Loopback is only ever advertised back to a loopback caller. */
function relayUrl(req: IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
  const secure = forwarded ? forwarded === 'https' : Boolean((req.socket as { encrypted?: boolean }).encrypted)
  const authority = req.headers.host?.trim()
  if (!authority) throw new Error('request Host is required to advertise the relay')
  const advertised = new URL(`${secure ? 'wss' : 'ws'}://${authority}/relay`)
  const remote = req.socket.remoteAddress ?? ''
  const remoteIsLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const advertisedIsLoopback = advertised.hostname === '127.0.0.1' || advertised.hostname === 'localhost' ||
    advertised.hostname === '::1' || advertised.hostname === '[::1]'
  if (!remoteIsLoopback && advertisedIsLoopback) {
    throw new Error('request Host must be reachable by the remote member')
  }
  return advertised.toString()
}

export function createHub(config: HubConfig): Hub {
  const log = config.log ?? console.log
  const tokens = new HubTokenStore(config.dataDir)
  const directory = new HubDirectory(config.dataDir)
  const relay = createRelay(tokens, log)
  const directoryWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  let initialized = false

  const server = createServer(async (req, res) => {
    const url = routeUrl(req)
    const method = req.method ?? 'GET'
    try {
      if (method === 'GET' && url.pathname === '/healthz') {
        send(res, 200, { ok: true, name: 'OhLab Hub', version: config.version ?? '0.3.4' })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/pair/token') {
        const body = await json(req)
        const requestedTtl = Number(body.ttlMs)
        const ttl = Number.isFinite(requestedTtl) ? Math.min(Math.max(requestedTtl, 1), 24 * 60 * 60 * 1000) : undefined
        const item = body.standing === true && typeof body.hostId === 'string'
          ? await tokens.mintStandingHost(body.hostId, ttl)
          : await tokens.mintPair(ttl)
        send(res, 201, { pairingId: item.pairingId, pairingToken: item.token, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/host-token') {
        const body = await json(req)
        if (typeof body.hostPublicKeyB64 !== 'string') throw new Error('hostPublicKeyB64 is required')
        const id = hostId(body.hostPublicKeyB64)
        const item = await tokens.mintStandingHost(id)
        send(res, 201, { pairingToken: item.token, hostId: id, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/device') {
        const body = await json(req)
        if (typeof body.hostPublicKeyB64 !== 'string') throw new Error('hostPublicKeyB64 is required')
        const item = await tokens.registerDevice(
          hostId(body.hostPublicKeyB64),
          typeof body.deviceId === 'string' ? body.deviceId : undefined,
          typeof body.priorDeviceToken === 'string' ? body.priorDeviceToken : undefined
        )
        send(res, 201, item)
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/join') {
        const body = await json(req)
        const deviceToken = String(body.deviceToken ?? body.token ?? '')
        const device = tokens.device(deviceToken)
        if (!device) {
          send(res, 401, { error: 'unknown or expired device token' })
          return
        }
        const item = await tokens.mintStandingClient(device.hostId)
        send(res, 201, { pairingToken: item.token, hostId: device.hostId, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/device/revoke') {
        const body = await json(req)
        await tokens.revokeDevice(String(body.deviceToken ?? body.deviceId ?? ''))
        send(res, 204)
        return
      }

      if (method === 'POST' && url.pathname === '/v1/accounts/challenge') {
        const body = await json(req)
        send(res, 201, directory.issueChallenge(String(body.publicKeyB64 ?? '')))
        return
      }

      if (method === 'POST' && (url.pathname === '/v1/accounts/register' || url.pathname === '/v1/accounts/session')) {
        const body = await json(req)
        const result = await directory.authenticate({
          name: typeof body.name === 'string' ? body.name : undefined,
          publicKeyB64: String(body.publicKeyB64 ?? ''),
          challengeId: String(body.challengeId ?? ''),
          proofB64: String(body.proofB64 ?? ''),
          machineLabel: typeof body.machineLabel === 'string' ? body.machineLabel : undefined
        })
        send(res, 201, result)
        return
      }

      if (url.pathname.startsWith('/v1/admin/')) {
        if (!config.adminToken || bearer(req) !== config.adminToken) {
          send(res, 401, { error: 'admin authorization required' })
          return
        }
        if (method === 'GET' && url.pathname === '/v1/admin/accounts') return send(res, 200, directory.adminAccounts())
        if (method === 'GET' && url.pathname === '/v1/admin/projects') return send(res, 200, directory.adminProjects())
        const accountDelete = /^\/v1\/admin\/accounts\/([^/]+)$/.exec(url.pathname)
        if (method === 'DELETE' && accountDelete) {
          await directory.deleteAccount(decodeURIComponent(accountDelete[1]))
          return send(res, 204)
        }
        const projectDelete = /^\/v1\/admin\/projects\/([^/]+)$/.exec(url.pathname)
        if (method === 'DELETE' && projectDelete) {
          await directory.deleteProject(decodeURIComponent(projectDelete[1]))
          return send(res, 204)
        }
        return send(res, 404, { error: 'not found' })
      }

      const account = directory.accountForSession(bearer(req))
      if (!account && url.pathname.startsWith('/v1/projects')) {
        send(res, 401, { error: 'session authorization required' })
        return
      }

      if (method === 'GET' && url.pathname === '/v1/projects') return send(res, 200, directory.listProjects(account!.accountId))
      if (method === 'POST' && url.pathname === '/v1/projects') {
        const body = await json(req)
        return send(res, 201, await directory.createProject(
          account!.accountId,
          String(body.name ?? ''),
          typeof body.projectId === 'string' ? body.projectId : undefined
        ))
      }
      if (method === 'POST' && url.pathname === '/v1/projects/join') {
        const body = await json(req)
        return send(res, 200, await directory.join(account!.accountId, String(body.inviteCode ?? '')))
      }

      const members = /^\/v1\/projects\/([^/]+)\/members$/.exec(url.pathname)
      if (method === 'GET' && members) return send(res, 200, directory.members(decodeURIComponent(members[1]), account!.accountId))
      const invite = /^\/v1\/projects\/([^/]+)\/invite$/.exec(url.pathname)
      if (method === 'POST' && invite) return send(res, 200, await directory.regenerateInvite(decodeURIComponent(invite[1]), account!.accountId))
      const approve = /^\/v1\/projects\/([^/]+)\/members\/([^/]+)\/approve$/.exec(url.pathname)
      if (method === 'POST' && approve) return send(res, 200, await directory.approve(decodeURIComponent(approve[1]), account!.accountId, decodeURIComponent(approve[2])))
      const remove = /^\/v1\/projects\/([^/]+)\/members\/([^/]+)$/.exec(url.pathname)
      if (method === 'DELETE' && remove) return send(res, 200, await directory.removeMember(decodeURIComponent(remove[1]), account!.accountId, decodeURIComponent(remove[2])))
      const connect = /^\/v1\/projects\/([^/]+)\/connect$/.exec(url.pathname)
      if (method === 'POST' && connect) {
        const body = await json(req)
        const projectId = decodeURIComponent(connect[1])
        const toAccountId = String(body.toAccountId ?? '')
        const machineLabel = String(body.machineLabel ?? `${account!.name}'s computer`)
          .replace(/[\r\n\t]+/g, ' ')
          .trim()
          .slice(0, 80) || `${account!.name}'s computer`
        const peers = directory.approvedPeers(projectId, account!.accountId, toAccountId)
        if (!directory.isOnline(toAccountId)) return send(res, 409, { error: 'member is offline' })
        // Each party gets the relay through the address IT dialled the Hub on: the caller's response
        // carries the Host of this request, the target's `session-request` the Host of its own `/dir`
        // socket. An embedded Hub is loopback to its owner and a LAN/Tailscale IP to everyone else.
        const callerRelayUrl = relayUrl(req)
        const item = await tokens.mintPair()
        const delivered = directory.push(toAccountId, (link) => ({
          type: 'session-request' as const,
          projectId,
          fromAccountId: account!.accountId,
          fromPublicKeyB64: peers.from.publicKeyB64,
          pairingToken: item.token,
          relayUrl: link.relayUrl,
          machineLabel
        }))
        if (!delivered) return send(res, 409, { error: 'member is offline' })
        return send(res, 201, { pairingId: item.pairingId, pairingToken: item.token, exp: expSeconds(item.exp), relayUrl: callerRelayUrl, toPublicKeyB64: peers.to.publicKeyB64 })
      }

      send(res, 404, { error: 'not found' })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed'
      const denied = /owner|required|approved project member|project not found/.test(message)
      send(res, denied ? 403 : 400, { error: message })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = routeUrl(req)
    if (url.pathname === '/relay') {
      relay.handleUpgrade(req, socket, head)
      return
    }
    if (url.pathname === '/dir') {
      const account = directory.accountForSession(url.searchParams.get('session') ?? '')
      if (!account) {
        directoryWss.handleUpgrade(req, socket, head, (ws) => ws.close(4401, 'invalid session'))
        return
      }
      // The relay URL this member can reach is fixed by how it dialled the Hub; resolve it now so a
      // later `session-request` is shaped for this socket, and refuse a socket that cannot be given
      // one (a non-loopback member behind a proxy that rewrote Host to loopback) instead of brokering
      // sessions it could never join.
      let link: DirectoryLink
      try {
        link = { relayUrl: relayUrl(req) }
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'request Host cannot be advertised'
        directoryWss.handleUpgrade(req, socket, head, (ws) => ws.close(4400, reason))
        return
      }
      directoryWss.handleUpgrade(req, socket, head, (ws) => {
        directory.attach(account.accountId, ws, link)
        ws.send(JSON.stringify({ type: 'connected', accountId: account.accountId }))
      })
      return
    }
    socket.destroy()
  })

  return {
    async listen() {
      if (!initialized) {
        await Promise.all([tokens.init(), directory.init()])
        initialized = true
      }
      if (server.listening) return server.address() as AddressInfo
      return new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error): void => reject(error)
        server.once('error', onError)
        server.listen(config.port ?? 8791, config.host ?? '0.0.0.0', () => {
          server.off('error', onError)
          resolve(server.address() as AddressInfo)
        })
      })
    },
    async close() {
      relay.close()
      for (const ws of directoryWss.clients) ws.close(1001, 'hub shutting down')
      directoryWss.close()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    address() {
      const value = server.address()
      return value && typeof value !== 'string' ? value : null
    }
  }
}

export type { Account, DirectoryEvent, ProjectMember, SharedProject } from './directory'
