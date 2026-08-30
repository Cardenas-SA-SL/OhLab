import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  _resetForTest as resetAgentStatusMirrorForTests,
  recordAgentEvent
} from '../core/agent-status-mirror'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import {
  resetNodeTokenFilesForTests,
  writeNodeTokenFile
} from '../core/agents/node-token-files'
import {
  recordFreshSpawnOwner,
  resetPaneOwnershipForTests
} from '../core/agents/pane-ownership'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'
import { DEFAULT_SETTINGS, type Settings, type Workspace } from '../shared/types'
import { initServerCanvasControl, type ServerCanvasControl } from './canvas-control'

describe('initServerCanvasControl', () => {
  let dataDir = ''
  let runtime: ServerCanvasControl | null = null

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-server-control-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    resetPaneOwnershipForTests()
    resetMessageFlow()
    resetAgentMessageTraceForTests()
    resetAgentStatusMirrorForTests()
    resetNodeTokenFilesForTests()
  })

  afterEach(() => {
    runtime?.stop()
    runtime = null
    resetPaneOwnershipForTests()
    resetAgentStatusMirrorForTests()
    resetNodeTokenFilesForTests()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('installs only under temp data when integrations are gated, and enforces messaging switch off', async () => {
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Project',
          color: '#0a84ff',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Source',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'target',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Target',
              color: '#10a37f',
              group: null,
              agentId: 'codex'
            }
          ]
        }
      ]
    }
    const store = {
      load: vi.fn(async () => workspace),
      save: vi.fn(async () => undefined),
      persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
      // No strict true flag and no machine-local `kept` ack: capability is off by default.
      capabilityProjectFor: () => ({})
    } as unknown as WorkspaceStore
    const paneOwner = vi.fn(async () => null)
    const sendEnvelope = vi.fn(async () => true)
    const pty = {
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      sendText: vi.fn(async () => true),
      paneOwner,
      sendEnvelope,
      hasLiveSession: () => true
    } as unknown as PtyManager
    const settings = (): Settings => ({ ...DEFAULT_SETTINGS })

    runtime = await initServerCanvasControl({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      boardLog: { append: async () => false },
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false
      }),
      installAgentIntegrations: false
    })

    const shim = path.join(dataDir, 'canvas-control', 'nodeterm.sh')
    expect(fs.readFileSync(shim, 'utf8')).toContain('NODETERM_CANVAS_CONTROL')
    expect(fs.statSync(shim).mode & 0o111).not.toBe(0)
    const accountDir = path.join(dataDir, 'test-account')
    runtime.installSkillInto(accountDir)
    expect(
      fs.readFileSync(path.join(accountDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md'), 'utf8')
    ).toContain(shim)

    // Prove ownership so the next gate reached is specifically the per-project capability switch.
    recordFreshSpawnOwner('target', 'p1')
    const reply = await runtime.handler({
      verb: 'send',
      nodeId: 'source',
      args: { node: 'target', text: 'hello' },
      verified: true
    })
    expect(reply).toMatchObject({
      ok: false,
      error: expect.stringContaining('notPermitted (switch-off)')
    })
    expect(paneOwner).not.toHaveBeenCalled()
    expect(sendEnvelope).not.toHaveBeenCalled()
  })

  it('wires permitted delivery through paste-settle-submit on the first fresh pane message', async () => {
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'p1',
      projects: [
        {
          id: 'p1',
          name: 'Project',
          color: '#0a84ff',
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Source',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'target',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Target',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            }
          ]
        }
      ]
    }
    const store = {
      load: vi.fn(async () => workspace),
      save: vi.fn(async () => undefined),
      persistedCanvases: () => [{ id: 'p1', nodes: workspace.projects[0].nodes }],
      capabilityProjectFor: () => ({
        agentMessaging: true,
        capabilityAck: { agentMessaging: 'kept' }
      })
    } as unknown as WorkspaceStore
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let pasted = ''
    const legacySendEnvelope = vi.fn(async () => true)
    const pty = {
      createHeadless: vi.fn(async () => ({ sessionId: 'unused', fresh: true })),
      captureSession: vi.fn(async () =>
        pasted ? `Claude composer\n${pasted.split('\n').at(-1)}` : 'Claude composer'),
      sendText: vi.fn(async (_nodeId: string, text: string, opts?: { enter?: boolean }) => {
        writes.push({ text, enter: opts?.enter })
        if (text) pasted = text
        else queueMicrotask(() => runtime?.onAgentEvent({
          nodeId: 'target',
          agentId: 'claude',
          kind: 'state',
          state: 'working',
          newTurn: true,
          verified: true,
          clientRevision: MANAGED_SCRIPT_REVISION
        } as never))
        return true
      }),
      paneOwner: vi.fn(async () => ({
        tty: '/dev/pts/9',
        panePid: 100,
        paneId: '%1',
        command: 'claude',
        argv: ['claude'],
        pids: [200]
      })),
      sendEnvelope: legacySendEnvelope,
      hasLiveSession: () => true
    } as unknown as PtyManager

    recordFreshSpawnOwner('target', 'p1')
    expect(writeNodeTokenFile('target', 'token')).toBe(true)
    recordAgentEvent({
      nodeId: 'target',
      agentId: 'claude',
      kind: 'state',
      state: 'done',
      verified: true,
      clientRevision: MANAGED_SCRIPT_REVISION
    } as never)

    runtime = await initServerCanvasControl({
      workspaceStore: store,
      ptyManager: pty,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      boardLog: { append: async () => false },
      installAgentIntegrations: false
    })

    const reply = await runtime.handler({
      verb: 'send',
      nodeId: 'source',
      args: { node: 'target', text: 'hello' },
      verified: true
    })
    expect(reply).toMatchObject({ ok: true, message: expect.stringContaining('delivered') })
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ enter: false })
    expect(writes[1]).toEqual({ text: '', enter: true })
    expect(legacySendEnvelope).not.toHaveBeenCalled()
  })
})
