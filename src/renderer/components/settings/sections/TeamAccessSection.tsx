import { useEffect, useMemo, useState } from 'react'
import type { HubHostStatus, HubProject, HubProjectMember, HubStatus, Project } from '@shared/types'
import { decodeHubInvite, encodeHubInvite } from '@shared/hub-invite'
import { memberTabKey, mutedMemberKeys, resolveLocalSide } from '@shared/hub-local-side'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { useAgentStatus, type AgentNodeStatus } from '../../../state/agentStatus'
import { loadIdentity } from '../../../state/presence'
import { getSessionStores, sessionById } from '../../../session/session'
import { relayNodesOf } from '../../../session/relay-nodes'
import { hubMemberTabs, type HubMemberTab } from '../../../session/hub-auto-connect'
import { memberCanvasState, type MemberCanvasState } from '../../../lib/hubAutoConnect'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'
import { CopyButton } from '@renderer/ui/CopyButton'
import { Switch } from '@renderer/ui/Switch'
import { thisMachineCap } from '../../../lib/machineName'
import { canManageHubProject } from '../../../lib/hubTeam'

const ROW = {
  title: 'OhLab Hub',
  keywords: ['team', 'hub', 'invite', 'share', 'collaborate', 'remote', 'member']
}

/** One agent node as the Team panel lists it under a member: its title and what it is doing. */
export interface TeamAgentRow {
  id: string
  title: string
  state: 'RUNNING' | 'NEEDS YOU' | 'idle'
}

/** The agent rows for a set of nodes + their status table — the same RUNNING / NEEDS YOU rule the
 *  kanban card uses (SessionCard), so a member's panel row never contradicts their card. */
export function teamAgentRows(
  nodes: ReadonlyArray<{ id: string; kind?: string; title?: string; agentId?: string }>,
  statusById: Record<string, AgentNodeStatus | undefined>
): TeamAgentRow[] {
  return nodes
    .filter((node) => (node.kind ?? 'terminal') === 'terminal' && !!node.agentId)
    .map((node) => {
      const status = statusById[node.id]
      const state: TeamAgentRow['state'] =
        status?.state === 'working' ? 'RUNNING'
          : status?.state === 'waiting' || status?.state === 'blocked' ? 'NEEDS YOU'
            : 'idle'
      return { id: node.id, title: status?.session || node.title || node.id, state }
    })
}

/** What a member's row says beside their name, per `memberCanvasState`. */
export function memberCanvasCopy(state: MemberCanvasState, machine: string): string {
  switch (state) {
    case 'self': return machine
    case 'pending': return 'waiting for approval'
    case 'not-sharing': return 'not sharing an agent canvas yet'
    case 'offline': return 'offline'
    case 'muted': return 'tab closed'
    case 'available': return 'connecting…'
    case 'open': return ''
  }
}

/** Re-render on any change to the controller's tabs or to the agent status of any listed session. */
function useTeamLiveTick(tabs: readonly HubMemberTab[]): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = (): void => setTick((n) => n + 1)
    const unsubs: Array<() => void> = []
    const controller = hubMemberTabs()
    if (controller) unsubs.push(controller.subscribe(bump))
    unsubs.push(useAgentStatus.subscribe(bump))
    for (const tab of tabs) {
      if (!sessionById(tab.sessionId)) continue
      unsubs.push(getSessionStores(tab.sessionId).agentStatus.store.subscribe(bump))
    }
    return () => unsubs.forEach((un) => un())
  }, [tabs.map((tab) => tab.sessionId).join('|')])
  return tick
}

