// Does a relay URL a Hub handed us belong to THAT Hub? (security review, finding 4)
//
// The Hub builds every relay URL from the `Host` header of the request that reaches it - the
// caller's for the caller's answer, the member's own `/dir` socket for a pushed `session-request`.
// That is the right address for an honest member, and the wrong thing to trust blindly: a member
// speaking to the Hub with a raw HTTP client sets `Host:` to whatever it likes, and a proxy in the
// path rewrites it. So before the desktop opens an outbound WebSocket to a URL it was TOLD, it
// checks the URL against the Hub it authenticated to, which is the one place the URL is allowed
// to point. The interactive-offer path already enforces "wss, or ws to a private address"
// (pairing.ts); this is the stricter rule for the brokered path, where the Hub is a known origin.
//
// Pure: no I/O, never throws. Anything unparseable is refused.
import { normalizeHubUrl } from './url'

function defaultPort(protocol: string): string {
  return protocol === 'https:' || protocol === 'wss:' ? '443' : '80'
}

function portOf(url: URL): string {
  return url.port || defaultPort(url.protocol)
}

/** True when `relayUrl` is the relay endpoint of the Hub at `hubUrl`: the WebSocket twin of the
 *  Hub's scheme (`http`→`ws`, `https`→`wss`, never the other way round), the same host and port,
 *  the `/relay` path (bare, or under the Hub's base path when it is served under one), and nothing
 *  else on the URL - no credentials, no query, no fragment. */
export function relayUrlMatchesHub(relayUrl: string, hubUrl: string): boolean {
  let relay: URL
  let hub: URL
  try {
    const normalized = normalizeHubUrl(hubUrl)
    if (!normalized) return false
    hub = new URL(normalized)
    relay = new URL(relayUrl)
  } catch {
    return false
  }
  const expectedProtocol = hub.protocol === 'https:' ? 'wss:' : 'ws:'
  if (relay.protocol !== expectedProtocol) return false
  if (relay.username || relay.password || relay.search || relay.hash) return false
  if (relay.hostname !== hub.hostname) return false
  if (portOf(relay) !== portOf(hub)) return false
  const base = hub.pathname.replace(/\/+$/, '')
  return relay.pathname === '/relay' || (base !== '' && relay.pathname === `${base}/relay`)
}
