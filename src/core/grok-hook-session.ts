import { grokRawFields } from '../shared/agents/normalize'
import { grokSessionDir, grokSessionsDir } from './agents/grok-paths'
import { forgetGrokSession, rememberGrokSessionDir } from './grok-session'

export interface GrokHookSessionPlan {
  event: string
  sessionId: string | undefined
  cwd: string | undefined
  forgetSessionId: string | undefined
}

export interface GrokHookSessionDeps {
  sessionsDir: string
  rememberSessionDir: (sessionId: string, dir: string) => void
  forgetSession: (sessionId: string | undefined) => void
}

/**
 * Decode the two Grok hook dialects and decide the session-map transition once for both shells.
 * Grok 1.0.13 gives PostCompact a newly minted session id, so that event retires the prior id;
 * SessionEnd retires the id carried by the event itself.
 */
export function planGrokHookSession(
  payload: Record<string, unknown>,
  previousSessionId: string | undefined
): GrokHookSessionPlan {
  const { event, sessionId, cwd } = grokRawFields(payload)
  const forgetSessionId =
    event === 'postcompact' && sessionId && previousSessionId && previousSessionId !== sessionId
      ? previousSessionId
      : event === 'sessionend'
        ? sessionId
        : undefined

  return { event, sessionId, cwd, forgetSessionId }
}

/** Apply the complete Grok raw-listener session behavior shared by desktop and Server Edition. */
export function applyGrokHookSession(
  nodeId: string,
  payload: Record<string, unknown>,
  nodeContextSession: Map<string, string>,
  deps?: GrokHookSessionDeps
): GrokHookSessionPlan {
  const previousSessionId = nodeId ? nodeContextSession.get(nodeId) : undefined
  const plan = planGrokHookSession(payload, previousSessionId)
  const sessionsDir = deps?.sessionsDir ?? grokSessionsDir()
  const remember = deps?.rememberSessionDir ?? rememberGrokSessionDir
  const forget = deps?.forgetSession ?? forgetGrokSession

  if (nodeId && plan.sessionId) nodeContextSession.set(nodeId, plan.sessionId)
  if (plan.sessionId && plan.cwd) {
    const dir = grokSessionDir({ sessionsDir, cwd: plan.cwd, sessionId: plan.sessionId })
    if (dir) remember(plan.sessionId, dir)
  }
  if (plan.forgetSessionId) forget(plan.forgetSessionId)

  return plan
}
