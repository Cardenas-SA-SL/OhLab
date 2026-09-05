// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HubProject } from '@shared/types'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { TeamAccessSection } from './TeamAccessSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const sharedProject: HubProject = {
  projectId: 'p1',
  name: 'Brothers',
  ownerAccountId: 'owner',
  inviteCode: 'invite-secret',
  createdAt: 1,
  members: [
    { accountId: 'owner', name: 'Sebastián', publicKeyB64: 'owner-key', role: 'owner', status: 'approved', joinedAt: 1, online: true },
    { accountId: 'guest', name: 'Jorge', publicKeyB64: 'guest-key', role: 'member', status: 'approved', joinedAt: 2, online: true }
  ]
}

describe('TeamAccessSection project ownership', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, hubUrl: 'http://192.168.1.128:8791' }, hydrated: true })
    useProjects.setState({
      projects: [{ id: 'p1', name: 'Brothers', nodes: [] }],
      activeProjectId: 'p1'
    } as never)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.restoreAllMocks()
  })

  function stubHub(accountId: 'owner' | 'guest', accountName: string): void {
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
      hub: {
        status: vi.fn(async () => ({ state: 'connected', accountId, accountName })),
        hostStatus: vi.fn(async () => ({ state: 'disabled' })),
        pendingInvite: vi.fn(async () => null),
        listProjects: vi.fn(async () => [sharedProject]),
        onEvent: vi.fn(() => () => undefined)
      }
    }
  }

  async function mount(): Promise<void> {
    await act(async () => root.render(<TeamAccessSection isActive />))
    await act(async () => undefined)
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

  it('keeps invite controls for the owner', async () => {
    stubHub('owner', 'sebastian')
    await mount()

    expect(host.textContent).toContain('Share this project')
    expect(host.textContent).toContain('Regenerate')
  })
})
