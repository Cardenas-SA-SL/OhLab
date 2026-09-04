import { describe, expect, it } from 'vitest'
import { queueRelayInitialCommand } from './relayInitialCommand'

describe('relay initial command delivery', () => {
  it('moves a remote-spawn launch onto the shell-ready host RPC path', () => {
    const node = { id: 'n', data: { initialCommand: 'claude --permission-mode auto' } } as any
    const queued = queueRelayInitialCommand(node, true)
    expect(queued.data.initialCommand).toBeUndefined()
    expect(queued.data.pendingLaunch).toEqual({ after: [], command: 'claude --permission-mode auto' })
    expect(queueRelayInitialCommand(node, false)).toBe(node)
  })
})
