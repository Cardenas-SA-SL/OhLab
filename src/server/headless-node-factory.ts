import { randomBytes, randomUUID } from 'node:crypto'

import { publishCanvasMutation } from '../core/canvas-sync'
import { gateProjectTarget } from '../core/project-grants'
import { applyStickyWrite, parseStickyArgs, resolveStickyRef } from '../shared/sticky-write'
import type { WorkspaceStore } from '../core/workspace-store'
import {
  AGENT_CONFIG,
  canContextLink,
  canControlCanvas,
  gatePermissionMode,
  hasHooks,
  resolvePermissionMode,
  supportsSessionIdFlag,
  type AgentId,
  type BuiltinAgentId
} from '../shared/agents/config'
import { assembleLaunchCommand } from '../shared/agents/launch'
import type { AgentState, NormalizedAgentEvent } from '../shared/agents/normalize'
import { oneLine } from '../shared/one-line'
import type {
  BridgeLink,
  CanvasNodeState,
  ClaudeCliCaps,
  Project,
  PtyCreateOptions,
  PtyCreateResult,
  Settings,
  Workspace
} from '../shared/types'

export interface ServerControlReply {
  ok: boolean
  message?: string
  result?: unknown
  error?: string
}

/** The PtyManager surface the headless factory uses, kept narrow for deterministic tests. */
export interface HeadlessPty {
  createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
}

/** WorkspaceStore's mutation surface, also narrow so tests can use the real store or a fake. */
export type HeadlessWorkspace = Pick<WorkspaceStore, 'load' | 'save'>

export interface HeadlessNodeFactoryDeps {
  workspaceStore: HeadlessWorkspace
  ptyManager: HeadlessPty
  settings(): Settings
  cliCaps(): Promise<ClaudeCliCaps>
  /** Hook-mirror lookups. A stored agentId wins; these cover a plain terminal running an agent. */
  stateOf(nodeId: string): AgentState | undefined
  agentIdOf?(nodeId: string): string | undefined
  env?: Record<string, string | undefined>
  now?: () => number
  publishNode?: (projectId: string, node: CanvasNodeState) => void
  publishProject?: (project: Project) => void
  schedule?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearSchedule?: (timer: ReturnType<typeof setTimeout>) => void
}

const TERMINAL_LIMIT = 8
const AGENT_LIMIT = 5
const TERMINAL_COLS = 120
const TERMINAL_ROWS = 36
const NODE_COLORS = ['#0a84ff', '#32d74b', '#ffd60a', '#ff453a', '#bf5af2', '#6ac4dc', '#ff9f0a']
const TERMINAL_SIZE = { width: 640, height: 440 }
const STICKY_SIZE = { width: 240, height: 200 }
const H_GAP = 80
const V_GAP = 36
const AFTER_RETRY_MS = 500
const AFTER_RETRY_LIMIT = 5
const SERVER_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'gemini'])

function token(): string {
  return randomBytes(4).toString('hex')
}

function nextId(prefix: 'term' | 'sticky'): string {
  return `${prefix}-${Date.now().toString(36)}-${token()}`
}

function edgeId(prefix: string, source: string, target: string): string {
  return `${prefix}-${source}-${target}-${token()}`
}

function parseCount(raw: string | undefined, max: number): number {
  return Math.max(1, Math.min(max, Number.parseInt(raw || '1', 10) || 1))
}

function terminalSize(settings: Settings): { width: number; height: number } {
  const clamp = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
    return Math.min(max, Math.max(min, n))
  }
  return {
    width: clamp(settings.defaultNodeWidth, 280, 2400, TERMINAL_SIZE.width),
    height: clamp(settings.defaultNodeHeight, 160, 1600, TERMINAL_SIZE.height)
  }
}

function unsupportedFlags(
  args: Record<string, string>,
  allowed: ReadonlySet<string>
): string | undefined {
  const unknown = Object.keys(args).find((key) => !allowed.has(key))
  return unknown ? `--${unknown} is not supported by Server Edition canvas control` : undefined
}

function sourceProject(workspace: Workspace, nodeId: string): { project: Project; node: CanvasNodeState } | null {
  const matches: Array<{ project: Project; node: CanvasNodeState }> = []
  for (const project of workspace.projects) {
    const node = project.nodes.find((candidate) => candidate.id === nodeId)
    if (node) matches.push({ project, node })
  }
  return matches.length === 1 ? matches[0] : null
}

function effectiveAgentId(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): AgentId {
  return (node.agentId || runtimeAgentId?.(node.id) || 'claude') as AgentId
}

