import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, NodeTerminalApi, Project, Workspace } from '@shared/types'
import type { RelayApiHandle } from '../bridge/relay-api'
import { openRelayTab } from '../session/relay-tab'
import {
  createSession,
  projectForSession,
  resetSessionsForTest,
  sessionForProject,
  setActiveSession,
  workspaceSessions,
  type WorkspaceSession
} from '../session/session'
import { relayNodesOf, resetRelayNodesForTest } from '../session/relay-nodes'
import { useProjects } from '../state/projects'
import {
  findNodeHome,
  messageRouteFor,
  preferredSourceTitle,
  relayListRows,
  type NodeHomeDeps
} from './nodeHome'

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  title: id, color: '#fff', group: null, agentId: 'claude', ...over
})

function session(over: Partial<WorkspaceSession> & { id: string }): WorkspaceSession {
  return { source: 'relay', label: over.id, api: {} as NodeTerminalApi, status: 'connected', ...over }
}

describe('findNodeHome (pure)', () => {
  const local = session({ id: 'local', source: 'local' })
  const relay = session({ id: 'relay-1', memberName: 'Jorge', machineLabel: "Jorge's MacBook" })
  const deps = (over: Partial<NodeHomeDeps> = {}): NodeHomeDeps => ({
    projects: [
      { id: 'p-local', name: 'Mine', color: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('stored-local')] } as Project,
      { id: 'p-remote', name: 'Team · Jorge', color: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('stored-remote')], remote: true } as Project
    ],
    activeProjectId: 'p-local',
    liveNodes: [{ id: 'live-only', kind: 'terminal', title: 'Live' }],
    sessionForProject: (id) => (id === 'p-remote' ? relay : local),
    sessions: () => [local, relay],
    relayNodes: (id) => (id === 'relay-1' ? [node('relay-only')] : []),
    projectForSession: (id) => (id === 'relay-1' ? 'p-remote' : undefined),
    ...over
  })

  it('consults the store, then the live canvas, then every relay session, in that order', () => {
    expect(findNodeHome('stored-local', deps())).toMatchObject({ projectId: 'p-local', via: 'store', session: local })
    expect(findNodeHome('stored-remote', deps())).toMatchObject({ projectId: 'p-remote', via: 'store', session: relay })
    expect(findNodeHome('live-only', deps())).toMatchObject({ projectId: 'p-local', via: 'canvas', session: local })
    expect(findNodeHome('relay-only', deps())).toMatchObject({ projectId: 'p-remote', via: 'relay', session: relay })
    expect(findNodeHome('nowhere', deps())).toBeNull()
    expect(findNodeHome('', deps())).toBeNull()
  })

  it('the live canvas only answers for the ACTIVE project', () => {
    expect(findNodeHome('live-only', deps({ activeProjectId: '' }))).toBeNull()
  })

  it('a relay session whose tab is not bound cannot claim a node', () => {
    expect(findNodeHome('relay-only', deps({ projectForSession: () => undefined }))).toBeNull()
  })

  it('routes a relay-listed node to the relay session and never to the local path', () => {
    const home = findNodeHome('relay-only', deps())
    expect(messageRouteFor(home, () => false)).toMatchObject({ kind: 'relay', online: true, projectId: 'p-remote' })
    expect(messageRouteFor(home, () => true)).toMatchObject({ kind: 'relay', online: false })
    expect(messageRouteFor(findNodeHome('stored-local', deps()), () => false)).toEqual({ kind: 'local' })
    expect(messageRouteFor(null, () => false)).toEqual({ kind: 'local' })
  })

  it('an offline relay session still routes relay (refused as member offline), not local', () => {
    const offline = session({ id: 'relay-1', status: 'offline', memberName: 'Jorge' })
    const home = findNodeHome('relay-only', deps({ sessions: () => [offline], sessionForProject: (id) => (id === 'p-remote' ? offline : local) }))
    expect(messageRouteFor(home, () => false)).toMatchObject({ kind: 'relay', online: false })
  })
})

describe('relayListRows', () => {
  it('lists the union of a relay project\'s stored nodes and its live set with member labels', () => {
    const relay = session({ id: 'relay-1', memberName: 'Jorge', machineLabel: "Jorge's MacBook" })
    const rows = relayListRows({
      projects: [
        { id: 'p-remote', name: 'x', color: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('a', { title: 'stale' })], remote: true } as Project,
        { id: 'p-local', name: 'y', color: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('mine')] } as Project
      ],
      sessionForProject: (id) => (id === 'p-remote' ? relay : session({ id: 'local', source: 'local' })),
      relayNodes: () => [node('a', { title: 'fresh' }), node('b')],
      linked: (id) => id === 'b',
      unavailable: () => false
    })
    expect(rows).toEqual([
      { id: 'a', kind: 'terminal', title: 'fresh', member: 'Jorge', machine: "Jorge's MacBook", online: true, linked: false },
      { id: 'b', kind: 'terminal', title: 'b', member: 'Jorge', machine: "Jorge's MacBook", online: true, linked: true }
    ])
  })
})

