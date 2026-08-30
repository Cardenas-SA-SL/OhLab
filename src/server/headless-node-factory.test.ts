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

  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.creates.push(options)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }

  async sendText(nodeId: string, text: string): Promise<boolean> {
    this.sends.push({ nodeId, text })
    return true
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
      publishProject: vi.fn()
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
