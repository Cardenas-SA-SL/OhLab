import { describe, expect, it } from 'vitest'
import { grokRawFields, normalizeClaude, normalizeGrok, type RawHookEnvelope } from './normalize'

/**
 * Grok's hook envelope is its own dialect: camelCase keys whose `hookEventName` VALUE is
 * snake_case ("pre_tool_use"), and the grok SDK path converts the top-level keys to snake_case.
 * Both spellings are therefore read, and the event name is canonicalized rather than matched
 * literally — read out of the shipped 1.0.0 docs, not inferred from claude's shape. No payload was
 * ever captured: a hook fires only inside a logged-in grok session, which was never available here.
 */
function env(payload: Record<string, unknown>): RawHookEnvelope {
  return { nodeId: 'n1', agentId: 'grok', payload }
}

describe('normalizeGrok — lifecycle', () => {
  it('maps session_start / session_end to the session phases', () => {
    expect(normalizeGrok(env({ hookEventName: 'session_start', sessionId: 's1' }))).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'session',
      sessionPhase: 'start'
    })
    expect(normalizeGrok(env({ hookEventName: 'session_end', sessionId: 's1' }))?.sessionPhase).toBe('end')
  })

  it('treats user_prompt_submit as the turn start (newTurn)', () => {
    const e = normalizeGrok(env({ hookEventName: 'user_prompt_submit', sessionId: 's1', prompt: 'ship it' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working', newTurn: true, task: 'ship it' })
  })

  it('keeps the node working across every tool event, including a tool FAILURE', () => {
    for (const ev of ['pre_tool_use', 'post_tool_use', 'post_tool_use_failure']) {
      expect(normalizeGrok(env({ hookEventName: ev, sessionId: 's1' }))).toMatchObject({
        kind: 'state',
        state: 'working'
      })
    }
  })
})

describe('normalizeGrok — Stop', () => {
  it('a genuine turn end is done, carrying the last assistant message', () => {
    const e = normalizeGrok(
      env({ hookEventName: 'stop', sessionId: 's1', reason: 'end_turn', lastAssistantMessage: 'done' })
    )
    expect(e).toMatchObject({ state: 'done', lastMessage: 'done' })
    // Not interrupted — a genuine turn end DOES earn the completion alert. Asserted separately
    // (as normalize.test.ts does for claude's Stop) because toMatchObject demands the key exist.
    expect(e?.interrupted).toBeFalsy()
  })

  it('an ABSENT reason is still a real turn end (never swallow the badge event)', () => {
    expect(normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1' }))).toMatchObject({ state: 'done' })
  })

  /**
   * The two observe-only reasons are a DENYLIST, not 'end_turn' an allowlist: only grok's session
   * close is observe-only, so any turn-end reason grok labels later must still report its badge and
   * its completion alert. An allowlist would silently mark all of these `interrupted`.
   */
  it('an UNKNOWN reason is a real turn end too, alert and message intact', () => {
    for (const reason of ['max_tokens', 'refusal', 'something_new']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'text' }))
      expect(e, reason).toMatchObject({ state: 'done', lastMessage: 'text' })
      expect(e?.interrupted, reason).toBeFalsy()
    }
  })

  it('the observe-only session-close Stop is marked interrupted, so no completion alert fires', () => {
    for (const reason of ['channel_closed', 'shutdown']) {
      const e = normalizeGrok(env({ hookEventName: 'stop', sessionId: 's1', reason, lastAssistantMessage: 'x' }))
      expect(e).toMatchObject({ state: 'done', interrupted: true })
      expect(e?.lastMessage).toBeUndefined()
    }
  })

  it.each([
    'rate_limit',
    'authentication_failed',
    'invalid_request',
    'server_error',
    'max_output_tokens',
    'unknown'
  ])('stop_failure %s ends the turn so the badge cannot stick on working', (error) => {
    expect(
      normalizeGrok(
        env({ hookEventName: 'stop_failure', sessionId: 's1', error, lastAssistantMessage: error })
      )
    ).toMatchObject({ state: 'done', lastMessage: error })
  })

  it('an unrecognized stop_failure error type is a no-op', () => {
    expect(normalizeGrok(env({ hookEventName: 'stop_failure', error: 'future_error' }))).toBeNull()
  })
})

