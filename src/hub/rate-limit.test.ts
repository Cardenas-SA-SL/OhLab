import { describe, expect, it } from 'vitest'
import { createRateLimiter } from './rate-limit'

describe('createRateLimiter', () => {
  it('lets a client burst to capacity, then refuses with the time until the next token', () => {
    let now = 0
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1 }, { now: () => now })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 1000 })
    now = 500
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: 500 })
    now = 1000
    expect(limiter.take('a')).toEqual({ ok: true })
    // Another address spends from its own bucket.
    expect(limiter.take('b')).toEqual({ ok: true })
  })

  it('never refills past capacity', () => {
    let now = 0
    const limiter = createRateLimiter({ capacity: 3, refillPerSecond: 1 }, { now: () => now })
    expect(limiter.take('a')).toEqual({ ok: true })
    now = 1_000_000
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a').ok).toBe(false)
  })

  it('refuses for good when nothing refills', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 }, { now: () => 0 })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('a')).toEqual({ ok: false, retryAfterMs: Number.POSITIVE_INFINITY })
  })

  it('bounds the addresses it remembers, dropping the least recently seen, which returns with a full bucket', () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0 }, { now: () => 0, maxKeys: 2 })
    expect(limiter.take('a')).toEqual({ ok: true })
    expect(limiter.take('b')).toEqual({ ok: true })
    // `a` is refused (dry) and becomes the most recently seen; `c` then evicts `b`, not `a`.
    expect(limiter.take('a').ok).toBe(false)
    expect(limiter.take('c')).toEqual({ ok: true })
    expect(limiter.size()).toBe(2)
    // The evicted `b` comes back with a full bucket (and in turn evicts `a`, the oldest).
    expect(limiter.take('b')).toEqual({ ok: true })
    expect(limiter.size()).toBe(2)
    // `c` was never evicted, so its bucket is still dry.
    expect(limiter.take('c').ok).toBe(false)
    expect(limiter.take('a')).toEqual({ ok: true })
  })

  it('sweeps only the buckets that have refilled to full', () => {
    let now = 0
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 1 }, { now: () => now })
    limiter.take('a')
    limiter.take('a')
    limiter.take('b')
    now = 500
    expect(limiter.sweep()).toBe(0)
    expect(limiter.size()).toBe(2)
    now = 2000
    expect(limiter.sweep()).toBe(2)
    expect(limiter.size()).toBe(0)
  })
})
