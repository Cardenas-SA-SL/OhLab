import { useEffect, useMemo, useState } from 'react'
import type { HubHostStatus, HubProject, HubStatus } from '@shared/types'
import { decodeHubInvite, encodeHubInvite } from '@shared/hub-invite'
import { useSettings } from '../../../state/settings'
import { useProjects } from '../../../state/projects'
import { loadIdentity } from '../../../state/presence'
import { openRelayTab } from '../../../session/relay-tab'
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

export function TeamAccessSection({ isActive }: { isActive: boolean; onClose?: () => void }): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  const updateSettings = useSettings((state) => state.update)
  const activeProject = useProjects((state) => state.projects.find((project) => project.id === state.activeProjectId))
  const setProjectCapability = useProjects((state) => state.setProjectCapability)
  const [hubUrl, setHubUrl] = useState(settings.hubUrl)
  const [accountName, setAccountName] = useState(settings.hubAccountName || loadIdentity()?.name || '')
  const [status, setStatus] = useState<HubStatus>({ state: settings.hubUrl ? 'connecting' : 'disabled' })
  const [hostStatus, setHostStatus] = useState<HubHostStatus>({ state: settings.hubHostEnabled ? 'starting' : 'disabled' })
  const [projects, setProjects] = useState<HubProject[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [joinName, setJoinName] = useState(accountName)
  const [waiting, setWaiting] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
        setWaiting('Approved. You can now open the owner\'s project.')
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

  const myHubProject = useMemo(
    () => projects.find((project) => project.projectId === activeProject?.id || project.name === activeProject?.name),
    [projects, activeProject]
  )
  const canManageActiveProject = canManageHubProject(myHubProject, status)

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

  const join = (): void => {
    void run(async () => {
      const invite = decodeHubInvite(joinCode)
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
      setWaiting(`Waiting for the owner to approve ${project.name}. Both sides need agent messaging enabled.`)
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

  const openMember = (project: HubProject, accountId: string, label: string): void => {
    void run(async () => {
      const { offer } = await window.nodeTerminal.hub.connectMember(
        project.projectId,
        accountId,
        thisMachineCap()
      )
      const connectionId = await window.nodeTerminal.relayClient.connect(offer, { autoConfirm: true })
      const mounting = openRelayTab(connectionId, label, {
        relayClient: window.nodeTerminal.relayClient,
        addProject: (name) => useProjects.getState().addProject(name),
        adoptProject: (remote) => useProjects.getState().adoptProject(remote),
        setActiveProject: (id) => useProjects.getState().setActive(id),
        hostAccountId: accountId,
        memberName: project.members?.find((m) => m.accountId === accountId)?.name ?? label,
        machineLabel: `${label}'s computer`
      })
      await mounting
    })
  }

  return (
    <SettingsSection id="team-access" title="Team" description="Connect to your self-hosted OhLab Hub and share projects with approved members." isActive={isActive} searchEntries={[ROW]}>
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
              <span className="text-sm text-muted">{status.state}{status.accountName ? ` as ${status.accountName}` : ''}</span>
            </div>
          </div>

          <div className="space-y-3">
            <h4 className="text-[13px] font-medium text-text">Join with an invite code</h4>
            <div className="flex items-center gap-2">
              <Input className="w-72" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="ohlab-invite:..." />
              <Input className="w-44" value={joinName} onChange={(event) => setJoinName(event.target.value)} placeholder="Your name" />
              <Button disabled={busy || !joinCode.trim()} onClick={join}>Join</Button>
            </div>
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
                    <Button disabled={busy || !activeProject} onClick={() => void run(async () => { await window.nodeTerminal.hub.createProject(activeProject?.name ?? 'Shared project', activeProject?.id); await refresh() })}>Share this project</Button>
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
                {projects.map((project) => (
                  <div key={project.projectId} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between"><strong className="text-sm">{project.name}</strong><span className="text-xs text-muted">{project.members?.length ?? 0} members</span></div>
                    {project.members?.map((member) => (
                      <div key={member.accountId} className="flex items-center justify-between gap-3 text-sm">
                        <span><span aria-label={member.online ? 'online' : 'offline'} className={`mr-2 inline-block h-2 w-2 rounded-full ${member.online ? 'bg-green-500' : 'bg-muted'}`} />{member.name} <span className="text-xs text-muted">{member.machineLabel ? `· ${member.machineLabel} ` : ''}· {member.role} · {member.status}</span>{status.verifyCodes?.[member.publicKeyB64] ? <span className="ml-2 text-xs text-muted" title="The code both computers derived for this pair of identities. Compare it with this member once, out of band: it is the same on both screens only if the Hub gave each side the other's real key.">verify code <strong className="font-mono">{status.verifyCodes[member.publicKeyB64]}</strong></span> : null}</span>
                        <div className="flex gap-2">
                          {member.status === 'pending' && project.ownerAccountId === status.accountId ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.approveMember(project.projectId, member.accountId); await refresh() })}>Approve</Button> : null}
                          {member.status === 'pending' && project.ownerAccountId === status.accountId ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.removeMember(project.projectId, member.accountId); await refresh() })}>Decline</Button> : null}
                          {member.role !== 'owner' && member.status === 'approved' && project.ownerAccountId === status.accountId ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.removeMember(project.projectId, member.accountId); await refresh() })}>Remove</Button> : null}
                          {member.accountId !== status.accountId && member.status === 'approved' ? <Button title={!member.online ? 'This member is offline' : undefined} disabled={!member.online} onClick={() => openMember(project, member.accountId, member.name)}>Open</Button> : null}
                        </div>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          ) : null}
          {error || status.error ? <p className="text-sm text-red-400">{error || status.error}</p> : null}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
