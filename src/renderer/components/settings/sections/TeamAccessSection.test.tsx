// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HubProject } from '@shared/types'
import { encodeHubInvite } from '@shared/hub-invite'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { TeamAccessSection, memberCanvasCopy, teamAgentRows } from './TeamAccessSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sharedProject: HubProject = {
  projectId: 'p1',
  name: 'Brothers',
  ownerAccountId: 'owner',
  inviteCode: 'invite-secret',
  createdAt: 1,
  members: [
    { accountId: 'owner', name: 'Sebastián', publicKeyB64: 'owner-key', role: 'owner', status: 'approved', joinedAt: 1, online: true, sharing: true, machineLabel: "Sebastián's MacBook" },
    { accountId: 'guest', name: 'Jorge', publicKeyB64: 'guest-key', role: 'member', status: 'approved', joinedAt: 2, online: true, sharing: true, machineLabel: "Jorge's PC" },
    { accountId: 'ana', name: 'Ana', publicKeyB64: 'ana-key', role: 'member', status: 'approved', joinedAt: 3, online: true, sharing: false }
  ]
}

describe('TeamAccessSection', () => {
  let root: Root
  let host: HTMLElement
  let hub: Record<string, ReturnType<typeof vi.fn>>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hubUrl: 'http://192.168.1.128:8791' }, hydrated: true })
    useProjects.setState({
      projects: [{ id: 'p1', name: 'Brothers', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }],
      activeProjectId: 'p1'
    } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  function stubHub(accountId: 'owner' | 'guest' | 'ana', accountName: string, projects: HubProject[] = [sharedProject]): void {
    hub = {
      status: vi.fn(async () => ({ state: 'connected', accountId, accountName, machineLabel: 'my-host' })),
      connect: vi.fn(async () => ({ state: 'connected', accountId, accountName, machineLabel: 'my-host' })),
      hostStatus: vi.fn(async () => ({ state: 'disabled' })),
      pendingInvite: vi.fn(async () => null),
      listProjects: vi.fn(async () => projects),
      joinProject: vi.fn(async () => ({ projectId: 'hub-joined', name: 'Horacio Team', ownerAccountId: 'owner', inviteCode: 'c', createdAt: 1 })),
      createProject: vi.fn(async (name: string, projectId?: string) => ({ projectId: projectId ?? 'minted', name, ownerAccountId: accountId, inviteCode: 'c', createdAt: 1 })),
      bindProject: vi.fn(async () => undefined),
      onEvent: vi.fn(() => () => undefined)
    }
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      hub,
      settings: { save: vi.fn(async () => undefined) },
      shell: { openExternal: vi.fn() }
    }
  }

  async function mount(): Promise<void> {
    await act(async () => root.render(<TeamAccessSection isActive />))
    await act(async () => undefined)
  }

  const button = (label: string): HTMLButtonElement => {
    const found = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
    if (!found) throw new Error(`no "${label}" button`)
    return found
  }

  it('shows a guest the member list but no owner-only invite controls', async () => {
    stubHub('guest', 'jorge')
    await mount()

    expect(host.textContent).toContain('Sebastián')
    expect(host.textContent).toContain('Jorge')
    expect(host.textContent).not.toContain('Share this project')
    expect(host.textContent).not.toContain('Regenerate')
    const account = host.querySelector<HTMLInputElement>('input[placeholder="Your name"]')
    expect(account?.value).toBe('jorge')
  })

  it('keeps invite controls for the owner whose ACTIVE project is the shared one (legacy id match)', async () => {
    stubHub('owner', 'sebastian')
    await mount()

    expect(host.textContent).toContain('Share this project')
    expect(host.textContent).toContain('Regenerate')
    expect(host.textContent).toContain('your side: "Brothers"')
  })

  it('says which members are not sharing a canvas yet and offers Open only to those who are', async () => {
    stubHub('owner', 'sebastian')
    await mount()

    expect(host.textContent).toContain('not sharing an agent canvas yet')
    // Jorge shares and is online → an Open toggle; Ana does not share → no toggle at all.
    const opens = [...host.querySelectorAll('button')].filter((b) => b.textContent === 'Open')
    expect(opens).toHaveLength(1)
    // Our own row names the machine the Hub registered and lists our agents.
    expect(host.textContent).toContain('my-host')
  })

  it('"Share this project" binds the active project as this machine\'s side and tells main', async () => {
    useProjects.setState({
      projects: [{ id: 'local-x', name: 'Scratch', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }],
      activeProjectId: 'local-x'
    } as never)
    stubHub('owner', 'sebastian', [])
    await mount()
    hub.listProjects.mockResolvedValue([{ ...sharedProject, projectId: 'local-x', name: 'Scratch' }])
    await act(async () => { button('Share this project').click() })
    await act(async () => undefined)

    expect(hub.createProject).toHaveBeenCalledWith('Scratch', 'local-x')
    expect(hub.bindProject).toHaveBeenCalledWith('local-x', 'local-x')
    expect(useProjects.getState().getProject('local-x')?.hubProjectId).toBe('local-x')
  })

  it('joining creates an empty project named after the shared one by default, bound as my side', async () => {
    stubHub('guest', 'jorge', [])
    await mount()
    const invite = encodeHubInvite({ v: 1, hub: 'http://192.168.1.128:8791', project: 'hub-joined', code: 'c', name: 'Horacio Team' })
    const code = host.querySelector<HTMLInputElement>('input[placeholder="ohlab-invite:..."]')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(code, invite)
      code.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(host.textContent).toContain('Create an empty project named "Horacio Team"')
    await act(async () => { button('Join').click() })
    await act(async () => undefined)

    expect(hub.joinProject).toHaveBeenCalledWith('c')
    const created = useProjects.getState().projects.find((p) => p.name === 'Horacio Team')
    expect(created?.hubProjectId).toBe('hub-joined')
    expect(created?.id).not.toBe('p1')
    expect(hub.bindProject).toHaveBeenCalledWith('hub-joined', created!.id)
    expect(useProjects.getState().activeProjectId).toBe('p1') // joining never steals the view
    expect(host.textContent).toContain('"Horacio Team" is your side of it')
  })

  it('joining can use the current project as my side instead', async () => {
    stubHub('guest', 'jorge', [])
    await mount()
    const invite = encodeHubInvite({ v: 1, hub: 'http://192.168.1.128:8791', project: 'hub-joined', code: 'c', name: 'Horacio Team' })
    const code = host.querySelector<HTMLInputElement>('input[placeholder="ohlab-invite:..."]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(code, invite)
      code.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const current = [...host.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1]
    await act(async () => { current.click() })
    await act(async () => { button('Join').click() })
    await act(async () => undefined)

    expect(useProjects.getState().projects).toHaveLength(1)
    expect(useProjects.getState().getProject('p1')?.hubProjectId).toBe('hub-joined')
    expect(hub.bindProject).toHaveBeenCalledWith('hub-joined', 'p1')
  })
})

