// Trust-on-first-use pins of Hub members' public keys (security review, finding 3).
//
// The Hub is the directory: the desktop learns "member X has key K" from it and nothing else, and
// the brokered session flow auto-confirms the SAS on both ends, so a compromised Hub could hand
// each side a key IT controls and sit in the middle of an "end-to-end encrypted" tunnel. This
// store is the defence in depth the manual pairing flow gets from the human SAS comparison: the
// first time a member's key is seen it is PINNED against that member's account id, and from then
// on a different key for the same account is refused - the Hub gets to introduce a member once,
// never to replace them. A key that changed for real (a reinstall) shows up as a NEW account on
// the Hub, which the owner re-approves; a changed key on the SAME account id is exactly the
// substitution this exists to catch, and is never adopted silently.
//
// Pure functions over the persisted shape, so the rule is unit-testable; the disk wrapper lives in
// src/main/hub-member-pins.ts. These are PUBLIC keys, never credentials.

export interface MemberPin {
  accountId: string
  publicKeyB64: string
  /** The Hub the account belongs to, for the human reading the file. Not part of the key. */
  hubUrl: string
  pinnedAt: number
}

export interface MemberPins {
  pins: MemberPin[]
}

export type MemberKeyVerdict = 'new' | 'match' | 'mismatch'

export function emptyMemberPins(): MemberPins {
  return { pins: [] }
}

/** Coerce arbitrary parsed JSON into a well-formed store (drops malformed rows, keeps the first
 *  row per account so a corrupt duplicate can never widen trust). */
export function parseMemberPins(raw: unknown): MemberPins {
  if (!raw || typeof raw !== 'object') return emptyMemberPins()
  const pins = (raw as { pins?: unknown }).pins
  if (!Array.isArray(pins)) return emptyMemberPins()
  const seen = new Set<string>()
  const out: MemberPin[] = []
  for (const item of pins) {
    if (!item || typeof item !== 'object') continue
    const { accountId, publicKeyB64, hubUrl, pinnedAt } = item as Record<string, unknown>
    if (typeof accountId !== 'string' || !accountId || typeof publicKeyB64 !== 'string' || !publicKeyB64) continue
    if (seen.has(accountId)) continue
    seen.add(accountId)
    out.push({
      accountId,
      publicKeyB64,
      hubUrl: typeof hubUrl === 'string' ? hubUrl : '',
      pinnedAt: typeof pinnedAt === 'number' && Number.isFinite(pinnedAt) ? pinnedAt : 0
    })
  }
  return { pins: out }
}

/** What the store says about `publicKeyB64` for `accountId`: never seen (`new`), the pinned key
 *  (`match`), or a DIFFERENT key than the one pinned (`mismatch`). An empty id or key is a
 *  mismatch: nothing may be trusted on the strength of a blank. */
export function memberKeyVerdict(store: MemberPins, accountId: string, publicKeyB64: string): MemberKeyVerdict {
  if (!accountId || !publicKeyB64) return 'mismatch'
  const pin = store.pins.find((item) => item.accountId === accountId)
  if (!pin) return 'new'
  return pin.publicKeyB64 === publicKeyB64 ? 'match' : 'mismatch'
}

/** Pin `publicKeyB64` for `accountId`. Idempotent for the same key (returns the same object), and
 *  it REFUSES to overwrite a different one: a mismatch is reported by `memberKeyVerdict` and must
 *  be resolved by removing the member, never by a write that quietly adopts the new key. */
export function pinMemberKey(store: MemberPins, pin: { accountId: string; publicKeyB64: string; hubUrl: string }, now = Date.now()): MemberPins {
  const verdict = memberKeyVerdict(store, pin.accountId, pin.publicKeyB64)
  if (verdict !== 'new') return store
  return { pins: [...store.pins, { ...pin, pinnedAt: now }] }
}

/** Forget an account's pin (the member was removed). Idempotent. */
export function unpinMember(store: MemberPins, accountId: string): MemberPins {
  if (!store.pins.some((item) => item.accountId === accountId)) return store
  return { pins: store.pins.filter((item) => item.accountId !== accountId) }
}
