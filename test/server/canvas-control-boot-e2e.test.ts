import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { startServer } from '../../src/server/index'
import type { Workspace } from '../../src/shared/types'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const PERSIST_KEY = `boot-rescue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const TMUX_TARGET = sessionName(PERSIST_KEY)

function backendExists(): boolean {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', TMUX_TARGET], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasTmux)('disposable Server boot rescue', () => {
  let dataDir = ''
  let projectDir = ''
  let close: (() => Promise<void>) | undefined
  // Everything startServer printed while booting with canvasControl on. Captured rather than
  // asserted through a spy call count because the boot logs several unrelated lines.
  const bootLogs: string[] = []

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-boot-rescue-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-boot-project-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'boot-project',
      projects: [
        {
          id: 'boot-project',
          name: 'Disposable boot rescue',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: PERSIST_KEY,
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Persisted missing backend',
              color: '#d97757',
              group: null,
              agentId: 'claude',
              pendingLaunch: {
                after: [],
                command: "claude 'must remain dormant'",
                executor: 'server'
              }
            }
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), 'utf8')
    expect(backendExists()).toBe(false)

    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      bootLogs.push(args.map((a) => String(a)).join(' '))
    })
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'disposable-boot-rescue-password',
      installHooks: false,
      canvasControl: true,
      headless: false
    })
    log.mockRestore()
    close = server.close
  }, 30_000)

  afterAll(async () => {
    await close?.()
    // This exact session can exist only if this disposable server regressed and spawned it. Never
    // touch the tmux server or any broad target; cleanup is scoped to the test-owned unique id.
    if (backendExists()) {
      try {
        execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', TMUX_TARGET], {
          stdio: 'ignore'
        })
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  // The flag reads as "canvas control", but what it grants is command execution as the server's
  // own user. An operator who never opens docs/SERVER.md still has to be told, so boot says it —
  // and this pins that it is actually said, on a real boot with the flag on.
  it('announces at boot that the flag grants command execution on this host', () => {
    const notice = bootLogs.find((line) => line.includes('Server canvas control ENABLED'))
    expect(notice).toBeDefined()
    expect(notice).toContain('arbitrary commands on this host')
    expect(notice).toContain('open-terminal --cmd')
    expect(notice).toContain('NODETERM_SERVER_CANVAS_CONTROL')
  })

  it('leaves a persisted queued node dormant when no backend exists', () => {
    expect(backendExists()).toBe(false)
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')
    ) as Workspace
    expect(persisted.projects[0].nodes[0].pendingLaunch).toMatchObject({
      command: "claude 'must remain dormant'",
      executor: 'server'
    })
  })
})
