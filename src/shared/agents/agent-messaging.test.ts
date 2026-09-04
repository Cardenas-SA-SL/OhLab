import { describe, expect, it } from 'vitest'
import { memberOfflineReply } from './agent-messaging'

describe('memberOfflineReply', () => {
  it('is explicit and non-retryable when a relay member is disconnected', () => {
    expect(memberOfflineReply('Jorge')).toEqual({
      ok: false,
      error: 'memberOffline: Jorge is offline. Do not retry.',
      result: { kind: 'memberOffline', member: 'Jorge' }
    })
  })
})
