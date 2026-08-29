import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetMessageFlow } from '../core/agents/agent-message-flow'
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
  })

  afterEach(() => {
    runtime?.stop()
    runtime = null
    resetPaneOwnershipForTests()
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
})
