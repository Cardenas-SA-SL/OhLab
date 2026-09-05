import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { queueRelayInitialCommand } from '../../src/renderer/lib/relayInitialCommand'
import {
  localTmuxEnterArgs,
  localTmuxPasteArgs,
  pasteBufferName,
  sessionName
} from '../../src/core/tmux-naming'
import { makeTmuxTmpdir } from '../../src/core/tmux-test-socket'

const TMUX = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux'].find(fs.existsSync)
const SOCKET = `ohlab-relay-spawn-${process.pid}`
const SESSION = sessionName('relay-spawn')
let work = ''
const env = (): NodeJS.ProcessEnv => ({ ...process.env, TMUX_TMPDIR: work })
const tmux = (args: string[], input?: string): string => execFileSync(TMUX!, args, { env: env(), encoding: 'utf8', input })

beforeAll(() => { if (TMUX) work = makeTmuxTmpdir('ohlab-relay-', SOCKET) })
afterAll(() => {
  if (TMUX && work) {
    try { tmux(['-L', SOCKET, 'kill-server']) } catch {}
    fs.rmSync(work, { recursive: true, force: true })
  }
})

const suite = TMUX ? describe : describe.skip

suite('REAL tmux: relay-bridged agent spawn', () => {
  it('runs the clean launch through the host paste-buffer API', () => {
    const marker = path.join(work, 'clean-launch')
    const command = `touch ${marker}`
    const queued = queueRelayInitialCommand({ id: 'remote-agent', data: { initialCommand: command } } as any, true)
    tmux(['-L', SOCKET, 'new-session', '-d', '-s', SESSION, '-c', work, 'bash --norc --noprofile -i'])

    // This is the host implementation reached by the relay api's pty.sendText call: command bytes
    // ride stdin into a private tmux paste buffer and are submitted separately, never sharing the
    // guest xterm input write that carries DA1/DA2 replies.
    const bridgedApi = {
      pty: {
        sendText: async (_nodeId: string, text: string) => {
          tmux(localTmuxPasteArgs(SOCKET, SESSION, pasteBufferName(), true), text)
          tmux(localTmuxEnterArgs(SOCKET, SESSION))
          return true
        }
      }
    }
    void bridgedApi.pty.sendText('remote-agent', queued.data.pendingLaunch!.command)
    const deadline = Date.now() + 5000
    while (!fs.existsSync(marker) && Date.now() < deadline) execFileSync('sleep', ['0.05'])
    expect(fs.existsSync(marker)).toBe(true)
    expect(tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', SESSION])).not.toContain('command not found')
  })
})
