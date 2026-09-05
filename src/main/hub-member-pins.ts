// Disk wrapper for the Hub member key pins (src/core/hub/member-pins.ts holds the rule).
//
// Stored at <userData>/hub-member-pins.json, PUBLIC keys only. `assertMemberKey` is the one call
// hub-client.ts makes at each trust point (approving a member, accepting a brokered session,
// dialling a member): it pins a first-seen key and THROWS on a key that differs from the pinned
// one, so every path that would open a tunnel to a substituted key stops at the same sentence.
import { promises as fs } from 'fs'
import path from 'path'
import { app } from 'electron'
import { writeFileAtomic } from '../core/fs-atomic'
import {
  emptyMemberPins,
  memberKeyVerdict,
  parseMemberPins,
  pinMemberKey,
  unpinMember,
  type MemberKeyVerdict,
  type MemberPins
} from '../core/hub/member-pins'

function file(): string {
  return path.join(app.getPath('userData'), 'hub-member-pins.json')
}

export async function loadMemberPins(): Promise<MemberPins> {
  try {
    return parseMemberPins(JSON.parse(await fs.readFile(file(), 'utf-8')))
  } catch {
    return emptyMemberPins()
  }
}

/** Unique temp per call + retrying rename (writeFileAtomic): the three trust points can race one
 *  another (a brokered accept lands while the owner approves someone else), and a shared temp
 *  name would publish one writer's half-written list under the other's rename. */
export async function saveMemberPins(store: MemberPins): Promise<void> {
  await writeFileAtomic(file(), JSON.stringify(store, null, 2), { mode: 0o600 })
}

/** The key a member changed to differs from the one pinned earlier. Named so callers can tell it
 *  from a network failure; the message is what the human sees. */
export class HubMemberKeyChangedError extends Error {
  readonly code = 'E_HUB_MEMBER_KEY_CHANGED'
  constructor(memberName: string) {
    super(
      `${memberName}'s key differs from the one pinned when they were first trusted. ` +
        'Their session was refused. If they reinstalled OhLab, remove the member in Settings > Team and invite them again.'
    )
    this.name = 'HubMemberKeyChangedError'
  }
}

let tail: Promise<void> = Promise.resolve()

/** Check `publicKeyB64` against the pin for `accountId`: pin it when first seen, pass when it
 *  matches, throw `HubMemberKeyChangedError` when it differs. Serialised through one tail so two
 *  trust points cannot both read the pre-pin file and each pin a different key. */
export async function assertMemberKey(input: { hubUrl: string; accountId: string; publicKeyB64: string; memberName: string }): Promise<MemberKeyVerdict> {
  const run = tail.then(async () => {
    const store = await loadMemberPins()
    const verdict = memberKeyVerdict(store, input.accountId, input.publicKeyB64)
    if (verdict === 'mismatch') throw new HubMemberKeyChangedError(input.memberName)
    if (verdict === 'new') await saveMemberPins(pinMemberKey(store, input))
    return verdict
  })
  tail = run.then(() => undefined, () => undefined)
  return run
}

/** The member was removed: forget its pin, so a later re-invite starts fresh. */
export async function forgetMemberKey(accountId: string): Promise<void> {
  const run = tail.then(async () => {
    const store = await loadMemberPins()
    const next = unpinMember(store, accountId)
    if (next !== store) await saveMemberPins(next)
  })
  tail = run.then(() => undefined, () => undefined)
  return run
}
