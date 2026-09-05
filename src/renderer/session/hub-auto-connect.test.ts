import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HubEvent, HubProject, HubProjectMember, HubStatus } from '@shared/types'
import { MAX_DIAL_ATTEMPTS, startHubAutoConnect, type HubAutoConnectDeps } from './hub-auto-connect'
import { RECONNECT_DELAYS_MS } from '../lib/hubAutoConnect'
import type { RelayTab } from './relay-tab'

const member = (over: Partial<HubProjectMember> & { accountId: string }): HubProjectMember => ({
  name: over.accountId,
  publicKeyB64: 'k',
  role: 'member',
  status: 'approved',
  joinedAt: 1,
  online: true,
  sharing: true,
  ...over
})

function harness(over: { projects?: HubProject[]; status?: HubStatus; muted?: string[]; bindings?: Array<[string, string]> } = {}) {
  let projects = over.projects ?? [{
    projectId: 'hub-1', name: 'Team', ownerAccountId: 'me', inviteCode: 'x', createdAt: 1,
    members: [member({ accountId: 'me', role: 'owner' }), member({ accountId: 'jorge', name: 'Jorge' })]
  }]
  let hubListeners: Array<(event: HubEvent) => void> = []
  const closeListeners = new Map<string, Array<() => void>>()
  const muted = new Set(over.muted ?? [])
  const bindings = new Map(over.bindings ?? [['hub-1', 'local-1']])
  const openProjects = new Set<string>()
  const disposed: string[] = []
  const projectListeners: Array<() => void> = []
  const settingsListeners: Array<() => void> = []
  let seq = 0
  const opened: Array<{ label: string; reconnect?: { projectId: string; staleSessionId: string } }> = []
  let failDial: Error | null = null
  const dropped: string[] = []
  const restored: string[] = []

  const deps: HubAutoConnectDeps = {
    hub: {
      status: vi.fn(async (): Promise<HubStatus> => over.status ?? { state: 'connected', accountId: 'me', accountName: 'Me' }),
      listProjects: vi.fn(async () => projects),
      connectMember: vi.fn(async (projectId, accountId) => {
        if (failDial) throw failDial
        return { offer: `offer:${projectId}:${accountId}` }
      }),
      onEvent: (listener) => {
        hubListeners.push(listener)
        return () => { hubListeners = hubListeners.filter((l) => l !== listener) }
      }
    },
    relayClient: {
      connect: vi.fn(async (offer: string) => `conn-${offer}-${++seq}`),
      onClosed: (connectionId, cb) => {
        closeListeners.set(connectionId, [...(closeListeners.get(connectionId) ?? []), cb])
        return () => closeListeners.set(connectionId, (closeListeners.get(connectionId) ?? []).filter((c) => c !== cb))
      }
    },
    openTab: vi.fn(async (target, _connectionId, reconnect) => {
      opened.push({ label: target.label, reconnect })
      const projectId = reconnect?.projectId ?? `proj-${target.key}`
      openProjects.add(projectId)
      const sessionId = `sess-${++seq}`
      const tab: RelayTab = { projectId, sessionId, dispose: () => { disposed.push(sessionId) } }
      return tab
    }),
    bindings: () => bindings,
    subscribeProjects: (listener) => { projectListeners.push(listener); return () => {} },
    projectOpen: (projectId) => openProjects.has(projectId),
    dropProject: (projectId) => { openProjects.delete(projectId) },
    muted: () => muted,
    setMuted: (keys) => { muted.clear(); for (const key of keys) muted.add(key); settingsListeners.forEach((l) => l()) },
    subscribeSettings: (listener) => { settingsListeners.push(listener); return () => {} },
    onDrop: (tab) => { dropped.push(tab.projectId) },
    onRestored: (tab, stale) => { restored.push(`${tab.projectId}<-${stale}`) },
    log: () => {}
  }
  return {
    deps,
    opened,
    disposed,
    dropped,
    restored,
    muted,
    bindings,
    openProjects,
    emit: (event: HubEvent) => hubListeners.forEach((l) => l(event)),
    dropSocket: (connectionId: string) => closeListeners.get(connectionId)?.forEach((cb) => cb()),
    connectionIds: () => [...closeListeners.keys()],
    setProjects: (next: HubProject[]) => { projects = next },
    projectsChanged: () => projectListeners.forEach((l) => l()),
    closeProject: (projectId: string) => { openProjects.delete(projectId); projectListeners.forEach((l) => l()) },
    setFailDial: (error: Error | null) => { failDial = error }
  }
}

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve() }

