import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import type { AgentState } from '../shared/agents/normalize'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import { HeadlessNodeFactory, type HeadlessPty } from './headless-node-factory'

class FakePty implements HeadlessPty {
  readonly creates: PtyCreateOptions[] = []
  readonly sends: Array<{ nodeId: string; text: string }> = []
  readonly destroys: Array<{
    clientId: number | null
    nodeId: string
    everySocket: boolean | undefined
    wasLive: boolean
  }> = []
  readonly live = new Set<string>()
  readonly alreadyDead = new Set<string>()

  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.creates.push(options)
    if (options.persistKey) this.live.add(options.persistKey)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }

  async sendText(nodeId: string, text: string): Promise<boolean> {
    this.sends.push({ nodeId, text })
    return true
  }

  async destroySession(
    clientId: number | null,
    nodeId: string,
    opts?: { everySocket?: boolean }
  ): Promise<void> {
    const wasLive = this.live.delete(nodeId)
    this.destroys.push({ clientId, nodeId, everySocket: opts?.everySocket, wasLive })
    this.alreadyDead.add(nodeId)
  }

  killOutOfBand(nodeId: string): void {
    this.live.delete(nodeId)
    this.alreadyDead.add(nodeId)
  }
}

const terminal = (
  id: string,
  title: string,
  agentId: 'claude' | 'codex' | 'gemini' = 'claude',
  x = 20
): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 30 },
  size: { width: 640, height: 440 },
  title,
  color: '#d97757',
  group: null,
  tags: [],
  agentId
})