function sourceCanControl(
  node: CanvasNodeState,
  runtimeAgentId: ((nodeId: string) => string | undefined) | undefined
): boolean {
  return canControlCanvas(effectiveAgentId(node, runtimeAgentId))
}

function absolutePosition(project: Project, node: CanvasNodeState): { x: number; y: number } {
  let x = node.position.x
  let y = node.position.y
  let parent = node.parentId
  const seen = new Set<string>()
  while (parent && !seen.has(parent)) {
    seen.add(parent)
    const p = project.nodes.find((candidate) => candidate.id === parent)
    if (!p) break
    x += p.position.x
    y += p.position.y
    parent = p.parentId
  }
  return { x, y }
}

function placeRight(
  project: Project,
  source: CanvasNodeState,
  index: number,
  size: { width: number; height: number }
): { x: number; y: number } {
  const origin = absolutePosition(project, source)
  const sourceWidth = source.size?.width || TERMINAL_SIZE.width
  const column = Math.floor(index / 3)
  const row = index % 3
  return {
    x: origin.x + sourceWidth + H_GAP + column * (size.width + H_GAP),
    y: origin.y + row * (size.height + V_GAP)
  }
}

function addEdge(list: BridgeLink[], source: string, target: string, prefix: string): void {
  if (source === target) return
  if (list.some((edge) =>
    (edge.source === source && edge.target === target) ||
    (edge.source === target && edge.target === source))) return
  list.push({ id: edgeId(prefix, source, target), source, target })
}

function ptyOptions(project: Project, node: CanvasNodeState): PtyCreateOptions {
  return {
    cwd: node.cwd || project.cwd,
    cols: TERMINAL_COLS,
    rows: TERMINAL_ROWS,
    persistKey: node.id,
    ownerProjectId: project.id,
    ...(node.agentId ? { agentId: node.agentId } : {}),
    ...(node.agentModel ? { agentModel: node.agentModel } : {}),
    ...(node.accountId ? { accountId: node.accountId } : {})
  }
}

/**
 * Server-side canvas authoring and launch scheduler.
 *
 * Every workspace read/modify/save transaction is serialized. That is important even on one
 * Node event loop: WorkspaceStore.load/save both await filesystem operations, so two simultaneous
 * `/control/open-agent` calls would otherwise read the same snapshot and the later save would
 * erase the earlier node. PTY creation happens after the node is durable, matching the renderer's
 * recoverable failure direction: a spawn error leaves a visible, reopenable node instead of an
 * invisible tmux session.
 */
