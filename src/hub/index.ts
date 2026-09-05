import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { constantTimeEqual } from './auth'
import { HubDirectory, type DirectoryLink } from './directory'
import { HubLimitError, resolveHubLimits, type HubLimits } from './limits'
import { createRateLimiter } from './rate-limit'
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
  /** Ceilings and per-client budgets; see `DEFAULT_HUB_LIMITS`. Partial overrides are merged. */
  limits?: Partial<HubLimits>
  /** Behind a reverse proxy, take the client address from `x-forwarded-for` (its FIRST entry).
   *  Off by default: honouring that header from an unproxied client would let it spoof any
   *  address it likes and step around every per-client ceiling. */
  trustProxy?: boolean
  /** Clock seam for tests. */
  now?: () => number
  /** How often expired tokens, challenges and sessions are dropped. */
  sweepIntervalMs?: number
}

export interface Hub {
  listen(): Promise<AddressInfo>
  close(): Promise<void>
  address(): AddressInfo | null
  /** Raw row counts of the in-memory stores, expired rows included: what the sweep has left. */
  stats(): HubStats
}

export interface HubStats {
  tokens: number
  devices: number
  challenges: number
  sessions: number
  accounts: number
  projects: number
}

const MAX_JSON_BYTES = 1024 * 1024
const DEFAULT_SWEEP_MS = 60_000

/** The body did not arrive within the deadline (a slow-loris POST holding a socket). */
class BodyTimeoutError extends Error {
  readonly status = 408
  constructor() {
    super('request body timed out')
    this.name = 'BodyTimeoutError'
  }
}

class BodyTooLargeError extends Error {
  readonly status = 413
  constructor() {
    super('request body is too large')
    this.name = 'BodyTooLargeError'
  }
}

function send(res: ServerResponse, status: number, value?: unknown, headers: Record<string, string> = {}): void {
  if (value === undefined) {
    res.writeHead(status, headers).end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers }).end(JSON.stringify(value))
}

/** Read and parse a JSON object body, bounded in SIZE (1 MiB) and in TIME (`bodyTimeoutMs`). The
 *  time bound is the one that matters against a hostile client: a peer that sends the headers and
 *  then one byte a minute used to hold a socket for as long as it liked. */
