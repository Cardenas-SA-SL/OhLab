import { describe, expect, it } from 'vitest'
import { decodeHubInvite, encodeHubInvite, inviteFromLaunchArgs, inviteUrl } from './hub-invite'

const invite = { v: 1 as const, hub: 'http://100.75.1.9:8791', project: 'project one', code: 'secret/code', name: 'Proyecto ñ' }

describe('hub invite codec', () => {
  it('round trips one chat-safe token and accepts its raw URL', () => {
    const encoded = encodeHubInvite(invite)
    expect(encoded).toMatch(/^ohlab-invite:[A-Za-z0-9_-]+$/)
    expect(decodeHubInvite(encoded)).toEqual(invite)
    expect(decodeHubInvite(inviteUrl(invite))).toEqual(invite)
  })
  it.each(['', 'not a code', 'ohlab-invite:!!!!', 'ohlab://join?v=2&hub=http://x&project=p&code=c', 'ohlab://join?v=1&hub=file:///tmp&project=p&code=c'])(
    'refuses malformed input %j', (value) => expect(decodeHubInvite(value)).toBeNull()
  )
  it('refuses oversized input', () => expect(decodeHubInvite('x'.repeat(8193))).toBeNull())
  it('parses a protocol launch into join-dialog state', () => {
    const raw = inviteUrl(invite)
    expect(inviteFromLaunchArgs(['/Applications/OhLab.app', '--flag', raw])).toBe(raw)
    expect(inviteFromLaunchArgs(['--flag'])).toBeNull()
  })
})
