// Mutual auto-connect — the EFFECTFUL half (decisions: lib/hubAutoConnect.ts).
//
// "When I share a project, the people I share it with must be able to see my agents, and I must
// see theirs." A shared project has N members, each running their own copy; this controller opens
// every other online, sharing, approved member's copy as a remote tab — for BOTH sides, without
// anyone clicking Open — and keeps those tabs alive:
//
//  - a directory event (`member-online`, `member-approved`, `member-sharing`, a fresh `status`) or a
//    local binding change re-evaluates the target set and dials whatever is missing;
//  - a dropped socket greys the tab (existing behaviour: `handleRelayDrop`) and reconnects IN PLACE
//    on a bounded backoff while the member is still online — never a duplicate tab;
//  - a tab the USER closes is remembered (`settings.hubMutedMembers`) and not reopened until they
//    click Open in Settings > Team; `open()`/`close()` are the panel's toggle.
//
// Never moves the user's view: tabs open in the background (`activate: false`, `adoptProject`
// without activation) — the same rule an agent's `open-*` follows.
import type { HubApi, HubProject, HubStatus, Project, RelayClientApi } from '@shared/types'
import { memberTabKey, mutedMemberKeys, resolveLocalSide } from '@shared/hub-local-side'
import {
  autoConnectTargets,
  memberTabLabel,
  reconnectDelayMs,
  shouldRetry,
  type AutoConnectTarget
} from '../lib/hubAutoConnect'
import { openRelayTab, handleRelayDrop, type RelayTab } from './relay-tab'
import { disposeSession } from './session'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import { requestActiveReload } from '../state/activeReload'

/** Give up on a dial that keeps failing after this many attempts and wait for the next directory
 *  event instead — a member whose app refuses (a stale `sharing` flag, say) must not be dialled
 *  every 30 s forever. */
export const MAX_DIAL_ATTEMPTS = 8

export interface HubMemberTab {
  key: string
  hubProjectId: string
  accountId: string
  memberName: string
  machineLabel: string
  label: string
  projectId: string
  sessionId: string
  status: 'live' | 'offline'
}

export interface HubAutoConnectDeps {
  hub: Pick<HubApi, 'status' | 'listProjects' | 'connectMember' | 'onEvent'>
  relayClient: Pick<RelayClientApi, 'connect' | 'onClosed'>
  /** Open (or, with `reconnect`, re-mount onto the existing tab) a member's copy. */
  openTab(
    target: AutoConnectTarget,
    connectionId: string,
    reconnect?: { projectId: string; staleSessionId: string }
  ): Promise<RelayTab>
  /** hubProjectId → local project id, from the local projects (`resolveLocalSide`). */
  bindings(): Map<string, string>
  subscribeProjects(listener: () => void): () => void
  /** Does this project still exist as an OPEN tab? (`closed` or missing = the user closed it.) */
  projectOpen(projectId: string): boolean
  /** Remove a closed member project from the store (a closed relay tab is a dead bookmark). */
  dropProject(projectId: string): void
  muted(): Set<string>
  setMuted(keys: Set<string>): void
  subscribeSettings(listener: () => void): () => void
  onDrop(tab: RelayTab): void
  onRestored(tab: RelayTab, staleSessionId: string): void
  log?(message: string): void
}

export interface HubAutoConnectController {
  stop(): void
  /** The Team panel's Open: forget a mute and dial now. */
  open(hubProjectId: string, accountId: string): Promise<void>
  /** The Team panel's Close: mute and drop the tab. */
  close(hubProjectId: string, accountId: string): void
  /** A greyed member tab was clicked: reconnect it (true) — or it is not ours (false). */
  reconnect(projectId: string): boolean
  /** Re-list the Hub projects and dial whatever is missing. */
  refresh(): Promise<void>
  tabs(): HubMemberTab[]
  tabForProject(projectId: string): HubMemberTab | undefined
  projects(): HubProject[]
  status(): HubStatus
  subscribe(listener: () => void): () => void
}

interface Entry extends HubMemberTab {
  tab: RelayTab
  target: AutoConnectTarget
  unClose: () => void
}