describe('normalizeGrok — published 1.0.13 events', () => {
  it('keeps working after PermissionDenied because the turn continues after the tool decision', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'permission_denied', sessionId: 's1', toolName: 'write_file' }))
    ).toMatchObject({ kind: 'state', state: 'working' })
  })

  it.each([
    'user_interrupt',
    'permission_rejected',
    'permission_cancelled',
    'max_turns',
    'no_progress',
    'unknown'
  ] as const)('carries closed StopCancelled reason %s without deciding the badge transition yet', (reason) => {
    expect(
      normalizeGrok(
        env({
          hookEventName: 'stop_cancelled',
          sessionId: 's1',
          reason,
          subagentType: 'explore',
          lastAssistantMessage: 'not allowed'
        })
      )
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'state',
      cancelReason: reason,
      subagentType: 'explore',
      lastMessage: 'not allowed'
    })
  })

  it('rejects an unrecognized StopCancelled reason', () => {
    expect(normalizeGrok(env({ hookEventName: 'stop_cancelled', reason: 'future_reason' }))).toBeNull()
  })

  it('normalizes SubagentStart and SubagentStop without inventing an instance id', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'subagent_start', sessionId: 's1', subagentType: 'explore' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'subagent-start',
      subagentType: 'explore'
    })
    expect(
      normalizeGrok(env({ hook_event_name: 'subagent_stop', session_id: 's1', subagent_type: 'explore' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 's1',
      kind: 'subagent-end',
      subagentType: 'explore'
    })
  })

  it('carries the closed compaction phase while leaving the current badge untouched', () => {
    expect(
      normalizeGrok(env({ hookEventName: 'pre_compact', sessionId: 'old', trigger: 'manual' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 'old',
      kind: 'state',
      compactionPhase: 'pre'
    })
    expect(
      normalizeGrok(env({ hook_event_name: 'post_compact', session_id: 'new', trigger: 'auto' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: 'new',
      kind: 'state',
      compactionPhase: 'post'
    })
    expect(normalizeGrok(env({ hookEventName: 'post_compact', trigger: 'future' }))).toBeNull()
  })
})

/** Grok 1.0.13 publishes the closed Notification vocabulary in
 * `~/.grok/docs/user-guide/10-hooks.md:99`; `:162` says permission_prompt fires only while its UI
 * actually waits. The literal unknown cases keep that contract closed. */
describe('normalizeGrok — Notification', () => {
  it.each([
    {
      name: 'permission_prompt',
      payload: {
        hookEventName: 'notification',
        notificationType: 'permission_prompt',
        message: 'Tool permission requested',
        level: 'info'
      },
      want: {
        nodeId: 'n1',
        agentId: 'grok',
        sessionId: undefined,
        kind: 'state',
        state: 'blocked',
        lastMessage: undefined
      }
    },
    {
      name: 'idle_prompt',
      payload: { hookEventName: 'notification', notificationType: 'idle_prompt' },
      want: {
        nodeId: 'n1',
        agentId: 'grok',
        sessionId: undefined,
        kind: 'state',
        state: 'done',
        interrupted: true,
        idle: true
      }
    },
    {
      name: 'task_complete',
      payload: { hookEventName: 'notification', notificationType: 'task_complete' },
      want: null
    },
    {
      name: 'unknown',
      payload: { hookEventName: 'notification', notificationType: 'some_future_type' },
      want: null
    },
    {
      name: 'unknown containing permission',
      payload: { hookEventName: 'notification', notificationType: 'permission_reminder' },
      want: null
    },
    {
      name: 'unknown camelCase near-alias',
      payload: { hookEventName: 'notification', notificationType: 'permissionPrompt' },
      want: null
    },
    {
      name: 'unknown hyphenated near-alias',
      payload: { hookEventName: 'notification', notificationType: 'permission-prompt' },
      want: null
    }
  ])('maps published and unknown type: $name', ({ payload, want }) => {
    expect(normalizeGrok(env(payload))).toEqual(want)
  })

  it.each([
    'approval_required',
    'agent_needs_input',
    'elicitation_dialog',
    'session_ready',
    'permission_request'
  ])('retires the old inferred Notification type %s', (notificationType) => {
    expect(normalizeGrok(env({ hookEventName: 'notification', notificationType }))).toBeNull()
  })

  it('does not infer idle state from prose attached to an unknown type', () => {
    expect(
      normalizeGrok(
        env({
          hookEventName: 'notification',
          notificationType: 'session_ready',
          message: 'Type your message or @path/to/file'
        })
      )
    ).toBeNull()
  })

  it('reads the published types through the SDK key dialect', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'permission_prompt' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: undefined,
      kind: 'state',
      state: 'blocked',
      lastMessage: undefined
    })
    expect(
      normalizeGrok(env({ hook_event_name: 'notification', notification_type: 'idle_prompt' }))
    ).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: undefined,
      kind: 'state',
      state: 'done',
      interrupted: true,
      idle: true
    })
  })

  it('reads a published type through the legacy bare type key', () => {
    expect(normalizeGrok(env({ hookEventName: 'notification', type: 'permission_prompt' }))).toEqual({
      nodeId: 'n1',
      agentId: 'grok',
      sessionId: undefined,
      kind: 'state',
      state: 'blocked',
      lastMessage: undefined
    })
  })
})

