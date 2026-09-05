// Ceilings and budgets that keep the Hub's front door bounded (security review, finding 1).
//
// Every token, challenge and account endpoint is reachable WITHOUT a credential: that is the
// design (a fresh installation has nothing to present yet), so on an internet-exposed Hub the only
// thing standing between a script in a loop and an OOM is the arithmetic in this file. Each number
// is a ceiling a small team never reaches, not a tuning knob - a legitimate desktop mints one
// challenge and one session per boot, one standing-host token per day, and a handful of pair
// tokens per session it opens. Raise them through `HubConfig.limits` for a bigger deployment.

export interface RateLimitPolicy {
  /** Requests a client may burst before the bucket is dry. */
  capacity: number
  /** Sustained requests per second the bucket refills at. */
  refillPerSecond: number
}

export interface HubLimits {
  /** Per-client budget for every non-GET HTTP request: the unauthenticated mints (pair/host/device
   *  tokens, challenge, register) and every authenticated write, which each rewrite a whole file. */
  writeRate: RateLimitPolicy
  /** Per-client budget for WebSocket upgrades (`/relay` and `/dir`). */
  upgradeRate: RateLimitPolicy
  /** Distinct client addresses the limiters remember at once; the least recently seen is dropped
   *  past this (a dropped client comes back with a FULL bucket, so eviction never punishes it). */
  rateLimitKeys: number
  /** Hard ceiling on how long a request body may take to arrive (a slow-loris POST). */
  bodyTimeoutMs: number
  /** Node's own header/request timeouts. Neither touches an upgraded WebSocket: the parser
   *  releases the socket on upgrade, so a relay bridge can stay open for days. */
  headersTimeoutMs: number
  requestTimeoutMs: number
  /** Live (unexpired, unconsumed) relay tokens: overall, and per issuing client address. */
  maxTokens: number
  maxTokensPerIssuer: number
  /** Live device tokens (365-day TTL - the worst accumulator): overall and per issuing address. */
  maxDevices: number
  maxDevicesPerIssuer: number
  /** Issued-but-unanswered key challenges: overall and per issuing address. */
  maxChallenges: number
  maxChallengesPerIssuer: number
  /** Live sessions one account may hold; the oldest is evicted past this. */
  maxSessionsPerAccount: number
  maxAccounts: number
  maxProjects: number
  maxProjectsPerAccount: number
}

export const DEFAULT_HUB_LIMITS: HubLimits = {
  writeRate: { capacity: 30, refillPerSecond: 0.5 },
  upgradeRate: { capacity: 60, refillPerSecond: 1 },
  rateLimitKeys: 10_000,
  bodyTimeoutMs: 10_000,
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 15_000,
  maxTokens: 10_000,
  maxTokensPerIssuer: 100,
  maxDevices: 2_000,
  maxDevicesPerIssuer: 50,
  maxChallenges: 5_000,
  maxChallengesPerIssuer: 30,
  maxSessionsPerAccount: 32,
  maxAccounts: 200,
  maxProjects: 1_000,
  maxProjectsPerAccount: 100
}

export function resolveHubLimits(overrides?: Partial<HubLimits>): HubLimits {
  const limits: HubLimits = { ...DEFAULT_HUB_LIMITS, ...(overrides ?? {}) }
  for (const [key, value] of Object.entries(limits) as Array<[keyof HubLimits, unknown]>) {
    if (typeof value === 'number' && !(Number.isFinite(value) && value > 0)) {
      throw new Error(`hub limit ${key} must be a positive number`)
    }
  }
  for (const policy of [limits.writeRate, limits.upgradeRate]) {
    if (!(policy.capacity > 0) || !(policy.refillPerSecond >= 0)) {
      throw new Error('hub rate policy must have capacity > 0 and refillPerSecond >= 0')
    }
  }
  return limits
}

/** A ceiling was reached. Answered as 429 so a well-behaved client backs off instead of retrying
 *  in a tight loop, and never as 500 (a full Hub is a policy outcome, not a crash). */
export class HubLimitError extends Error {
  readonly status = 429
  constructor(message: string) {
    super(message)
    this.name = 'HubLimitError'
  }
}