export function startHubAutoConnect(deps: HubAutoConnectDeps): HubAutoConnectController {
  const tabs = new Map<string, Entry>()
  const inFlight = new Set<string>()
  const retries = new Map<string, ReturnType<typeof setTimeout>>()
  const listeners = new Set<() => void>()
  let hubProjects: HubProject[] = []
  let status: HubStatus = { state: 'disabled' }
  let stopped = false
  let listing: Promise<void> | null = null
  const log = deps.log ?? ((message: string) => console.warn(`[hub-auto-connect] ${message}`))

  const notify = (): void => { for (const listener of listeners) listener() }

  const decisionInput = () => ({
    myAccountId: status.state === 'connected' ? status.accountId : undefined,
    hubProjects,
    bindings: deps.bindings(),
    muted: deps.muted()
  })

  const cancelRetry = (key: string): void => {
    const timer = retries.get(key)
    if (timer) clearTimeout(timer)
    retries.delete(key)
  }

  /** Dial one member. `reconnect` re-mounts onto the greyed tab instead of adding one. */
  async function dial(target: AutoConnectTarget, reconnect?: { projectId: string; staleSessionId: string }, attempt = 0): Promise<void> {
    const { key } = target
    if (stopped || inFlight.has(key)) return
    if (!reconnect && tabs.has(key)) return
    inFlight.add(key)
    cancelRetry(key)
    try {
      const { offer } = await deps.hub.connectMember(target.hubProjectId, target.accountId)
      const connectionId = await deps.relayClient.connect(offer, { autoConfirm: true })
      const tab = await deps.openTab(target, connectionId, reconnect)
      if (stopped) {
        tab.dispose()
        return
      }
      const unClose = deps.relayClient.onClosed(connectionId, () => {
        unClose()
        onDropped(key, tab)
      })
      tabs.set(key, {
        key,
        hubProjectId: target.hubProjectId,
        accountId: target.accountId,
        memberName: target.memberName,
        machineLabel: target.machineLabel,
        label: target.label,
        projectId: tab.projectId,
        sessionId: tab.sessionId,
        status: 'live',
        tab,
        target,
        unClose
      })
      if (reconnect) deps.onRestored(tab, reconnect.staleSessionId)
      notify()
    } catch (error) {
      log(`could not open ${target.label}: ${error instanceof Error ? error.message : String(error)}`)
      scheduleRetry(target, reconnect, attempt + 1)
    } finally {
      inFlight.delete(key)
    }
  }

  function onDropped(key: string, tab: RelayTab): void {
    const entry = tabs.get(key)
    if (!entry || entry.tab !== tab) return
    entry.status = 'offline'
    deps.onDrop(tab)
    notify()
    scheduleRetry(entry.target, { projectId: tab.projectId, staleSessionId: tab.sessionId }, 0)
  }

  function scheduleRetry(target: AutoConnectTarget, reconnect: { projectId: string; staleSessionId: string } | undefined, attempt: number): void {
    if (stopped || attempt >= MAX_DIAL_ATTEMPTS) return
    if (!shouldRetry(target.key, target.hubProjectId, target.accountId, decisionInput())) return
    cancelRetry(target.key)
    retries.set(target.key, setTimeout(() => {
      retries.delete(target.key)
      void dial(target, reconnect, attempt)
    }, reconnectDelayMs(attempt)))
  }

  function evaluate(): void {
    if (stopped || status.state !== 'connected') return
    const targets = autoConnectTargets({
      ...decisionInput(),
      open: new Set(tabs.keys()),
      inFlight
    })
    for (const target of targets) void dial(target)
    // A greyed tab whose member is back online (or newly sharing) reconnects at once — the
    // backoff exists for a member whose app is stuck, not for one who just relaunched it.
    for (const entry of tabs.values()) {
      if (entry.status !== 'offline' || inFlight.has(entry.key) || retries.has(entry.key)) continue
      if (shouldRetry(entry.key, entry.hubProjectId, entry.accountId, decisionInput())) {
        void dial(entry.target, { projectId: entry.projectId, staleSessionId: entry.sessionId }, 0)
      }
    }
  }

  async function refresh(): Promise<void> {
    if (stopped || status.state !== 'connected') return
    if (listing) return listing
    listing = deps.hub.listProjects()
      .then((projects) => {
        hubProjects = projects
        notify()
        evaluate()
      })
      .catch((error) => log(`could not list the shared projects: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { listing = null })
    return listing
  }

  /** Forget a member tab: run its teardown, drop the store's copy, and stop retrying. */
  function forget(entry: Entry, dropProject: boolean): void {
    tabs.delete(entry.key)
    cancelRetry(entry.key)
    entry.unClose()
    entry.tab.dispose()
    if (dropProject) deps.dropProject(entry.projectId)
    notify()
  }

  const setMutedKey = (key: string, on: boolean): void => {
    const next = new Set(deps.muted())
    if (on) next.add(key)
    else next.delete(key)
    deps.setMuted(next)
  }

  const unsubscribeHub = deps.hub.onEvent((event) => {
    if (stopped) return
    if (event.type === 'status') {
      status = event.status
      notify()
      if (status.state === 'connected') void refresh()
      return
    }
    if (event.type === 'member-offline') {
      // Their socket drop greys the tab on its own; stop any retry aimed at a member who is gone.
      for (const entry of tabs.values()) if (entry.accountId === event.accountId) cancelRetry(entry.key)
      void refresh()
      return
    }
    if (event.type === 'member-online' || event.type === 'member-approved' || event.type === 'member-sharing' ||
        event.type === 'member-joined' || event.type === 'member-declined') {
      void refresh()
    }
  })

  // A tab the user closed (or deleted) is a deliberate "not now": remember it and stop dialling.
  const unsubscribeProjects = deps.subscribeProjects(() => {
    if (stopped) return
    for (const entry of [...tabs.values()]) {
      if (deps.projectOpen(entry.projectId)) continue
      setMutedKey(entry.key, true)
      forget(entry, true)
    }
    evaluate() // a new binding (Share / Join) is a new reason to dial
  })

  // An unmute (Open in Team, or a hand edit of settings.json) is a reason to dial again.
  const unsubscribeSettings = deps.subscribeSettings(() => { if (!stopped) evaluate() })

  void deps.hub.status().then((initial) => {
    if (stopped) return
    status = initial
    notify()
    if (status.state === 'connected') void refresh()
  }).catch(() => undefined)

  return {
    stop() {
      stopped = true
      unsubscribeHub()
      unsubscribeProjects()
      unsubscribeSettings()
      for (const key of [...retries.keys()]) cancelRetry(key)
      for (const entry of [...tabs.values()]) {
        entry.unClose()
        entry.tab.dispose()
      }
      tabs.clear()
      listeners.clear()
    },
    async open(hubProjectId, accountId) {
      const key = memberTabKey(hubProjectId, accountId)
      setMutedKey(key, false)
      await refresh()
      const existing = tabs.get(key)
      if (existing?.status === 'offline') {
        await dial(existing.target, { projectId: existing.projectId, staleSessionId: existing.sessionId }, 0)
        return
      }
      if (existing) return
      const target = autoConnectTargets({ ...decisionInput(), open: new Set(), inFlight: new Set() })
        .find((candidate) => candidate.key === key)
      if (target) await dial(target)
    },
    close(hubProjectId, accountId) {
      const key = memberTabKey(hubProjectId, accountId)
      setMutedKey(key, true)
      const entry = tabs.get(key)
      if (entry) forget(entry, true)
      else cancelRetry(key)
    },
    reconnect(projectId) {
      const entry = [...tabs.values()].find((candidate) => candidate.projectId === projectId)
      if (!entry) return false
      if (entry.status === 'offline' && !inFlight.has(entry.key)) {
        void dial(entry.target, { projectId: entry.projectId, staleSessionId: entry.sessionId }, 0)
      }
      return true
    },
    refresh,
    tabs: () => [...tabs.values()].map(({ tab: _tab, target: _target, unClose: _un, ...rest }) => rest),
    tabForProject: (projectId) => {
      const entry = [...tabs.values()].find((candidate) => candidate.projectId === projectId)
      if (!entry) return undefined
      const { tab: _tab, target: _target, unClose: _un, ...rest } = entry
      return rest
    },
    projects: () => hubProjects,
    status: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}

// ── Production wiring ────────────────────────────────────────────────────────────────────────────

/** hubProjectId → local project id, over the renderer's projects (one resolver: @shared). */
export function localBindings(projects: readonly Project[]): Map<string, string> {
  const map = new Map<string, string>()
  const candidates = projects.filter((project) => !project.remote)
  for (const project of candidates) {
    if (project.hubProjectId && !map.has(project.hubProjectId)) map.set(project.hubProjectId, project.id)
  }
  return map
}

/** Every member of the Hub projects listed, as a local-side lookup — the legacy id match makes an
 *  owner who shared before bindings existed resolve through the SAME rule main uses. */
export function bindingsFor(projects: readonly Project[], hubProjects: readonly HubProject[]): Map<string, string> {
  const map = localBindings(projects)
  const candidates = projects.filter((project) => !project.remote)
  for (const shared of hubProjects) {
    if (map.has(shared.projectId)) continue
    const legacy = resolveLocalSide(shared.projectId, candidates)
    if (legacy) map.set(shared.projectId, legacy)
  }
  return map
}

let singleton: HubAutoConnectController | null = null

/** The app's one controller (App.tsx mounts it; the Team panel and Canvas read it). */
export function hubMemberTabs(): HubAutoConnectController | null {
  return singleton
}

export function mountHubAutoConnect(): () => void {
  const api = window.nodeTerminal
  let controller: HubAutoConnectController
  const deps: HubAutoConnectDeps = {
    hub: api.hub,
    relayClient: api.relayClient,
    openTab: (target, connectionId, reconnect) =>
      // Session label = the member (renders as the tab's session badge, like "This Mac" on a local
      // tab); tab name = the project. Passing the combined label to both painted
      // "Project 1 · Hermano  Project 1 · Hermano" on the tab strip.
      openRelayTab(connectionId, target.memberName, {
        relayClient: api.relayClient,
        addProject: reconnect ? () => ({ id: reconnect.projectId }) : (name) => useProjects.getState().addProject(name),
        adoptProject: reconnect ? undefined : (project) => useProjects.getState().adoptProject(project, { activate: false }),
        setActiveProject: (id) => useProjects.getState().setActive(id),
        activate: false,
        tabName: target.projectName,
        hostAccountId: target.accountId,
        memberName: target.memberName,
        machineLabel: target.machineLabel,
        hubProjectId: target.hubProjectId,
        refreshProject: (projectId, hostProject) => {
          const store = useProjects.getState()
          const existing = store.getProject(projectId)
          if (!existing) return
          store.replaceProject({
            ...existing,
            nodes: hostProject.nodes,
            ...(hostProject.bridges ? { bridges: hostProject.bridges } : {}),
            ...(hostProject.ropes ? { ropes: hostProject.ropes } : {})
          })
          if (store.activeProjectId === projectId) requestActiveReload()
        }
      }),
    bindings: () => bindingsFor(useProjects.getState().projects, controller?.projects() ?? []),
    subscribeProjects: (listener) => useProjects.subscribe(listener),
    projectOpen: (projectId) => {
      const project = useProjects.getState().getProject(projectId)
      return !!project && !project.closed
    },
    dropProject: (projectId) => {
      if (useProjects.getState().getProject(projectId)) useProjects.getState().deleteProject(projectId)
    },
    muted: () => mutedMemberKeys(useSettings.getState().settings.hubMutedMembers),
    setMuted: (keys) => useSettings.getState().update({ hubMutedMembers: [...keys].sort() }),
    subscribeSettings: (listener) => {
      let last = useSettings.getState().settings.hubMutedMembers
      return useSettings.subscribe((state) => {
        if (state.settings.hubMutedMembers === last) return
        last = state.settings.hubMutedMembers
        listener()
      })
    },
    onDrop: (tab) => handleRelayDrop(tab, {
      setProjectUnavailable: (id, value) => useProjects.getState().setProjectUnavailable(id, value)
    }),
    onRestored: (tab, staleSessionId) => {
      disposeSession(staleSessionId)
      useProjects.getState().setProjectUnavailable(tab.projectId, false)
    }
  }
  controller = startHubAutoConnect(deps)
  singleton = controller
  return () => {
    controller.stop()
    if (singleton === controller) singleton = null
  }
}

export { memberTabLabel }
