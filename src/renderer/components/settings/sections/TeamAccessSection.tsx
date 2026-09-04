import { useEffect, useMemo, useState } from 'react'
import type { HubProject, HubStatus } from '@shared/types'
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
import { thisMachineCap } from '../../../lib/machineName'

const ROW = {
  title: 'OhLab Hub',
  keywords: ['team', 'hub', 'invite', 'share', 'collaborate', 'remote', 'member']
}

export function TeamAccessSection({ isActive }: { isActive: boolean; onClose?: () => void }): React.JSX.Element {
  const settings = useSettings((state) => state.settings)
  const updateSettings = useSettings((state) => state.update)
  const activeProject = useProjects((state) => state.projects.find((project) => project.id === state.activeProjectId))
  const [hubUrl, setHubUrl] = useState(settings.hubUrl)
  const [accountName, setAccountName] = useState(settings.hubAccountName || loadIdentity()?.name || '')
  const [status, setStatus] = useState<HubStatus>({ state: settings.hubUrl ? 'connecting' : 'disabled' })
  const [projects, setProjects] = useState<HubProject[]>([])
  const [joinCode, setJoinCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    const next = await window.nodeTerminal.hub.listProjects()
    setProjects(next)
  }

  useEffect(() => {
    if (!isActive) return
    void window.nodeTerminal.hub.status().then(setStatus)
    const unsub = window.nodeTerminal.hub.onEvent((event) => {
      if (event.type === 'status') setStatus(event.status)
      else void refresh().catch(() => {})
    })
    if (settings.hubUrl) void refresh().catch(() => {})
    return unsub
  }, [isActive, settings.hubUrl])

  const myHubProject = useMemo(
    () => projects.find((project) => project.projectId === activeProject?.id || project.name === activeProject?.name),
    [projects, activeProject]
  )

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
      setStatus(await window.nodeTerminal.hub.connect())
      await refresh()
    })
  }

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
            <FieldRow label="Hub URL" control={<Input className="w-80" value={hubUrl} placeholder="http://hub.tailnet:8791" onChange={(event) => setHubUrl(event.target.value)} />} />
            <FieldRow label="Account name" control={<Input className="w-80" value={accountName} placeholder="Your name" onChange={(event) => setAccountName(event.target.value)} />} />
            <div className="flex items-center gap-3">
              <Button variant="primary" disabled={busy || !hubUrl.trim()} onClick={connect}>Connect</Button>
              <span className="text-sm text-muted">{status.state}{status.accountName ? ` as ${status.accountName}` : ''}</span>
            </div>
          </div>

          {status.state === 'connected' ? (
            <>
              <div className="space-y-3">
                <h4 className="text-[13px] font-medium text-text">Share this project</h4>
                {myHubProject ? (
                  <div className="flex items-center gap-2">
                    <Input className="w-72" readOnly value={myHubProject.inviteCode} onFocus={(event) => event.target.select()} />
                    <CopyButton text={myHubProject.inviteCode} label="Copy invite" />
                    <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.regenerateInvite(myHubProject.projectId); await refresh() })}>Regenerate</Button>
                  </div>
                ) : (
                  <Button disabled={busy || !activeProject} onClick={() => void run(async () => { await window.nodeTerminal.hub.createProject(activeProject?.name ?? 'Shared project', activeProject?.id); await refresh() })}>Share this project</Button>
                )}
              </div>

              <div className="space-y-3">
                <h4 className="text-[13px] font-medium text-text">Join with code</h4>
                <div className="flex items-center gap-2">
                  <Input className="w-72" value={joinCode} onChange={(event) => setJoinCode(event.target.value)} placeholder="Invite code" />
                  <Button disabled={busy || !joinCode.trim()} onClick={() => void run(async () => { await window.nodeTerminal.hub.joinProject(joinCode.trim()); setJoinCode(''); await refresh() })}>Join</Button>
                </div>
              </div>

              <div className="space-y-4">
                {projects.map((project) => (
                  <div key={project.projectId} className="space-y-2 rounded-lg border border-border p-3">
                    <div className="flex items-center justify-between"><strong className="text-sm">{project.name}</strong><span className="text-xs text-muted">{project.members?.length ?? 0} members</span></div>
                    {project.members?.map((member) => (
                      <div key={member.accountId} className="flex items-center justify-between gap-3 text-sm">
                        <span><span aria-label={member.online ? 'online' : 'offline'} className={`mr-2 inline-block h-2 w-2 rounded-full ${member.online ? 'bg-green-500' : 'bg-muted'}`} />{member.name} <span className="text-xs text-muted">{member.status}</span></span>
                        <div className="flex gap-2">
                          {member.status === 'pending' && project.ownerAccountId === status.accountId ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.approveMember(project.projectId, member.accountId); await refresh() })}>Approve</Button> : null}
                          {member.role !== 'owner' && project.ownerAccountId === status.accountId ? <Button onClick={() => void run(async () => { await window.nodeTerminal.hub.removeMember(project.projectId, member.accountId); await refresh() })}>Remove</Button> : null}
                          {member.accountId !== status.accountId && member.status === 'approved' ? <Button disabled={!member.online} onClick={() => openMember(project, member.accountId, member.name)}>Open</Button> : null}
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