function AgentList({ rows }: { rows: TeamAgentRow[] }): React.JSX.Element | null {
  if (rows.length === 0) return <p className="text-xs text-muted">No agents open.</p>
  return (
    <ul className="space-y-0.5">
      {rows.map((row) => (
        <li key={row.id} className="flex items-center gap-2 text-xs">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${row.state === 'RUNNING' ? 'bg-green-500' : row.state === 'NEEDS YOU' ? 'bg-amber-500' : 'bg-muted'}`} />
          <span className="truncate">{row.title}</span>
          <span className="text-muted">{row.state}</span>
        </li>
      ))}
    </ul>
  )
}

export function TeamAccessSection({ isActive }: { isActive: boolean; onClose?: () => void }): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  const updateSettings = useSettings((state) => state.update)
  const localProjects = useProjects((state) => state.projects)
  const activeProject = useProjects((state) => state.projects.find((project) => project.id === state.activeProjectId))
  const setProjectCapability = useProjects((state) => state.setProjectCapability)
  const [hubUrl, setHubUrl] = useState(settings.hubUrl)
  const [accountName, setAccountName] = useState(settings.hubAccountName || loadIdentity()?.name || '')
  const [status, setStatus] = useState<HubStatus>({ state: settings.hubUrl ? 'connecting' : 'disabled' })
  const [hostStatus, setHostStatus] = useState<HubHostStatus>({ state: settings.hubHostEnabled ? 'starting' : 'disabled' })
  const [projects, setProjects] = useState<HubProject[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [joinName, setJoinName] = useState(accountName)
  // Which local project becomes MY side of the project I am joining. "Create" is the default: a
  // fresh, empty canvas named after the shared project, so joining never binds a repo the user
  // happened to have open to somebody's team.
  const [joinSide, setJoinSide] = useState<'create' | 'current'>('create')
  const [waiting, setWaiting] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const controller = hubMemberTabs()
  const memberTabs = controller?.tabs() ?? []
  useTeamLiveTick(memberTabs)

  const refresh = async (): Promise<void> => {
    const next = await window.nodeTerminal.hub.listProjects()
    setProjects(next)
  }

  const applyStatus = (next: HubStatus): void => {
    setStatus(next)
    if (next.state === 'connected' && next.accountName) {
      setAccountName((current) => current.trim() ? current : next.accountName!)
      setJoinName((current) => current.trim() ? current : next.accountName!)
    }
  }

  useEffect(() => {
    if (!isActive) return
    void window.nodeTerminal.hub.status().then(applyStatus)
    void window.nodeTerminal.hub.hostStatus().then(setHostStatus)
    void window.nodeTerminal.hub.pendingInvite().then((invite) => { if (invite) setJoinCode(invite) })
    const unsub = window.nodeTerminal.hub.onEvent((event) => {
      if (event.type === 'status') applyStatus(event.status)
      else if (event.type === 'host-status') setHostStatus(event.status)
      else if (event.type === 'invite-prefill') setJoinCode(event.invite)
      else if (event.type === 'member-approved') {
        setWaiting('Approved. The owner\'s agents open as a tab as soon as they are online, and yours open for them.')
        void refresh().catch(() => {})
      } else if (event.type === 'member-declined') {
        setWaiting('The owner declined this join request.')
        void refresh().catch(() => {})
      }
      else void refresh().catch(() => {})
    })
    if (settings.hubUrl) void refresh().catch(() => {})
    return unsub
  }, [isActive, settings.hubUrl])

  const localSides = useMemo(() => localProjects.filter((project) => !project.remote), [localProjects])
  // The Hub project whose local side is the ACTIVE project — through the one resolver main uses.
  const myHubProject = useMemo(
    () => activeProject ? projects.find((project) => resolveLocalSide(project.projectId, localSides) === activeProject.id) : undefined,
    [projects, activeProject, localSides]
  )
  const canManageActiveProject = canManageHubProject(myHubProject, status)
  const muted = useMemo(() => mutedMemberKeys(settings.hubMutedMembers), [settings.hubMutedMembers])
  const invite = useMemo(() => decodeHubInvite(joinCode), [joinCode])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try { await action() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }

  const connect = (): void => {
    updateSettings({ hubUrl: hubUrl.trim(), hubAccountName: accountName.trim() })
    void run(async () => {
      // Save is coalesced, so let the main process receive the exact values before asking it to dial.
      await window.nodeTerminal.settings.save({ ...settings, hubUrl: hubUrl.trim(), hubAccountName: accountName.trim() })
      applyStatus(await window.nodeTerminal.hub.connect())
      await refresh()
    })
  }

  const saveHubSettings = (patch: Partial<typeof settings>): void => {
    const next = { ...useSettings.getState().settings, ...patch }
    updateSettings(patch)
    void window.nodeTerminal.settings.save(next)
  }

  /** Bind a local project as this machine's side of a shared project: the store persists it
   *  (machine-local), main is told so it hosts and publishes the `sharing` flag at once. */
  const bindLocalSide = async (hubProjectId: string, localProjectId: string): Promise<void> => {
    useProjects.getState().setProjectHubBinding(localProjectId, hubProjectId)
    await window.nodeTerminal.hub.bindProject(hubProjectId, localProjectId)
  }

  const join = (): void => {
    void run(async () => {
      if (!invite) throw new Error('That invite code is invalid or incomplete.')
      const configured = settings.hubUrl.trim()
      if (configured && configured !== invite.hub && !window.confirm(`This invite uses ${invite.hub}. Switch from ${configured}?`)) return
      const name = joinName.trim() || accountName.trim()
      const next = { ...settings, hubUrl: invite.hub, hubAccountName: name }
      updateSettings({ hubUrl: invite.hub, hubAccountName: name })
      setHubUrl(invite.hub)
      setAccountName(name)
      await window.nodeTerminal.settings.save(next)
      applyStatus(await window.nodeTerminal.hub.connect())
      const project = await window.nodeTerminal.hub.joinProject(invite.code)
      // Every member has a local side: bind it now, so the moment the owner approves, both
      // directions connect without a second step here.
      const store = useProjects.getState()
      const localProjectId = joinSide === 'current' && activeProject
        ? activeProject.id
        : store.addProject(project.name).id
      await bindLocalSide(project.projectId, localProjectId)
      const sideName = store.getProject(localProjectId)?.name ?? project.name
      setWaiting(`Waiting for the owner to approve ${project.name}. "${sideName}" is your side of it; both computers also need agent messaging enabled.`)
      await refresh()
    })
  }

  const share = (): void => {
    void run(async () => {
      if (!activeProject) return
      const created = await window.nodeTerminal.hub.createProject(activeProject.name, activeProject.id)
      await bindLocalSide(created.projectId, activeProject.id)
      await refresh()
    })
  }

  const inviteString = canManageActiveProject && myHubProject ? encodeHubInvite({
    v: 1,
    hub: settings.hubHostEnabled && settings.hubUrl.includes('127.0.0.1')
      ? (hostStatus.addresses?.[0]?.url ?? settings.hubUrl)
      : settings.hubUrl,
    project: myHubProject.projectId,
    code: myHubProject.inviteCode,
    name: myHubProject.name
  }) : ''

  const myMachine = status.machineLabel || thisMachineCap()

  /** The agent rows for one member row: ours from the bound local project, theirs from the open tab. */
  const agentRowsFor = (project: HubProject, member: HubProjectMember, tab: HubMemberTab | undefined): TeamAgentRow[] | null => {
    if (member.accountId === status.accountId) {
      const localId = resolveLocalSide(project.projectId, localSides)
      const local = localId ? localSides.find((candidate) => candidate.id === localId) : undefined
      if (!local) return null
      return teamAgentRows(local.nodes, useAgentStatus.getState().byId)
    }
    if (!tab || !sessionById(tab.sessionId)) return null
    const remote = useProjects.getState().getProject(tab.projectId)
    const byId = new Map<string, Project['nodes'][number]>()
    for (const node of remote?.nodes ?? []) byId.set(node.id, node)
    for (const node of relayNodesOf(tab.sessionId)) byId.set(node.id, node)
    return teamAgentRows([...byId.values()], getSessionStores(tab.sessionId).agentStatus.store.getState().byId)
  }

  const renderMember = (project: HubProject, member: HubProjectMember): React.JSX.Element => {
    const isOwner = project.ownerAccountId === status.accountId
    const key = memberTabKey(project.projectId, member.accountId)
    const tab = memberTabs.find((candidate) => candidate.key === key)
    const canvasState = memberCanvasState(member, { myAccountId: status.accountId, muted: muted.has(key), open: !!tab })
    const rows = canvasState === 'self' || canvasState === 'open' ? agentRowsFor(project, member, tab) : null
    const machine = member.accountId === status.accountId ? myMachine : (member.machineLabel ?? '')
    const detail = memberCanvasCopy(canvasState, machine)
    const canToggle = member.accountId !== status.accountId && member.status === 'approved' && member.sharing === true
    return (
      <div key={member.accountId} className="space-y-1 rounded-md border border-border/60 p-2 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 truncate">
            <span aria-label={member.online ? 'online' : 'offline'} className={`mr-2 inline-block h-2 w-2 rounded-full ${member.online ? 'bg-green-500' : 'bg-muted'}`} />
            <strong>{member.name}</strong>
            <span className="ml-1 text-xs text-muted">
              {member.accountId !== status.accountId && member.machineLabel ? `· ${member.machineLabel} ` : ''}
              · {member.role} · {member.status}
            </span>
            {tab?.status === 'offline' ? <span className="ml-1 text-xs text-amber-500">· reconnecting</span> : null}
            {detail ? <span className="ml-1 text-xs text-muted">· {detail}</span> : null}
          </span>
          <div className="flex shrink-0 gap-2">
            {member.status === 'pending' && isOwner ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.approveMember(project.projectId, member.accountId); await refresh() })}>Approve</Button> : null}
            {member.status === 'pending' && isOwner ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.removeMember(project.projectId, member.accountId); await refresh() })}>Decline</Button> : null}
            {member.role !== 'owner' && member.status === 'approved' && isOwner ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.removeMember(project.projectId, member.accountId); await refresh() })}>Remove</Button> : null}
            {canToggle && tab ? (
              <Button onClick={() => controller?.close(project.projectId, member.accountId)}>Close</Button>
            ) : canToggle ? (
              <Button
                title={!member.online ? 'This member is offline' : undefined}
                disabled={!member.online || !controller}
                onClick={() => void run(() => controller!.open(project.projectId, member.accountId))}
              >Open</Button>
            ) : null}
          </div>
        </div>
        {rows ? (
          <div className="pl-4">
            <p className="text-xs text-muted">{rows.length} agent{rows.length === 1 ? '' : 's'}</p>
            <AgentList rows={rows} />
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <SettingsSection id="team-access" title="Team" description="Connect to your self-hosted OhLab Hub and share projects with approved members. Every member sees every other member's agents." isActive={isActive} searchEntries={[ROW]}>
      <SearchableRow {...ROW}>
        <div className="space-y-6">
          <div className="space-y-3">
            <FieldRow
              label="Host a hub on this computer"
              note="Binds every network interface. OhLab never opens router ports automatically."
              control={<Switch checked={settings.hubHostEnabled} ariaLabel="Host a hub on this computer" onChange={(on) => {
                const typed = hubUrl.trim()
                const automatic = `http://127.0.0.1:${settings.hubHostPort}`
                const wasAutomatic = /^http:\/\/127\.0\.0\.1:\d+$/.test(typed)
                if (on && !typed) setHubUrl(automatic)
                if (!on && wasAutomatic) setHubUrl('')
                saveHubSettings({
                  hubHostEnabled: on,
                  ...(on && !typed ? { hubUrl: automatic } : {}),
                  ...(!on && wasAutomatic ? { hubUrl: '' } : {})
                })
              }} />}
            />
            <FieldRow label="Hub port" control={<Input className="w-28" type="number" min={1} max={65535} value={settings.hubHostPort} onChange={(event) => {
              const port = Number(event.target.value) || 8791
              const autoUrl = /^http:\/\/127\.0\.0\.1:\d+$/.test(settings.hubUrl)
              if (autoUrl) setHubUrl(`http://127.0.0.1:${port}`)
              saveHubSettings({ hubHostPort: port, ...(autoUrl ? { hubUrl: `http://127.0.0.1:${port}` } : {}) })
            }} />} />
            {hostStatus.state === 'listening' ? (
              hostStatus.addresses?.length ? hostStatus.addresses.map((item) => (
                <p className="text-sm text-muted" key={item.url}><strong>{item.label}:</strong> {item.url}{item.kind === 'lan' ? ' - reachable from another home only through Tailscale or a port forward' : ''}</p>
              )) : <p className="text-sm text-muted">Listening on port {hostStatus.port}, but no non-loopback IPv4 address was found.</p>
            ) : <p className="text-sm text-muted">Hub host: {hostStatus.state}{hostStatus.error ? ` - ${hostStatus.error}` : ''}</p>}
            <button className="text-sm text-accent hover:underline" onClick={() => window.nodeTerminal.shell.openExternal('https://github.com/Cardenas-SA-SL/OhLab/blob/main/docs/HUB.md')}>Hub setup help</button>
          </div>
          <div className="space-y-3">
            <FieldRow label="Hub URL" control={<Input className="w-80" value={hubUrl} placeholder="http://hub.tailnet:8791" onChange={(event) => setHubUrl(event.target.value)} />} />
            <FieldRow label="Account name" control={<Input className="w-80" value={accountName} placeholder="Your name" onChange={(event) => setAccountName(event.target.value)} />} />
            <div className="flex items-center gap-3">
              <Button variant="primary" disabled={busy || !hubUrl.trim()} onClick={connect}>Connect</Button>
              <span className="text-sm text-muted">{status.state}{status.accountName ? ` as ${status.accountName}` : ''}{status.state === 'connected' && status.machineLabel ? ` on ${status.machineLabel}` : ''}</span>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-[13px] font-medium text-text">Join with an invite code</h4>
            <div className="flex items-center gap-2">
              <Input className="w-72" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="ohlab-invite:..." />
              <Input className="w-44" value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Your name" />
              <Button disabled={busy || !joinCode.trim()} onClick={join}>Join</Button>
            </div>
            <fieldset className="space-y-1 text-sm">
              <legend className="text-xs text-muted">My side of {invite?.name ? `"${invite.name}"` : 'the shared project'}</legend>
              <label className="flex items-center gap-2">
                <input type="radio" name="hub-join-side" checked={joinSide === 'create'} onChange={() => setJoinSide('create')} />
                <span>Create an empty project named {invite?.name ? `"${invite.name}"` : 'after it'}</span>
              </label>
              <label className={`flex items-center gap-2${activeProject ? '' : ' opacity-60'}`}>
                <input type="radio" name="hub-join-side" disabled={!activeProject} checked={joinSide === 'current'} onChange={() => setJoinSide('current')} />
                <span>Use the current project as my side{activeProject ? ` ("${activeProject.name}")` : ''}</span>
              </label>
              <p className="text-xs text-muted">Members see the agents on your side; you see theirs. The binding stays on {thisMachineCap().toLowerCase()} and is never written into the shared project file.</p>
            </fieldset>
            {waiting ? <p className="text-sm text-muted">{waiting}</p> : null}
          </div>

          {status.state === 'connected' ? (
            <>
              {!myHubProject || canManageActiveProject ? (
                <div className="space-y-3">
                  <h4 className="text-[13px] font-medium text-text">Share this project</h4>
                  {myHubProject ? (
                    <div className="flex items-center gap-2">
                      <Input className="w-72" readOnly value={inviteString} onFocus={(event) => event.target.select()} />
                      <CopyButton text={inviteString} label="Copy invite" />
                      <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.regenerateInvite(myHubProject.projectId); await refresh() })}>Regenerate</Button>
                    </div>
                  ) : (
                    <>
                      <Button disabled={busy || !activeProject} onClick={share}>Share this project</Button>
                      <p className="text-xs text-muted">Hosts the current project for approved members and opens each member's copy as a tab here, as soon as they are online. Approving a member connects both ways.</p>
                    </>
                  )}
                </div>
              ) : null}

              <FieldRow
                label="Agent messaging for this project"
                note="Enable this on both computers for cross-machine agent messages."
                control={<Button disabled={!activeProject || activeProject.agentMessaging === true} onClick={() => {
                  if (!activeProject) return
                  setProjectCapability(activeProject.id, 'agentMessaging', true)
                }}>{activeProject?.agentMessaging === true ? 'Enabled' : 'Enable'}</Button>}
              />

              <div className="space-y-4">
                {projects.map((project) => {
                  const localId = resolveLocalSide(project.projectId, localSides)
                  const local = localId ? localSides.find((candidate) => candidate.id === localId) : undefined
                  return (
                    <div key={project.projectId} className="space-y-2 rounded-lg border border-border p-3">
                      <div className="flex items-center justify-between">
                        <strong className="text-sm">{project.name}</strong>
                        <span className="text-xs text-muted">
                          {local ? `your side: "${local.name}" · ` : 'no local side yet · '}
                          {project.members?.length ?? 0} members
                        </span>
                      </div>
                      {project.members?.map((member) => renderMember(project, member))}
                    </div>
                  )
                })}
              </div>
            </>
          ) : null}
          {error || status.error ? <p className="text-sm text-red-400">{error || status.error}</p> : null}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