function readJson(req: IncomingMessage, bodyTimeoutMs: number): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return Promise.reject(new BodyTooLargeError())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (run: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      run()
    }
    const timer = setTimeout(() => settle(() => reject(new BodyTimeoutError())), bodyTimeoutMs)
    const onData = (raw: Buffer | string): void => {
      const chunk = Buffer.from(raw)
      size += chunk.length
      if (size > MAX_JSON_BYTES) {
        settle(() => reject(new BodyTooLargeError()))
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => settle(() => {
      try {
        if (size === 0) {
          resolve({})
          return
        }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required')
        resolve(value as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    const onError = (error: Error): void => settle(() => reject(error))
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
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

function normalizeIp(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

/** The address every per-client ceiling is keyed on. Only a Hub told it sits behind a proxy reads
 *  `x-forwarded-for`, and then only its first (client-most) entry. */
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()
    if (forwarded) return normalizeIp(forwarded)
  }
  return normalizeIp(req.socket.remoteAddress ?? 'unknown')
}

function retryAfterSeconds(retryAfterMs: number): string {
  return String(Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs / 1000)) : 3600)
}

/** Refuse a WebSocket upgrade with a plain HTTP status. The `ws` client surfaces it as
 *  "Unexpected server response: 429", which is the right story for a client that is being told to
 *  slow down; a bare `socket.destroy()` would read as a network fault and invite a tight retry. */
function refuseUpgrade(socket: Duplex, status: number, reason: string, headers: Record<string, string> = {}): void {
  const lines = [`HTTP/1.1 ${status} ${reason}`, 'Connection: close', 'Content-Length: 0']
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`)
  socket.end(`${lines.join('\r\n')}\r\n\r\n`)
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
  const now = config.now ?? Date.now
  const limits = resolveHubLimits(config.limits)
  const trustProxy = config.trustProxy === true
  const tokens = new HubTokenStore(config.dataDir, now, limits)
  const directory = new HubDirectory(config.dataDir, now, limits)
  const relay = createRelay(tokens, log)
  const directoryWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
  // Two budgets, because the two doors cost different things: an HTTP write mints or rewrites a
  // file, an upgrade parks a socket. GETs are answered from memory and stay unmetered.
  const writeLimiter = createRateLimiter(limits.writeRate, { now, maxKeys: limits.rateLimitKeys })
  const upgradeLimiter = createRateLimiter(limits.upgradeRate, { now, maxKeys: limits.rateLimitKeys })
  let initialized = false

  // Slow headers and slow bodies are cut by Node itself as well; the explicit body deadline in
  // `readJson` is the precise one, these are the backstop for any request that never reaches it.
  // Neither touches an upgraded WebSocket (the parser hands the socket over on upgrade).
  const server = createServer({
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    connectionsCheckingInterval: Math.max(100, Math.min(30_000, Math.floor(limits.requestTimeoutMs / 2)))
  }, async (req, res) => {
    const url = routeUrl(req)
    const method = req.method ?? 'GET'
    const ip = clientIp(req, trustProxy)
    try {
      if (method === 'GET' && url.pathname === '/healthz') {
        send(res, 200, { ok: true, name: 'OhLab Hub', version: config.version ?? '0.3.4' })
        return
      }

      if (method !== 'GET') {
        // Metered BEFORE the body is read: a refused client must not be able to make the Hub
        // buffer a megabyte first.
        const budget = writeLimiter.take(ip)
        if (!budget.ok) {
          send(res, 429, { error: 'too many requests from this address' }, { 'retry-after': retryAfterSeconds(budget.retryAfterMs) })
          return
        }
      }
      const json = (): Promise<Record<string, unknown>> => readJson(req, limits.bodyTimeoutMs)

      if (method === 'POST' && url.pathname === '/v1/pair/token') {
        const body = await json()
        // A caller-chosen room is never honoured here (security review, finding 2): a host's room
        // id is derived from its PUBLIC key, so anyone could compute a victim's and squat it. A
        // standing host mints from /v1/relay/host-token, which derives the room from the key it
        // presents. Refused rather than silently downgraded to a pair token, so a client that
        // still asks learns why its host never gets bridged.
        if (body.standing !== undefined || body.hostId !== undefined) {
          throw new Error('standing-host tokens are minted from /v1/relay/host-token; /v1/pair/token accepts no room id')
        }
        const requestedTtl = Number(body.ttlMs)
        const ttl = Number.isFinite(requestedTtl) ? Math.min(Math.max(requestedTtl, 1), 24 * 60 * 60 * 1000) : undefined
        const item = await tokens.mintPair(ttl, ip)
        send(res, 201, { pairingId: item.pairingId, pairingToken: item.token, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/host-token') {
        const body = await json()
        if (typeof body.hostPublicKeyB64 !== 'string') throw new Error('hostPublicKeyB64 is required')
        const id = hostId(body.hostPublicKeyB64)
        const item = await tokens.mintStandingHost(id, undefined, ip)
        send(res, 201, { pairingToken: item.token, hostId: id, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/device') {
        const body = await json()
        if (typeof body.hostPublicKeyB64 !== 'string') throw new Error('hostPublicKeyB64 is required')
        const item = await tokens.registerDevice(
          hostId(body.hostPublicKeyB64),
          typeof body.deviceId === 'string' ? body.deviceId : undefined,
          typeof body.priorDeviceToken === 'string' ? body.priorDeviceToken : undefined,
          ip
        )
        send(res, 201, item)
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/join') {
        const body = await json()
        const deviceToken = String(body.deviceToken ?? body.token ?? '')
        const device = tokens.device(deviceToken)
        if (!device) {
          send(res, 401, { error: 'unknown or expired device token' })
          return
        }
        const item = await tokens.mintStandingClient(device.hostId, undefined, ip)
        send(res, 201, { pairingToken: item.token, hostId: device.hostId, exp: expSeconds(item.exp) })
        return
      }

      if (method === 'POST' && url.pathname === '/v1/relay/device/revoke') {
        const body = await json()
        await tokens.revokeDevice(String(body.deviceToken ?? body.deviceId ?? ''))
        send(res, 204)
        return
      }

      if (method === 'POST' && url.pathname === '/v1/accounts/challenge') {
        const body = await json()
        send(res, 201, directory.issueChallenge(String(body.publicKeyB64 ?? ''), ip))
        return
      }

      if (method === 'POST' && (url.pathname === '/v1/accounts/register' || url.pathname === '/v1/accounts/session')) {
        const body = await json()
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
        if (!config.adminToken || !constantTimeEqual(bearer(req), config.adminToken)) {
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
        const body = await json()
        return send(res, 201, await directory.createProject(
          account!.accountId,
          String(body.name ?? ''),
          typeof body.projectId === 'string' ? body.projectId : undefined
        ))
      }
      if (method === 'POST' && url.pathname === '/v1/projects/join') {
        const body = await json()
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
      const sharing = /^\/v1\/projects\/([^/]+)\/sharing$/.exec(url.pathname)
      if (method === 'POST' && sharing) {
        const body = await json()
        return send(res, 200, await directory.setSharing(decodeURIComponent(sharing[1]), account!.accountId, body.sharing === true))
      }
      const connect = /^\/v1\/projects\/([^/]+)\/connect$/.exec(url.pathname)
      if (method === 'POST' && connect) {
        const body = await json()
        const projectId = decodeURIComponent(connect[1])
        const toAccountId = String(body.toAccountId ?? '')
        // The label the TARGET shows for the caller's machine is the one the caller REGISTERED
        // (its hostname, `Account.machineLabel`) — never a label the caller's renderer typed for
        // itself. The renderer's own word for its machine is "this Mac"/"this PC", which is true
        // on the caller's screen and wrong on everyone else's: that is how a delivered envelope
        // read "on This Mac". The body's label is only a fallback for a caller that never
        // registered one.
        const machineLabel = String(account!.machineLabel || body.machineLabel || `${account!.name}'s computer`)
          .replace(/[\r\n\t]+/g, ' ')
          .trim()
          .slice(0, 80) || `${account!.name}'s computer`
        const peers = directory.approvedPeers(projectId, account!.accountId, toAccountId)
        if (!directory.isOnline(toAccountId)) return send(res, 409, { error: 'member is offline' })
        // Each party gets the relay through the address IT dialled the Hub on: the caller's response
        // carries the Host of this request, the target's `session-request` the Host of its own `/dir`
        // socket. An embedded Hub is loopback to its owner and a LAN/Tailscale IP to everyone else.
        const callerRelayUrl = relayUrl(req)
        const item = await tokens.mintPair(undefined, ip)
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
      if (error instanceof BodyTimeoutError || error instanceof BodyTooLargeError) {
        // `connection: close` makes Node destroy the socket once this answer has flushed
        // (`destroySoon`), which is the whole point against a slow-loris; the timer is the
        // backstop for a peer that never reads its answer either.
        send(res, error.status, { error: message }, { connection: 'close' })
        setTimeout(() => req.socket.destroy(), 2000).unref()
        return
      }
      if (error instanceof HubLimitError) {
        send(res, error.status, { error: message })
        return
      }
      const denied = /owner|required|approved project member|project not found/.test(message)
      send(res, denied ? 403 : 400, { error: message })
    }
  })

  server.on('upgrade', (req, socket, head) => {
    const url = routeUrl(req)
    if (url.pathname !== '/relay' && url.pathname !== '/dir') {
      socket.destroy()
      return
    }
    const budget = upgradeLimiter.take(clientIp(req, trustProxy))
    if (!budget.ok) {
      refuseUpgrade(socket, 429, 'Too Many Requests', { 'Retry-After': retryAfterSeconds(budget.retryAfterMs) })
      return
    }
    if (url.pathname === '/relay') {
      relay.handleUpgrade(req, socket, head)
      return
    }
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
  })

  // The periodic sweep (security review, finding 1). Before it, an expired token, challenge or
  // session was only ever dropped when something looked it up again, so a mint nobody redeemed
  // lived for the life of the process and rode every later file rewrite. Unref'd: a Hub that is
  // closing must not be kept alive by its own housekeeping.
  const sweep = setInterval(() => {
    void tokens.sweep().catch((error: unknown) => log(`[hub] token sweep failed: ${error instanceof Error ? error.message : String(error)}`))
    directory.sweep()
    writeLimiter.sweep()
    upgradeLimiter.sweep()
  }, config.sweepIntervalMs ?? DEFAULT_SWEEP_MS)
  sweep.unref()

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
      clearInterval(sweep)
      relay.close()
      for (const ws of directoryWss.clients) ws.close(1001, 'hub shutting down')
      directoryWss.close()
      if (!server.listening) return
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    },
    address() {
      const value = server.address()
      return value && typeof value !== 'string' ? value : null
    },
    stats() {
      return { ...tokens.size(), ...directory.size() }
    }
  }
}

export type { Account, DirectoryEvent, ProjectMember, SharedProject } from './directory'
export { DEFAULT_HUB_LIMITS, type HubLimits } from './limits'
