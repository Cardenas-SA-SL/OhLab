// Pairing-offer codec for the relay transport.
//
// Encodes/decodes the `nodeterm://pair` offer. Pure functions: no sockets, no
// Electron, and no zod — validation is hand-rolled so decode never throws
// (returns null instead).

export type PairingOffer = {
  // The relay WebSocket endpoint the client connects to.
  relayEndpoint: string
  // Single-use token authorizing this pairing on the relay.
  pairingToken: string
  // The host's Curve25519 public key, base64-encoded. The client uses this to
  // derive the shared secret via ECDH for end-to-end encryption.
  hostPublicKeyB64: string
}

export type HubConnectResult = {
  relayUrl: string
  pairingToken: string
  toPublicKeyB64: string
}

const SCHEME_PREFIX = 'nodeterm://pair?code='

export function encodeOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const code = Buffer.from(json, 'utf-8').toString('base64url')
  // Why: query params survive custom-scheme deep links / camera intents more
  // reliably than URL fragments.
  return `${SCHEME_PREFIX}${code}`
}

/** Translate the Hub directory's connect response at the one product boundary that consumes it.
 * Validate the encoded result immediately so a missing/unsafe Hub field is reported here rather
 * than later as the relay client's generic "pairing code is invalid" error. */
export function encodeHubConnectOffer(result: HubConnectResult): string {
  const encoded = encodeOffer({
    relayEndpoint: result.relayUrl,
    pairingToken: result.pairingToken,
    hostPublicKeyB64: result.toPublicKeyB64
  })
  if (!decodeOffer(encoded)) throw new Error('The Hub returned an invalid or unreachable relay offer.')
  return encoded
}

// Decode either a full `nodeterm://pair?code=…` URL or a bare base64url code.
// Returns null on any malformed / incomplete input — never throws.
export function decodeOffer(code: string): PairingOffer | null {
  const trimmed = code.trim()
  if (!trimmed) {
    return null
  }
  const raw = extractCode(trimmed)
  if (raw === null) {
    return null
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8')
    const parsed = JSON.parse(json) as unknown
    return isPairingOffer(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Pull the base64url code out of a `nodeterm://pair?code=…` URL, or treat the
// input as a bare code if it carries no scheme.
function extractCode(input: string): string | null {
  if (input.includes('://')) {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      return null
    }
    if (parsed.protocol !== 'nodeterm:' || parsed.hostname !== 'pair') {
      return null
    }
    if (parsed.pathname !== '' && parsed.pathname !== '/') {
      return null
    }
    return parsed.searchParams.get('code')
  }
  return input
}

// R5: the client connects to `relayEndpoint` verbatim, so an attacker-crafted offer must not
// be able to point it at an arbitrary plaintext (or non-WebSocket) endpoint. TLS is required for
// public addresses. Plaintext `ws://` is limited to loopback and non-public networks because the
// embedded self-hosted Hub deliberately advertises its LAN/Tailscale IPv4 address to teammates.
// Tunnel frames remain E2EE; this allowance only makes that private-network transport reachable.
function isAllowedRelayEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol === 'wss:') return true
  if (url.protocol === 'ws:') {
    const h = url.hostname
    return isPrivateRelayHost(h)
  }
  return false
}

function isPrivateRelayHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (h === 'localhost' || h === '::1' || h === '[::1]') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (ipv4) {
    const octets = ipv4.slice(1).map(Number)
    if (octets.some((part) => part > 255)) return false
    const [a, b] = octets
    return a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || a === 192 && b === 168 ||
      (a === 100 && b >= 64 && b <= 127)
  }
  const ipv6 = h.replace(/^\[|\]$/g, '')
  return /^f[cd][0-9a-f]*:/i.test(ipv6) || /^fe[89ab][0-9a-f]*:/i.test(ipv6)
}

function isPairingOffer(value: unknown): value is PairingOffer {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.relayEndpoint === 'string' &&
    isAllowedRelayEndpoint(o.relayEndpoint) &&
    typeof o.pairingToken === 'string' &&
    o.pairingToken.length > 0 &&
    typeof o.hostPublicKeyB64 === 'string' &&
    o.hostPublicKeyB64.length > 0
  )
}
