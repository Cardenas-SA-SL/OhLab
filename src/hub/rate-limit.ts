// Per-client token buckets for the Hub's HTTP and upgrade front door (security review, finding 1).
//
// Classic token bucket: a client may burst `capacity` requests, then proceeds at `refillPerSecond`.
// Keyed by client address, so one abusive address exhausts only its own budget. Two properties are
// load-bearing and easy to lose in a rewrite:
//   - The key map is BOUNDED. An attacker holding many addresses (IPv6 hands out /64s) must not
//     be able to grow the limiter itself without bound - that would move the DoS from the token
//     store into the thing meant to stop it. Past `maxKeys` the least recently seen bucket is
//     dropped; a dropped client comes back with a FULL bucket, so eviction can only ever favour the
//     evicted (legitimate, quiet) client, never the flooder that caused it.
//   - No clock is read at rest. Buckets refill lazily on `take`, so an idle limiter costs nothing,
//     and `sweep` drops the buckets that have refilled to full - they carry no information.
import type { RateLimitPolicy } from './limits'

interface Bucket {
  tokens: number
  updatedAt: number
}

export type RateLimitDecision = { ok: true } | { ok: false; retryAfterMs: number }

export interface RateLimiter {
  /** Spend `cost` tokens from `key`'s bucket, or learn how long until it could. */
  take(key: string, cost?: number): RateLimitDecision
  /** Drop every bucket that has refilled to capacity. Returns how many were dropped. */
  sweep(): number
  /** Distinct keys currently remembered. */
  size(): number
}

export function createRateLimiter(
  policy: RateLimitPolicy,
  options: { now?: () => number; maxKeys?: number } = {}
): RateLimiter {
  const now = options.now ?? Date.now
  const maxKeys = Math.max(1, Math.floor(options.maxKeys ?? 10_000))
  const buckets = new Map<string, Bucket>()

  const refill = (bucket: Bucket, at: number): void => {
    const elapsed = at - bucket.updatedAt
    if (elapsed <= 0) return
    bucket.tokens = Math.min(policy.capacity, bucket.tokens + (elapsed * policy.refillPerSecond) / 1000)
    bucket.updatedAt = at
  }

  return {
    take(key, cost = 1) {
      const at = now()
      let bucket = buckets.get(key)
      if (bucket) {
        // Re-insert so Map order is least-recently-seen first (the eviction order below).
        buckets.delete(key)
        refill(bucket, at)
      } else {
        bucket = { tokens: policy.capacity, updatedAt: at }
      }
      buckets.set(key, bucket)
      while (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value
        if (oldest === undefined) break
        buckets.delete(oldest)
      }
      if (bucket.tokens >= cost) {
        bucket.tokens -= cost
        return { ok: true }
      }
      const deficit = cost - bucket.tokens
      const retryAfterMs = policy.refillPerSecond > 0
        ? Math.ceil((deficit * 1000) / policy.refillPerSecond)
        : Number.POSITIVE_INFINITY
      return { ok: false, retryAfterMs }
    },
    sweep() {
      const at = now()
      let dropped = 0
      for (const [key, bucket] of buckets) {
        refill(bucket, at)
        if (bucket.tokens >= policy.capacity) {
          buckets.delete(key)
          dropped++
        }
      }
      return dropped
    },
    size() {
      return buckets.size
    }
  }
}