describe('mutual auto-connect controller', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opens one background tab per approved online sharing member once the Hub is connected', async () => {
    const h = harness()
    const controller = startHubAutoConnect(h.deps)
    await flush()
    expect(h.opened).toEqual([{ label: 'Team · Jorge', reconnect: undefined }])
    expect(controller.tabs()).toMatchObject([{ key: 'hub-1:jorge', status: 'live', projectId: 'proj-hub-1:jorge' }])
    // A second evaluation (any directory event) does not open a duplicate.
    h.emit({ type: 'member-online', accountId: 'jorge' })
    await flush()
    expect(h.opened).toHaveLength(1)
    controller.stop()
  })

  it('a member coming online later is opened on the directory event; an offline one is not', async () => {
    const h = harness({ projects: [{
      projectId: 'hub-1', name: 'Team', ownerAccountId: 'me', inviteCode: 'x', createdAt: 1,
      members: [member({ accountId: 'me', role: 'owner' }), member({ accountId: 'ana', name: 'Ana', online: false })]
    }] })
    const controller = startHubAutoConnect(h.deps)
    await flush()
    expect(h.opened).toEqual([])
    h.setProjects([{ ...controller.projects()[0], members: [member({ accountId: 'me', role: 'owner' }), member({ accountId: 'ana', name: 'Ana' })] }])
    h.emit({ type: 'member-online', accountId: 'ana' })
    await flush()
    expect(h.opened.map((o) => o.label)).toEqual(['Team · Ana'])
    controller.stop()
  })

  it('a dropped socket greys the tab and reconnects IN PLACE on the backoff ladder — never a second tab', async () => {
    const h = harness()
    const controller = startHubAutoConnect(h.deps)
    await flush()
    const first = controller.tabs()[0]
    h.dropSocket(h.connectionIds()[0])
    expect(h.dropped).toEqual([first.projectId])
    expect(controller.tabs()[0].status).toBe('offline')
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0])
    await flush()
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1].reconnect).toEqual({ projectId: first.projectId, staleSessionId: first.sessionId })
    expect(h.restored).toEqual([`${first.projectId}<-${first.sessionId}`])
    expect(controller.tabs()).toHaveLength(1)
    expect(controller.tabs()[0]).toMatchObject({ status: 'live', projectId: first.projectId })
    expect(controller.tabs()[0].sessionId).not.toBe(first.sessionId)
    controller.stop()
  })

  it('a failed dial backs off, bounded, and gives up after MAX_DIAL_ATTEMPTS', async () => {
    const h = harness()
    h.setFailDial(new Error('member is offline'))
    const controller = startHubAutoConnect(h.deps)
    await flush()
    expect(h.deps.hub.connectMember).toHaveBeenCalledTimes(1)
    for (let attempt = 1; attempt < MAX_DIAL_ATTEMPTS; attempt++) {
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)])
      await flush()
      expect(h.deps.hub.connectMember).toHaveBeenCalledTimes(attempt + 1)
    }
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[RECONNECT_DELAYS_MS.length - 1] * 3)
    await flush()
    expect(h.deps.hub.connectMember).toHaveBeenCalledTimes(MAX_DIAL_ATTEMPTS)
    controller.stop()
  })

  it('does not retry a member who went offline; reconnects the moment they are back', async () => {
    const h = harness()
    const controller = startHubAutoConnect(h.deps)
    await flush()
    const first = controller.tabs()[0]
    h.setProjects([{ ...controller.projects()[0], members: [member({ accountId: 'me', role: 'owner' }), member({ accountId: 'jorge', name: 'Jorge', online: false })] }])
    h.emit({ type: 'member-offline', accountId: 'jorge' })
    await flush()
    h.dropSocket(h.connectionIds()[0])
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(h.opened).toHaveLength(1) // greyed, waiting
    expect(controller.tabs()[0].status).toBe('offline')
    h.setProjects([{ ...controller.projects()[0], members: [member({ accountId: 'me', role: 'owner' }), member({ accountId: 'jorge', name: 'Jorge' })] }])
    h.emit({ type: 'member-online', accountId: 'jorge' })
    await flush()
    expect(h.opened).toHaveLength(2)
    expect(h.opened[1].reconnect?.projectId).toBe(first.projectId)
    controller.stop()
  })

  it('closing the member tab mutes the member: the tab is dropped and not reopened until Open', async () => {
    const h = harness()
    const controller = startHubAutoConnect(h.deps)
    await flush()
    const first = controller.tabs()[0]
    h.closeProject(first.projectId)
    expect(h.muted.has('hub-1:jorge')).toBe(true)
    expect(h.disposed).toEqual([first.sessionId])
    expect(controller.tabs()).toEqual([])
    h.emit({ type: 'member-online', accountId: 'jorge' })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.opened).toHaveLength(1)
    // Open in Settings > Team: unmute + dial now.
    await controller.open('hub-1', 'jorge')
    await flush()
    expect(h.muted.has('hub-1:jorge')).toBe(false)
    expect(h.opened).toHaveLength(2)
    expect(controller.tabs()).toHaveLength(1)
    // Close in Settings > Team mutes again.
    controller.close('hub-1', 'jorge')
    expect(h.muted.has('hub-1:jorge')).toBe(true)
    expect(controller.tabs()).toEqual([])
    controller.stop()
  })

  it('a muted member is never dialled, even when everything else qualifies', async () => {
    const h = harness({ muted: ['hub-1:jorge'] })
    const controller = startHubAutoConnect(h.deps)
    await flush()
    h.emit({ type: 'member-online', accountId: 'jorge' })
    await flush()
    expect(h.opened).toEqual([])
    controller.stop()
  })

  it('a binding made later (Share / Join) dials the members already online', async () => {
    const h = harness({ bindings: [] })
    const controller = startHubAutoConnect(h.deps)
    await flush()
    expect(h.opened).toEqual([])
    h.bindings.set('hub-1', 'local-1')
    h.projectsChanged()
    await flush()
    expect(h.opened.map((o) => o.label)).toEqual(['Team · Jorge'])
    controller.stop()
  })

  it('a greyed tab click reconnects a member tab and answers false for a tab it does not own', async () => {
    const h = harness()
    const controller = startHubAutoConnect(h.deps)
    await flush()
    const first = controller.tabs()[0]
    h.dropSocket(h.connectionIds()[0])
    expect(controller.reconnect(first.projectId)).toBe(true)
    await flush()
    expect(h.opened).toHaveLength(2)
    expect(controller.reconnect('somebody-elses-tab')).toBe(false)
    controller.stop()
  })

  it('stays inert while the Hub is disabled and disposes its tabs on stop', async () => {
    const h = harness({ status: { state: 'disabled' } })
    const controller = startHubAutoConnect(h.deps)
    await flush()
    expect(h.opened).toEqual([])
    h.emit({ type: 'status', status: { state: 'connected', accountId: 'me' } })
    await flush()
    expect(h.opened).toHaveLength(1)
    const tab = controller.tabs()[0]
    controller.stop()
    expect(h.disposed).toEqual([tab.sessionId])
    expect(controller.tabs()).toEqual([])
  })
})
