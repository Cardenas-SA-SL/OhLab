import { describe, expect, it } from 'vitest'
import type { HubProject, HubProjectMember } from '@shared/types'
import {
  RECONNECT_DELAYS_MS,
  autoConnectTargets,
  memberCanvasState,
  reconnectDelayMs,
  shouldRetry
} from './hubAutoConnect'

const member = (over: Partial<HubProjectMember> & { accountId: string }): HubProjectMember => ({
  name: over.accountId,
  publicKeyB64: `${over.accountId}-key`,
  role: 'member',
  status: 'approved',
  joinedAt: 1,
  online: true,
  sharing: true,
  ...over
})

const project = (members: HubProjectMember[], id = 'hub-1', name = 'Horacio Team'): HubProject => ({
  projectId: id,
  name,
  ownerAccountId: 'me',
  inviteCode: 'x',
  createdAt: 1,
  members
})

const base = {
  myAccountId: 'me',
  bindings: new Map([['hub-1', 'local-1']]),
  muted: new Set<string>(),
  open: new Set<string>(),
  inFlight: new Set<string>()
}

describe('autoConnectTargets', () => {
  it('connects to every approved, online, sharing member of a bound project — never to itself', () => {
    const targets = autoConnectTargets({
      ...base,
      hubProjects: [project([
        member({ accountId: 'me', name: 'Sebastián', role: 'owner' }),
        member({ accountId: 'jorge', name: 'Jorge', machineLabel: "Jorge's MacBook" }),
        member({ accountId: 'ana', name: 'Ana' })
      ])]
    })
    expect(targets.map((t) => t.accountId)).toEqual(['jorge', 'ana'])
    expect(targets[0]).toMatchObject({
      key: 'hub-1:jorge',
      hubProjectId: 'hub-1',
      localProjectId: 'local-1',
      label: 'Horacio Team · Jorge',
      machineLabel: "Jorge's MacBook"
    })
    expect(targets[1].machineLabel).toBe("Ana's computer")
  })

  it('refuses pending, offline and not-yet-sharing members', () => {
    const targets = autoConnectTargets({
      ...base,
      hubProjects: [project([
        member({ accountId: 'pending', status: 'pending' }),
        member({ accountId: 'offline', online: false }),
        member({ accountId: 'no-side', sharing: false }),
        member({ accountId: 'legacy-hub' , sharing: undefined }),
        member({ accountId: 'ok' })
      ])]
    })
    expect(targets.map((t) => t.accountId)).toEqual(['ok'])
  })

  it('needs OUR local side too: an unbound project yields nothing', () => {
    const targets = autoConnectTargets({
      ...base,
      bindings: new Map(),
      hubProjects: [project([member({ accountId: 'jorge' })])]
    })
    expect(targets).toEqual([])
  })

  it('skips muted members and never opens a second tab for one member+project', () => {
    const projects = [project([member({ accountId: 'jorge' }), member({ accountId: 'ana' }), member({ accountId: 'luis' })])]
    const targets = autoConnectTargets({
      ...base,
      hubProjects: projects,
      muted: new Set(['hub-1:jorge']),
      open: new Set(['hub-1:ana']),
      inFlight: new Set(['hub-1:luis'])
    })
    expect(targets).toEqual([])
  })

  it('keys tabs per member AND project, so one member in two shared projects gets two tabs', () => {
    const targets = autoConnectTargets({
      ...base,
      bindings: new Map([['hub-1', 'local-1'], ['hub-2', 'local-2']]),
      hubProjects: [
        project([member({ accountId: 'jorge' })], 'hub-1', 'Alpha'),
        project([member({ accountId: 'jorge' })], 'hub-2', 'Beta')
      ]
    })
    expect(targets.map((t) => t.key)).toEqual(['hub-1:jorge', 'hub-2:jorge'])
    expect(targets.map((t) => t.label)).toEqual(['Alpha · jorge', 'Beta · jorge'])
  })

  it('does nothing before the Hub session is known', () => {
    expect(autoConnectTargets({ ...base, myAccountId: undefined, hubProjects: [project([member({ accountId: 'jorge' })])] })).toEqual([])
  })
})

describe('reconnect policy', () => {
  it('backs off on a bounded ladder and never past the last rung', () => {
    expect(reconnectDelayMs(0)).toBe(RECONNECT_DELAYS_MS[0])
    expect(reconnectDelayMs(2)).toBe(4_000)
    expect(reconnectDelayMs(99)).toBe(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1])
    expect(reconnectDelayMs(-5)).toBe(RECONNECT_DELAYS_MS[0])
  })

  it('retries only while the member still qualifies and is not muted', () => {
    const projects = [project([member({ accountId: 'jorge' })])]
    const ctx = { myAccountId: 'me', hubProjects: projects, bindings: base.bindings, muted: new Set<string>() }
    expect(shouldRetry('hub-1:jorge', 'hub-1', 'jorge', ctx)).toBe(true)
    expect(shouldRetry('hub-1:jorge', 'hub-1', 'jorge', { ...ctx, muted: new Set(['hub-1:jorge']) })).toBe(false)
    expect(shouldRetry('hub-1:jorge', 'hub-1', 'jorge', { ...ctx, hubProjects: [project([member({ accountId: 'jorge', online: false })])] })).toBe(false)
    expect(shouldRetry('hub-1:jorge', 'hub-1', 'jorge', { ...ctx, bindings: new Map() })).toBe(false)
    expect(shouldRetry('hub-1:gone', 'hub-1', 'gone', ctx)).toBe(false)
  })
})

describe('memberCanvasState', () => {
  const ctx = { myAccountId: 'me', muted: false, open: false }
  it('names every state the Team panel renders', () => {
    expect(memberCanvasState(member({ accountId: 'me' }), ctx)).toBe('self')
    expect(memberCanvasState(member({ accountId: 'p', status: 'pending' }), ctx)).toBe('pending')
    expect(memberCanvasState(member({ accountId: 'n', sharing: false }), ctx)).toBe('not-sharing')
    expect(memberCanvasState(member({ accountId: 'u' }), { ...ctx, hasLocalSide: false })).toBe('local-side-required')
    expect(memberCanvasState(member({ accountId: 'o', online: false }), ctx)).toBe('offline')
    expect(memberCanvasState(member({ accountId: 'a' }), { ...ctx, open: true })).toBe('open')
    expect(memberCanvasState(member({ accountId: 'a' }), { ...ctx, muted: true })).toBe('muted')
    expect(memberCanvasState(member({ accountId: 'a' }), ctx)).toBe('available')
  })
})