describe('preferredSourceTitle', () => {
  it('a user-typed title wins, then the agent session name, then the auto title, then the id', () => {
    expect(preferredSourceTitle({ id: 'n1', title: 'Reviewer', titleAuto: false }, 'ohlab list skill')).toBe('Reviewer')
    expect(preferredSourceTitle({ id: 'n1', title: 'ohlab list skill manage-ohlab-canvas' }, 'Review PR 42')).toBe('Review PR 42')
    expect(preferredSourceTitle({ id: 'n1', title: 'ohlab list skill' }, undefined)).toBe('ohlab list skill')
    expect(preferredSourceTitle({ id: 'n1', title: '   ' }, '  ')).toBe('n1')
    expect(preferredSourceTitle(undefined, undefined)).toBe('')
  })
})

// ── The bug from the two-instance run, pinned end to end at the renderer layer ──────────────────
// The host creates a node AFTER the guest opened the tab. The tab is ACTIVE on the guest (so the
// store is not refreshed by the inactive-tab leg), yet `send` must still route to the host.
describe('a node the host adds after the tab opened routes to the host', () => {
  beforeEach(() => {
    resetSessionsForTest()
    resetRelayNodesForTest()
    useProjects.setState({ projects: [], activeProjectId: '' })
    const local = createSession('local', { marker: 'local' } as unknown as NodeTerminalApi, 'here')
    setActiveSession(local.id)
  })

  it('send finds the new node through the relay live set and never falls through to local', async () => {
    let onMutation: ((projectId: string, m: unknown) => void) | undefined
    const hostProject = { id: 'host-p', name: 'Team', color: '', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('old')] } as Project
    const ws: Workspace = { version: 2, activeProjectId: 'host-p', projects: [hostProject] }
    const api = {
      workspace: { load: vi.fn().mockResolvedValue(ws) },
      canvas: { onMutation: vi.fn((cb) => { onMutation = cb; return () => { onMutation = undefined } }) },
      presence: { hello: vi.fn().mockResolvedValue({ clientId: 'x', peers: [] }), onSync: vi.fn(() => () => {}), onPeer: vi.fn(() => () => {}) }
    } as unknown as NodeTerminalApi
    const handle: RelayApiHandle = { api, ready: () => Promise.resolve(), close: vi.fn() }
    const tab = await openRelayTab('conn', 'Team · Jorge', {
      relayClient: { onClosed: () => () => {} },
      addProject: () => ({ id: 'unused' }),
      adoptProject: (p) => useProjects.getState().adoptProject(p),
      setActiveProject: (id) => useProjects.getState().setActive(id),
      buildApi: () => handle,
      hostAccountId: 'jorge',
      memberName: 'Jorge',
      machineLabel: "Jorge's MacBook"
    })
    expect(useProjects.getState().activeProjectId).toBe(tab.projectId) // the relay tab is on screen

    // The host adds a node now. The ACTIVE tab's store is not touched by the inactive-tab leg
    // (that is the seam the bug fell through), but the session's live set is.
    onMutation!('host-p', { op: 'upsert', node: node('fresh', { title: 'Reviewer' }) })
    expect(useProjects.getState().projects.find((p) => p.id === tab.projectId)?.nodes.map((n) => n.id)).toEqual(['old'])
    expect(relayNodesOf(tab.sessionId).map((n) => n.id)).toEqual(['old', 'fresh'])

    const home = findNodeHome('fresh', {
      projects: useProjects.getState().projects,
      activeProjectId: useProjects.getState().activeProjectId,
      liveNodes: [], // React Flow has not been told either (no canvas in this test)
      sessionForProject,
      sessions: workspaceSessions,
      relayNodes: relayNodesOf,
      projectForSession
    })
    expect(home).toMatchObject({ projectId: tab.projectId, via: 'relay', node: { id: 'fresh', title: 'Reviewer' } })
    const route = messageRouteFor(home, () => false)
    expect(route.kind).toBe('relay')
    if (route.kind === 'relay') expect(route.session.id).toBe(tab.sessionId)

    // Every relay-listed node is routed to its session — the local fall-through is unreachable.
    for (const listed of relayNodesOf(tab.sessionId)) {
      const each = findNodeHome(listed.id, {
        projects: useProjects.getState().projects, activeProjectId: useProjects.getState().activeProjectId,
        liveNodes: [], sessionForProject, sessions: workspaceSessions, relayNodes: relayNodesOf, projectForSession
      })
      expect(messageRouteFor(each, () => false).kind).toBe('relay')
    }

    // A removal reaches the live set too, so a deleted node is not routed anywhere.
    onMutation!('host-p', { op: 'remove', id: 'fresh' })
    expect(relayNodesOf(tab.sessionId).map((n) => n.id)).toEqual(['old'])
    tab.dispose()
    expect(relayNodesOf(tab.sessionId)).toEqual([])
  })
})