describe('team panel helpers', () => {
  it('teamAgentRows lists agent terminals with the kanban badge rule and prefers the session name', () => {
    const rows = teamAgentRows(
      [
        { id: 'a', kind: 'terminal', title: 'Alpha', agentId: 'claude' },
        { id: 'b', kind: 'terminal', title: 'Beta', agentId: 'codex' },
        { id: 'c', kind: 'terminal', title: 'plain shell' },
        { id: 'd', kind: 'sticky', title: 'note', agentId: 'claude' },
        { id: 'e', kind: 'terminal', title: 'Idle', agentId: 'gemini' }
      ],
      {
        a: { state: 'working', unread: false, session: 'Review PR 42' },
        b: { state: 'blocked', unread: false },
        e: { state: 'done', unread: false }
      }
    )
    expect(rows).toEqual([
      { id: 'a', title: 'Review PR 42', state: 'RUNNING' },
      { id: 'b', title: 'Beta', state: 'NEEDS YOU' },
      { id: 'e', title: 'Idle', state: 'idle' }
    ])
  })

  it('memberCanvasCopy names every state', () => {
    expect(memberCanvasCopy('self', 'host-1')).toBe('host-1')
    expect(memberCanvasCopy('not-sharing', '')).toBe('not sharing an agent canvas yet')
    expect(memberCanvasCopy('pending', '')).toBe('waiting for approval')
    expect(memberCanvasCopy('offline', '')).toBe('offline')
    expect(memberCanvasCopy('muted', '')).toBe('tab closed')
    expect(memberCanvasCopy('available', '')).toBe('connecting…')
    expect(memberCanvasCopy('open', '')).toBe('')
  })
})