export class HeadlessNodeFactory {
  private serial: Promise<unknown> = Promise.resolve()
  private attached = new Set<string>()
  /** Fresh server-spawned agents that have not emitted their first real working turn yet. */
  private awaitingFirstWorking = new Set<string>()
  private retryCount = new Map<string, number>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(private readonly deps: HeadlessNodeFactoryDeps) {}

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work)
    this.serial = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private publish(project: Project, nodes: readonly CanvasNodeState[]): void {
    this.deps.publishProject?.(project)
    const publish = this.deps.publishNode ?? ((projectId: string, node: CanvasNodeState) => {
      publishCanvasMutation(projectId, { op: 'upsert', node })
    })
    for (const node of nodes) publish(project.id, node)
  }

  private async attach(project: Project, node: CanvasNodeState): Promise<PtyCreateResult> {
    if (this.attached.has(node.id)) {
      return { sessionId: node.id, fresh: false }
    }
    const result = await this.deps.ptyManager.createHeadless(ptyOptions(project, node))
    if (result.sessionId) this.attached.add(node.id)
    return result
  }

  private resolveTarget(
    workspace: Workspace,
    source: { project: Project; node: CanvasNodeState },
    verb: string,
    args: Record<string, string>,
    verified: boolean
  ): Project | ServerControlReply {
    const targetId = args.project || source.project.id
    const target = workspace.projects.find((project) => project.id === targetId)
    const gate = gateProjectTarget({
      verified,
      verb,
      targetProjectId: args.project || undefined,
      callerProjectId: source.project.id,
      targetIsSsh: target ? !!target.ssh : undefined,
      // `open-project` is not part of Server Edition v1, so this runtime never mints a grant.
      granted: false
    })
    if (gate !== 'allow') return { ok: false, error: gate.refuse }
    if (!target) return { ok: false, error: 'project-target-refused: target project is unavailable' }
    if (target.ssh) {
      return {
        ok: false,
        error: 'project-target-ssh-unsupported: Server Edition v1 only creates local sessions'
      }
    }
    return target
  }

  private resolveAfter(
    project: Project,
    raw: string | undefined,
    verb: string
  ): string[] | ServerControlReply {
    if (!raw) return []
    const ids = [...new Set(raw.split(',').map((id) => id.trim()).filter(Boolean))]
    for (const id of ids) {
      const node = project.nodes.find((candidate) => candidate.id === id)
      if (!node) return { ok: false, error: `${verb}: --after names no existing node (${id})` }
      const agentId = effectiveAgentId(node, this.deps.agentIdOf)
      if (!hasHooks(agentId)) {
        return {
          ok: false,
          error: `${verb}: --after ${id} is not an agent session that reports when it is done`
        }
      }
    }
    return ids
  }

  async openTerminal(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-terminal', args, verified)
  }

  async openAgent(
    sourceNodeId: string,
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.open(sourceNodeId, 'open-agent', args, verified)
  }

  private open(
    sourceNodeId: string,
    verb: 'open-terminal' | 'open-agent',
    args: Record<string, string>,
    verified: boolean
  ): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const flagError = unsupportedFlags(
        args,
        verb === 'open-terminal'
          ? new Set(['count', 'cwd', 'cmd', 'after', 'project'])
          : new Set(['agent', 'count', 'cwd', 'prompt', 'after', 'project', 'model'])
      )
      if (flagError) return { ok: false, error: `${verb}: ${flagError}` }

      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }
      const target = this.resolveTarget(workspace, source, verb, args, verified)
      if ('ok' in target) return target
      const after = this.resolveAfter(target, args.after, verb)
      if (!Array.isArray(after)) return after

      const settings = this.deps.settings()
      const nodeSize = terminalSize(settings)
      const caps = verb === 'open-agent' ? await this.deps.cliCaps() : null
      const agentId = args.agent as BuiltinAgentId | undefined
      if (verb === 'open-agent' && (!agentId || !SERVER_AGENTS.has(agentId))) {
        return {
          ok: false,
          error: 'open-agent: Server Edition v1 supports --agent claude|codex|gemini'
        }
      }

      const count = parseCount(args.count, verb === 'open-terminal' ? TERMINAL_LIMIT : AGENT_LIMIT)
      const created: CanvasNodeState[] = []
      const commands = new Map<string, string>()
      const ropes = [...(target.ropes ?? [])]
      const bridges = [...(target.bridges ?? [])]
      const startIndex = target.nodes.length
      const cwd = args.cwd || (target.id === source.project.id ? source.node.cwd : undefined) || target.cwd
      // Snapshot dependency state at the arm boundary. A `working` state is already positive
      // evidence that this fresh process made it through its boot composer; a later `done` may
      // release it. An unknown/waiting fresh spawn needs a working event after this snapshot.
      const afterStates = new Map(after.map((depId) => [depId, this.deps.stateOf(depId)]))
      for (const [depId, state] of afterStates) {
        if (state === 'working') this.awaitingFirstWorking.delete(depId)
      }
      const mustWait = after.some((depId) => afterStates.get(depId) !== 'done')
      const awaitWorking = after.filter((depId) =>
        afterStates.get(depId) !== 'done' &&
        afterStates.get(depId) !== 'working' &&
        this.awaitingFirstWorking.has(depId)
      )

      for (let i = 0; i < count; i++) {
        let command = args.cmd
        let title = `Terminal ${startIndex + i + 1}`
        let color = NODE_COLORS[(startIndex + i) % NODE_COLORS.length]
        let mintedSessionId: string | undefined
        let permissionMode
        if (verb === 'open-agent') {
          const config = AGENT_CONFIG[agentId as BuiltinAgentId]
          title = config.label
          color = config.color
          const resolvedMode = resolvePermissionMode(target, settings)
          permissionMode = agentId === 'claude'
            ? gatePermissionMode(resolvedMode, caps?.autoPermissionMode === true)
            : resolvedMode
          const sessionIdFlagSupported = supportsSessionIdFlag(
            agentId as AgentId,
            caps?.sessionIdFlag === true
          )
          mintedSessionId = sessionIdFlagSupported ? randomUUID() : undefined
          command = assembleLaunchCommand(
            {
              agentId: agentId as AgentId,
              initialPrompt: args.prompt,
              permissionMode,
              sessionId: mintedSessionId,
              sessionIdFlagSupported,
              launchCmdOverride: settings.agentLaunchCommands?.[agentId as BuiltinAgentId],
              sharedIdentity: false,
              model: args.model
            },
            this.deps.env ?? process.env
          ).command
        }

        const id = nextId('term')
        // Match the desktop's `armAfter`: if every dependency is already done, launch now rather
        // than persisting a wait that has no future edge left to wake it.
        const pendingLaunch = command && mustWait
          ? {
              after,
              command,
              executor: 'server' as const,
              ...(awaitWorking.length ? { awaitWorking: [...awaitWorking] } : {})
            }
          : undefined
        const node: CanvasNodeState = {
          id,
          kind: 'terminal',
          position: placeRight(target, source.node, i, nodeSize),
          size: { ...nodeSize },
          title,
          ...(verb === 'open-agent' ? { titleAuto: true } : {}),
          color,
          group: null,
          tags: [],
          cwd,
          ...(verb === 'open-agent' ? { agentId: agentId as AgentId } : {}),
          ...(args.model && verb === 'open-agent' ? { agentModel: args.model } : {}),
          ...(mintedSessionId ? { agentSessionId: mintedSessionId } : {}),
          ...(source.node.accountId && verb === 'open-agent' &&
          (agentId === 'claude' || agentId === 'codex')
            ? { accountId: source.node.accountId }
            : {}),
          ...(pendingLaunch ? { pendingLaunch } : {})
        }
        created.push(node)
        if (command && !pendingLaunch) commands.set(id, command)
        addEdge(ropes, source.node.id, id, 'ctrl')

        if (verb === 'open-agent') {
          const sourceAgent = effectiveAgentId(source.node, this.deps.agentIdOf)
          if (canContextLink(sourceAgent) && canContextLink(agentId as AgentId)) {
            addEdge(bridges, source.node.id, id, 'link')
          }
          for (const depId of after) {
            const dep = target.nodes.find((candidate) => candidate.id === depId)
            if (dep && canContextLink(effectiveAgentId(dep, this.deps.agentIdOf)) &&
              canContextLink(agentId as AgentId)) addEdge(bridges, id, depId, 'link')
          }
        }
      }

      target.nodes.push(...created)
      target.ropes = ropes
      target.bridges = bridges
      await this.deps.workspaceStore.save(workspace)
      this.publish(target, created)

      const failed: string[] = []
      for (const node of created) {
        try {
          const result = await this.attach(target, node)
          if (!result.sessionId) {
            failed.push(node.id)
            continue
          }
          if (verb === 'open-agent' && result.fresh) this.awaitingFirstWorking.add(node.id)
          const command = commands.get(node.id)
          if (command && !(await this.deps.ptyManager.sendText(node.id, command))) failed.push(node.id)
        } catch {
          failed.push(node.id)
        }
      }

      const ids = created.map((node) => node.id)
      if (failed.length) {
        return {
          ok: false,
          error:
            `launch-failed: node(s) ${failed.join(', ')} were persisted but their PTY or initial ` +
            'command could not be started; do not repeat the open request',
          result: { ids, id: ids[0], after, failed }
        }
      }
      return {
        ok: true,
        message:
          `opened ${count} ${verb === 'open-agent' ? `${agentId} session` : 'terminal'}(s): ` +
          ids.join(', ') +
          (after.length ? `; waiting for ${after.join(', ')} before running` : ''),
        result: { ids, id: ids[0], after }
      }
    })
  }

  sticky(sourceNodeId: string, args: Record<string, string>): Promise<ServerControlReply> {
    return this.runExclusive(async () => {
      const parsed = parseStickyArgs(args)
      if ('error' in parsed) return { ok: false, error: `sticky: ${parsed.error}` }
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const source = sourceProject(workspace, sourceNodeId)
      if (!source) return { ok: false, error: 'source node is not in exactly one saved project' }
      if (!sourceCanControl(source.node, this.deps.agentIdOf)) {
        return { ok: false, error: 'source node is not a control-capable agent' }
      }

      const candidates = source.project.nodes.map((node) => ({
        id: node.id,
        sticky: node.kind === 'sticky',
        title: node.title
      }))
      const resolved = resolveStickyRef(candidates, parsed.ref)
      if ('error' in resolved) return { ok: false, error: `sticky: ${resolved.error}` }

      let node: CanvasNodeState | undefined
      let created = false
      if ('id' in resolved) node = source.project.nodes.find((candidate) => candidate.id === resolved.id)
      else if (parsed.create) {
        created = true
        node = {
          id: nextId('sticky'),
          kind: 'sticky',
          position: placeRight(source.project, source.node, 0, STICKY_SIZE),
          size: { ...STICKY_SIZE },
          title: oneLine(parsed.ref) || 'Note',
          color: '#ffd60a',
          group: null,
          text: ''
        }
        source.project.nodes.push(node)
        const ropes = [...(source.project.ropes ?? [])]
        addEdge(ropes, source.node.id, node.id, 'ctrl')
        source.project.ropes = ropes
      } else {
        return {
          ok: false,
          error: `sticky: no note named "${parsed.ref}"; pass --create yes to create it`
        }
      }
      if (!node) return { ok: false, error: 'sticky: note disappeared while resolving it' }

      const write = applyStickyWrite(node.text ?? '', parsed.write)
      if ('error' in write) return { ok: false, error: `sticky: ${write.error}` }
      node.text = write.text
      node.textUpdatedAt = (this.deps.now ?? Date.now)()
      node.textUpdatedBy = source.node.title || source.node.id
      await this.deps.workspaceStore.save(workspace)
      this.publish(source.project, [node])
      return {
        ok: true,
        message: `${created ? 'created' : 'updated'} sticky ${node.id} (${write.mode})`,
        result: { id: node.id, created, mode: write.mode }
      }
    })
  }

  /** Reattach persisted server-owned armed nodes at boot, then fire anything already satisfied. */
  start(): Promise<void> {
    return this.refreshArmed()
  }

  onAgentEvent(event: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): void {
    if (this.stopped || !event?.nodeId) return
    if (event.state === 'working') this.awaitingFirstWorking.delete(event.nodeId)
    if (event.state === 'working' || event.state === 'done') void this.refreshArmed(event)
  }

  refreshArmed(observed?: Pick<NormalizedAgentEvent, 'nodeId' | 'state'>): Promise<void> {
    return this.runExclusive(async () => {
      if (this.stopped) return
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const changedByProject = new Map<Project, CanvasNodeState[]>()

      for (const project of workspace.projects) {
        for (const node of project.nodes) {
          const pending = node.pendingLaunch
          if (!pending || pending.executor !== 'server' || !pending.command) continue
          const markChanged = (): void => {
            const list = changedByProject.get(project) ?? []
            if (!list.includes(node)) list.push(node)
            changedByProject.set(project, list)
          }
          if (observed?.state === 'working' && pending.awaitWorking?.includes(observed.nodeId)) {
            const remaining = pending.awaitWorking.filter((depId) => depId !== observed.nodeId)
            pending.awaitWorking = remaining.length ? remaining : undefined
            // Persist the evidence even if the dependent PTY is temporarily unavailable. Losing
            // this mutation would strand the arm when the next event is the legitimate `done`.
            markChanged()
          }
          for (const depId of pending.awaitWorking ?? []) {
            if (!(observed?.state === 'working' && observed.nodeId === depId))
              this.awaitingFirstWorking.add(depId)
          }
          try {
            const result = await this.attach(project, node)
            if (!result.sessionId) continue
          } catch {
            this.scheduleRetry(node.id)
            continue
          }

          const ready = pending.after.every((depId) => {
            const stillExists = project.nodes.some((candidate) => candidate.id === depId)
            if (!stillExists) return true
            if (pending.awaitWorking?.includes(depId)) return false
            return observed?.nodeId === depId
              ? observed.state === 'done'
              : this.deps.stateOf(depId) === 'done'
          })
          if (!ready) continue
          if (!(await this.deps.ptyManager.sendText(node.id, pending.command))) {
            this.scheduleRetry(node.id)
            continue
          }
          node.pendingLaunch = undefined
          this.retryCount.delete(node.id)
          const timer = this.retryTimers.get(node.id)
          if (timer) (this.deps.clearSchedule ?? clearTimeout)(timer)
          this.retryTimers.delete(node.id)
          markChanged()
        }
      }

      // A working event is definitive for every pending launch in this transaction. Keep the
      // process-local fresh-spawn index aligned even when several arms named the same dependency.
      if (observed?.state === 'working') this.awaitingFirstWorking.delete(observed.nodeId)

      if (changedByProject.size) {
        await this.deps.workspaceStore.save(workspace)
        for (const [project, nodes] of changedByProject) this.publish(project, nodes)
      }
    })
  }

  private scheduleRetry(nodeId: string): void {
    if (this.stopped || this.retryTimers.has(nodeId)) return
    const count = (this.retryCount.get(nodeId) ?? 0) + 1
    this.retryCount.set(nodeId, count)
    if (count > AFTER_RETRY_LIMIT) return
    const schedule = this.deps.schedule ?? ((cb: () => void, ms: number) => setTimeout(cb, ms))
    const timer = schedule(() => {
      this.retryTimers.delete(nodeId)
      void this.refreshArmed()
    }, AFTER_RETRY_MS)
    this.retryTimers.set(nodeId, timer)
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.retryTimers.values()) (this.deps.clearSchedule ?? clearTimeout)(timer)
    this.retryTimers.clear()
  }
}