describe('normalizeGrok — dialects', () => {
  it('reads the SDK snake_case key spelling too', () => {
    expect(
      normalizeGrok(env({ hook_event_name: 'stop', session_id: 's9', last_assistant_message: 'ok' }))
    ).toMatchObject({ sessionId: 's9', state: 'done', lastMessage: 'ok' })
  })

  it('accepts a PascalCase event name (canonicalized, not matched literally)', () => {
    expect(normalizeGrok(env({ hookEventName: 'PreToolUse' }))).toMatchObject({ state: 'working' })
  })

})

/**
 * Grok also merges `~/.claude/settings.json`, where nodeterm's CLAUDE managed hook already lives —
 * so every grok event ALSO fires claude.sh and POSTs to /hook/claude. That leg must stay inert:
 * this is the test that keeps it a property instead of a coincidence.
 */
describe('the claude-compat cross-fire is inert', () => {
  const GROK_EVENTS = ['session_start', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use', 'stop', 'session_end']

  it('normalizeClaude returns null for every grok payload (camelCase dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hookEventName: ev, sessionId: 's1' } }),
        ev
      ).toBeNull()
    }
  })

  /**
   * This is the leg that actually carries the property: in the SDK dialect grok writes the key
   * claude DOES read (`hook_event_name`), so inertness rests entirely on claude's compare being
   * case-sensitive and literal — 'stop' is not 'Stop'. Anyone who "helpfully" lowercases claude's
   * event name breaks this and nothing else.
   */
  it('normalizeClaude returns null for every grok payload (SDK snake_case dialect)', () => {
    for (const ev of GROK_EVENTS) {
      expect(
        normalizeClaude({ nodeId: 'n1', agentId: 'claude', payload: { hook_event_name: ev, session_id: 's1' } }),
        ev
      ).toBeNull()
    }
  })
})

describe('grokRawFields', () => {
  it('hands the shells ONE canonical field set from either dialect', () => {
    expect(
      grokRawFields({
        hookEventName: 'pre_tool_use',
        sessionId: 's1',
        cwd: '/w',
        toolName: 'spawn_subagent',
        toolUseId: 't1',
        toolInput: { subagent_type: 'explore' }
      })
    ).toEqual({
      event: 'pretooluse',
      sessionId: 's1',
      cwd: '/w',
      toolName: 'spawn_subagent',
      toolUseId: 't1',
      toolInput: { subagent_type: 'explore' }
    })
    // Every field the function reads, in the SDK dialect — dual-dialect reading is its whole reason
    // to exist, so dropping any one `?? p.snake_case` fallback has to fail here.
    expect(
      grokRawFields({
        hook_event_name: 'post_tool_use',
        session_id: 's2',
        cwd: '/w2',
        tool_name: 'read_file',
        tool_use_id: 't2',
        tool_input: { path: '/w2/a.ts' }
      })
    ).toEqual({
      event: 'posttooluse',
      sessionId: 's2',
      cwd: '/w2',
      toolName: 'read_file',
      toolUseId: 't2',
      toolInput: { path: '/w2/a.ts' }
    })
  })
})
