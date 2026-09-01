import { describe, expect, it } from 'vitest'
import { applyGrokHookSession, planGrokHookSession } from './grok-hook-session'

describe('planGrokHookSession', () => {
  it.each([
    ['PermissionDenied', 'permission_denied', 'permissiondenied', 'gs-before', undefined],
    ['StopCancelled', 'stop_cancelled', 'stopcancelled', 'gs-before', undefined],
    ['SubagentStart', 'subagent_start', 'subagentstart', 'gs-before', undefined],
    ['SubagentStop', 'subagent_stop', 'subagentstop', 'gs-before', undefined],
    ['PreCompact', 'pre_compact', 'precompact', 'gs-before', undefined],
    ['PostCompact', 'post_compact', 'postcompact', 'gs-after', 'gs-before']
  ])(
    '%s produces the shell-independent session transition',
    (_name, hookEventName, event, sessionId, forgetSessionId) => {
      expect(
        planGrokHookSession({ hookEventName, sessionId, cwd: '/w/project' }, 'gs-before')
      ).toEqual({
        event,
        sessionId,
        cwd: '/w/project',
        forgetSessionId
      })
    }
  )

  it('does not retire a session when PostCompact repeats its current id', () => {
    expect(
      planGrokHookSession(
        { hook_event_name: 'post_compact', session_id: 'gs-current', cwd: '/w/project' },
        'gs-current'
      )
    ).toEqual({
      event: 'postcompact',
      sessionId: 'gs-current',
      cwd: '/w/project',
      forgetSessionId: undefined
    })
  })

  it.each(['desktop', 'server'])('%s applies all six new events through the same behavioral seam', (_shell) => {
    const cases = [
      ['permission_denied', 'gs-before', undefined],
      ['stop_cancelled', 'gs-before', undefined],
      ['subagent_start', 'gs-before', undefined],
      ['subagent_stop', 'gs-before', undefined],
      ['pre_compact', 'gs-before', undefined],
      ['post_compact', 'gs-after', 'gs-before']
    ] as const

    for (const [hookEventName, sessionId, forgotten] of cases) {
      const sessions = new Map([['node-1', 'gs-before']])
      const remembered: [string, string][] = []
      const forgot: string[] = []

      applyGrokHookSession(
        'node-1',
        { hookEventName, sessionId, cwd: '/w/project' },
        sessions,
        {
          sessionsDir: '/grok/sessions',
          rememberSessionDir: (id, dir) => remembered.push([id, dir]),
          forgetSession: (id) => {
            if (id) forgot.push(id)
          }
        }
      )

      expect(sessions.get('node-1'), hookEventName).toBe(sessionId)
      expect(remembered, hookEventName).toEqual([
        [sessionId, `/grok/sessions/${encodeURIComponent('/w/project')}/${sessionId}`]
      ])
      expect(forgot, hookEventName).toEqual(forgotten ? [forgotten] : [])
    }
  })
})