describe('HeadlessNodeFactory', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: FakePty
  let states: Record<string, AgentState | undefined>
  let published: CanvasNodeState[]
  let removed: string[]
  let publishedProjects: Workspace['projects']
  let factory: HeadlessNodeFactory

  const settings = (): Settings => ({
    ...DEFAULT_SETTINGS,
    // Makes command expectations independent of the local Claude version probe.
    claudePermissionMode: 'manual'
  })

  beforeEach(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-headless-factory-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    pty = new FakePty()
    states = {}
    published = []
    removed = []
    publishedProjects = []
    const initial: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Test',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [terminal('term-source', 'Director'), terminal('term-upstream', 'Upstream', 'codex', 80)],
          bridges: [],
          ropes: []
        }
      ]
    }
    await store.save(initial)
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false
      }),
      stateOf: (id) => states[id],
      publishNode: (_projectId, node) => published.push(node),
      publishRemoval: (_projectId, nodeId) => removed.push(nodeId),
      publishProject: (project) => publishedProjects.push(structuredClone(project))
    })
  })

  afterEach(() => {
    factory.stop()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates a terminal PTY, persists both workspace index and project file, and publishes it', async () => {
    const reply = await factory.openTerminal(
      'term-source',
      { cwd: projectDir, cmd: 'printf hello' },
      true
    )
    expect(reply).toMatchObject({ ok: true, result: { id: expect.stringMatching(/^term-/) } })
    const id = (reply.result as { id: string }).id

    expect(pty.creates).toEqual([
      expect.objectContaining({
        cwd: projectDir,
        cols: 120,
        rows: 36,
        persistKey: id,
        ownerProjectId: 'project-1'
      })
    ])
    expect(pty.sends).toEqual([{ nodeId: id, text: 'printf hello' }])
    expect(published.map((node) => node.id)).toEqual([id])

    expect(fs.existsSync(path.join(dataDir, 'workspace.json'))).toBe(true)
    const projectFile = path.join(projectDir, '.nodeterm', 'project.json')
    expect(fs.existsSync(projectFile)).toBe(true)
    const raw = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as { nodes: CanvasNodeState[] }
    const created = raw.nodes.find((node) => node.id === id)
    // Local project files store cwd portably; WorkspaceStore resolves it back to absolute on load.
    expect(created).toMatchObject({ kind: 'terminal', cwd: '.' })
    expect(created!.position.x).toBeGreaterThan(terminal('x', 'x').position.x)

    const reloaded = await new WorkspaceStore().load({ sideline: false })
    expect(reloaded.projects[0].nodes.find((node) => node.id === id)).toMatchObject({
      cwd: projectDir
    })
  })

  it('lets a verified caller close its own spawn, killing the pane before persisted edge removal and fanout', async () => {
    const opened = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'owned work' },
      true
    )
    const id = (opened.result as { id: string }).id
    const closed = await factory.close('term-source', { node: id }, true)

    expect(closed).toMatchObject({ ok: true, result: { ids: [id] } })
    expect(pty.destroys).toEqual([
      { clientId: null, nodeId: id, everySocket: true, wasLive: true }
    ])
    expect(removed).toEqual([id])

    const workspace = await new WorkspaceStore().load({ sideline: false })
    const project = workspace.projects[0]
    expect(project.nodes.some((node) => node.id === id)).toBe(false)
    expect(project.ropes?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(project.bridges?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(publishedProjects.at(-1)?.nodes.some((node) => node.id === id)).toBe(false)

    const projectFile = JSON.parse(
      fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    ) as {
      nodes: CanvasNodeState[]
      ropes?: Array<{ source: string; target: string }>
      bridges?: Array<{ source: string; target: string }>
    }
    expect(projectFile.nodes.some((node) => node.id === id)).toBe(false)
    expect(projectFile.ropes?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
    expect(projectFile.bridges?.some((edge) => edge.source === id || edge.target === id)).toBe(false)
  })

  it('refuses a different caller without killing or removing the owned spawn', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id

    await expect(factory.close('term-upstream', { node: id }, true)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-not-owner')
    })
    expect(pty.destroys).toEqual([])
    expect((await store.load({ sideline: false })).projects[0].nodes.some((node) => node.id === id))
      .toBe(true)
    expect(removed).toEqual([])
  })

  it('closes a persisted owned node cleanly when its pane was already killed out of band', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id
    pty.killOutOfBand(id)

    await expect(factory.close('term-source', { node: id }, true)).resolves.toMatchObject({
      ok: true,
      result: { ids: [id] }
    })
    expect(pty.destroys.at(-1)).toEqual({
      clientId: null,
      nodeId: id,
      everySocket: true,
      wasLive: false
    })
    expect((await store.load({ sideline: false })).projects[0].nodes.some((node) => node.id === id))
      .toBe(false)
  })

  it('requires verified node identity before applying the process-local ownership ledger', async () => {
    const opened = await factory.openTerminal('term-source', {}, true)
    const id = (opened.result as { id: string }).id

    await expect(factory.close('term-source', { node: id }, false)).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('close-identity-refused')
    })
    expect(pty.destroys).toEqual([])
  })

  it('places repeated spawns in the first free deterministic slots without overlapping busy nodes', async () => {
    const workspace = await store.load({ sideline: false })
    // Slot zero to the right of the source is already busy before any control request arrives.
    workspace.projects[0].nodes.push(terminal('term-busy-slot', 'Busy slot', 'gemini', 740))
    await store.save(workspace)

    const spawnedIds: string[] = []
    for (let i = 0; i < 5; i++) {
      const reply = await factory.openTerminal('term-source', {}, true)
      spawnedIds.push((reply.result as { id: string }).id)
    }

    const nodes = (await store.load({ sideline: false })).projects[0].nodes
    const overlap = (a: CanvasNodeState, b: CanvasNodeState): boolean =>
      a.position.x < b.position.x + b.size.width &&
      a.position.x + a.size.width > b.position.x &&
      a.position.y < b.position.y + b.size.height &&
      a.position.y + a.size.height > b.position.y
    for (const id of spawnedIds) {
      const node = nodes.find((candidate) => candidate.id === id)!
      expect(nodes.filter((candidate) => candidate.id !== id).some((candidate) => overlap(node, candidate)), id)
        .toBe(false)
    }
    expect(new Set(spawnedIds.map((id) => {
      const node = nodes.find((candidate) => candidate.id === id)!
      return `${node.position.x},${node.position.y}`
    })).size).toBe(spawnedIds.length)
  })

  it.each([
    ['claude', "claude 'do work'"],
    ['codex', "codex 'do work' --ask-for-approval untrusted"],
    ['gemini', "gemini 'do work'"]
  ] as const)('assembles the %s launch through the shared command builder', async (agent, command) => {
    const reply = await factory.openAgent(
      'term-source',
      { agent, prompt: 'do   work' },
      true
    )
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.creates.at(-1)).toMatchObject({
      persistKey: id,
      ownerProjectId: 'project-1',
      agentId: agent
    })
    expect(pty.sends.at(-1)).toEqual({ nodeId: id, text: command })
  })

  it('persists --after without launching, then flushes exactly once on the idle state', async () => {
    states['term-upstream'] = 'working'
    const reply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: 'term-upstream' },
      true
    )
    expect(reply.ok).toBe(true)
    const id = (reply.result as { id: string }).id
    expect(pty.sends).toEqual([])

    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toEqual({
      after: ['term-upstream'],
      command: "claude 'consume result'",
      executor: 'server'
    })
    expect(workspace.projects[0].bridges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'term-source', target: id }),
        expect.objectContaining({ source: id, target: 'term-upstream' })
      ])
    )

    states['term-upstream'] = 'done'
    await factory.refreshArmed()
    await factory.refreshArmed()
    expect(pty.sends).toEqual([{ nodeId: id, text: "claude 'consume result'" }])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.pendingLaunch).toBeUndefined()
  })

  it('holds a fresh dependency through its boot done blip, then releases after working -> done', async () => {
    const upstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'produce result' },
      true
    )
    const upstreamId = (upstreamReply.result as { id: string }).id
    pty.sends.length = 0

    const downstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: upstreamId },
      true
    )
    const downstreamId = (downstreamReply.result as { id: string }).id
    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toMatchObject({ after: [upstreamId], awaitWorking: [upstreamId] })

    // Fresh Claude briefly idles at its composer before its argv prompt begins. This done is not
    // terminal evidence because no working turn has been observed since the downstream was armed.
    states[upstreamId] = 'done'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'done' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([])

    states[upstreamId] = 'working'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'working' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .not.toHaveProperty('awaitWorking')

    states[upstreamId] = 'done'
    factory.onAgentEvent({ nodeId: upstreamId, state: 'done' })
    await factory.refreshArmed()
    expect(pty.sends).toEqual([{ nodeId: downstreamId, text: "claude 'consume result'" }])
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toBeUndefined()
  })

  it('launches immediately when a fresh dependency is already done at arm time', async () => {
    const upstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'produce result' },
      true
    )
    const upstreamId = (upstreamReply.result as { id: string }).id
    states[upstreamId] = 'done'
    pty.sends.length = 0

    const downstreamReply = await factory.openAgent(
      'term-source',
      { agent: 'claude', prompt: 'consume result', after: upstreamId },
      true
    )
    const downstreamId = (downstreamReply.result as { id: string }).id
    expect(pty.sends).toEqual([{ nodeId: downstreamId, text: "claude 'consume result'" }])
    const workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === downstreamId)?.pendingLaunch)
      .toBeUndefined()
  })

  it('creates and updates a persisted sticky with lineage and an accountable byline', async () => {
    const createdReply = await factory.sticky('term-source', {
      node: 'Round status',
      create: 'yes',
      text: 'Round 1 complete'
    })
    expect(createdReply).toMatchObject({
      ok: true,
      result: { id: expect.stringMatching(/^sticky-/), created: true, mode: 'replace' }
    })
    const id = (createdReply.result as { id: string }).id

    let workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)).toMatchObject({
      kind: 'sticky',
      title: 'Round status',
      text: 'Round 1 complete',
      textUpdatedBy: 'Director'
    })
    expect(workspace.projects[0].ropes).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'term-source', target: id })])
    )

    const updatedReply = await factory.sticky('term-source', {
      node: id,
      append: 'Round 2 ready'
    })
    expect(updatedReply).toMatchObject({
      ok: true,
      result: { id, created: false, mode: 'append' }
    })
    workspace = await store.load({ sideline: false })
    expect(workspace.projects[0].nodes.find((node) => node.id === id)?.text).toBe(
      'Round 1 complete\nRound 2 ready'
    )
    expect(published.filter((node) => node.id === id)).toHaveLength(2)
  })

  it('refuses a non-v1 agent before a node or PTY is created', async () => {
    const reply = await factory.openAgent('term-source', { agent: 'grok' }, true)
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('claude|codex|gemini') })
    expect(pty.creates).toEqual([])
  })
})
