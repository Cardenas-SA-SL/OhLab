export interface HubInvite {
  v: 1
  hub: string
  project: string
  code: string
  name: string
}

export const HUB_INVITE_PREFIX = 'ohlab-invite:'
const MAX_INVITE_INPUT = 8192
const MAX_FIELD = 1024

function base64UrlEncode(value: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'utf8').toString('base64url')
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function base64UrlDecode(value: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  try {
    if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64url').toString('utf8')
    const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
    const binary = atob(padded)
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
  } catch { return null }
}

export function inviteUrl(invite: HubInvite): string {
  const query = new URLSearchParams({ v: '1', hub: invite.hub, project: invite.project, code: invite.code, name: invite.name })
  return `ohlab://join?${query.toString()}`
}

export function encodeHubInvite(invite: HubInvite): string {
  return HUB_INVITE_PREFIX + base64UrlEncode(inviteUrl(invite))
}

export function decodeHubInvite(input: string): HubInvite | null {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > MAX_INVITE_INPUT) return null
  const raw = trimmed.startsWith(HUB_INVITE_PREFIX)
    ? base64UrlDecode(trimmed.slice(HUB_INVITE_PREFIX.length))
    : trimmed
  if (!raw || raw.length > MAX_INVITE_INPUT) return null
  try {
    const url = new URL(raw)
    const hub = url.searchParams.get('hub') ?? ''
    const project = url.searchParams.get('project') ?? ''
    const code = url.searchParams.get('code') ?? ''
    const name = url.searchParams.get('name') ?? ''
    if (url.protocol !== 'ohlab:' || url.hostname !== 'join' || url.searchParams.get('v') !== '1') return null
    if (!hub || !project || !code || [hub, project, code, name].some((v) => v.length > MAX_FIELD)) return null
    const parsedHub = new URL(hub)
    if (!['http:', 'https:'].includes(parsedHub.protocol)) return null
    return { v: 1, hub: parsedHub.toString().replace(/\/$/, ''), project, code, name }
  } catch { return null }
}

/** Extract the first valid invite from an Electron argv handoff or macOS open-url event. */
export function inviteFromLaunchArgs(args: readonly string[]): string | null {
  for (const arg of args) if (decodeHubInvite(arg)) return arg
  return null
}
