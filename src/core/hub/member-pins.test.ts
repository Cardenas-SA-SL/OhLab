import { describe, expect, it } from 'vitest'
import { emptyMemberPins, memberKeyVerdict, parseMemberPins, pinMemberKey, unpinMember } from './member-pins'

const hub = 'http://127.0.0.1:8791'

describe('member key pins', () => {
  it('parses a stored file defensively: malformed rows dropped, the first row per account kept', () => {
    expect(parseMemberPins(null)).toEqual(emptyMemberPins())
    expect(parseMemberPins({ pins: 'nope' })).toEqual(emptyMemberPins())
    const parsed = parseMemberPins({
      pins: [
        { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub, pinnedAt: 5 },
        { accountId: 'a', publicKeyB64: 'K2', hubUrl: hub, pinnedAt: 6 },
        { accountId: '', publicKeyB64: 'K3' },
        { accountId: 'b', publicKeyB64: 7 },
        'garbage',
        { accountId: 'c', publicKeyB64: 'K4', pinnedAt: 'soon' }
      ]
    })
    expect(parsed).toEqual({
      pins: [
        { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub, pinnedAt: 5 },
        { accountId: 'c', publicKeyB64: 'K4', hubUrl: '', pinnedAt: 0 }
      ]
    })
  })

  it('answers new, match or mismatch, and trusts nothing on the strength of a blank', () => {
    const store = pinMemberKey(emptyMemberPins(), { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub }, 10)
    expect(memberKeyVerdict(store, 'a', 'K1')).toBe('match')
    expect(memberKeyVerdict(store, 'a', 'K2')).toBe('mismatch')
    expect(memberKeyVerdict(store, 'b', 'K1')).toBe('new')
    expect(memberKeyVerdict(store, '', 'K1')).toBe('mismatch')
    expect(memberKeyVerdict(store, 'a', '')).toBe('mismatch')
  })

  it('pins a first-seen key, is idempotent for the same key, and refuses to overwrite a different one', () => {
    const empty = emptyMemberPins()
    const pinned = pinMemberKey(empty, { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub }, 10)
    expect(pinned).toEqual({ pins: [{ accountId: 'a', publicKeyB64: 'K1', hubUrl: hub, pinnedAt: 10 }] })
    expect(pinMemberKey(pinned, { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub }, 20)).toBe(pinned)
    // The substitution a compromised Hub would need is never adopted by a write.
    expect(pinMemberKey(pinned, { accountId: 'a', publicKeyB64: 'K2', hubUrl: hub }, 20)).toBe(pinned)
    expect(memberKeyVerdict(pinned, 'a', 'K2')).toBe('mismatch')
  })

  it('unpins a removed member so a re-invite starts fresh', () => {
    const pinned = pinMemberKey(emptyMemberPins(), { accountId: 'a', publicKeyB64: 'K1', hubUrl: hub }, 10)
    const cleared = unpinMember(pinned, 'a')
    expect(cleared).toEqual(emptyMemberPins())
    expect(unpinMember(cleared, 'a')).toBe(cleared)
    expect(memberKeyVerdict(cleared, 'a', 'K2')).toBe('new')
  })
})
