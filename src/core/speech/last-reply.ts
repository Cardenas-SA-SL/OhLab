// The "mouth" half of voice conversation (docs/VOICE.md): when an agent node's turn ends, the
// renderer asks this channel for the LAST assistant message of that node's OWN transcript on disk,
// sanitizes it for speech (renderer/speech/speakable.ts) and speaks it.
//
// Everything here is the existing machinery, composed: the per-agent LOCATORS are the handoff /
// context-link ones (`handoff/locate.ts`, claude through `resolveTranscript`), and the per-agent
// PARSERS are the context-link renderer's (`context-link-render.ts`). Nothing in this file knows a
// second way to find or read a transcript — the whole point is that voice cannot drift from what
// the ⌘M view and a linked agent already read.
//
// "Last assistant message" is the TRAILING RUN of assistant prose: everything the agent said
// after its last tool result / the user's last message. A reply that streams as two text blocks
// (claude writes one JSONL line per block) is spoken whole, and an interim "Let me look…" before a
// tool call is NOT — that is what a tool result resetting the run buys. Codex's `commentary`
// messages are exactly those interim lines; its `final_answer` is the run this returns.
//
// Registered on the platform seam in BOTH shells (`registerLastReplyIpc`), so the Server Edition
// speaks too. Relay tabs are gated off renderer-side: a relay tab's `speech` namespace is the LOCAL
// preload, and answering from this machine's disk for a node on another core would be a stranger's
// transcript — the wrong-machine trap the transcript readers document everywhere else.
import { IPC } from '../../shared/ipc'
import type { LastReply, LastReplyQuery } from '../../shared/speech'
import { readsClaudeShapedTranscript, type AgentId } from '../../shared/agents/config'
import { platform } from '../platform'
import { readCappedTail } from '../transcript-reader'
import { resolveTranscript } from '../transcript-ipc'
import { locateCodex, locateGemini, locateGrok } from '../handoff/locate'
import { geminiMessages, grokParse, opencodeMessages } from '../context-link-render'

/** Session ids reach a filename match or an `execFile` argv (never a shell) — accept only the
 *  charset the agents actually use (UUIDs, opencode's `ses_…`), refuse anything path-shaped. */
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{4,128}$/

/** The ordered facts a transcript yields for this purpose: who spoke, what (assistant prose only),
 *  when. A `tool` event carries no text; it exists to RESET the trailing assistant run. */
interface TurnEvent {
  role: 'user' | 'assistant' | 'tool'
  text?: string
  at: number | null
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** ISO string → epoch ms; a numeric stamp passes through; anything else is "unknown". */
function stampOf(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** codex/gemini/grok content: a string, or parts each carrying `.text`. */
function flatText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((x) => {
        const part = x as { text?: string }
        return part && typeof part.text === 'string' ? part.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function claudeEvents(buf: string): TurnEvent[] {
  const events: TurnEvent[] = []
  for (const raw of buf.split('\n')) {
    if (!raw.trim()) continue
    const o = parseJson(raw) as
      | { type?: string; isSidechain?: boolean; timestamp?: unknown; message?: { content?: unknown } }
      | undefined
    if (!o) continue
    // A sidechain line belongs to a subagent's conversation interleaved into the parent's file
    // (older layouts); its prose was never said TO the user.
    if (o.isSidechain === true) continue
    const content = o.message?.content
    const at = stampOf(o.timestamp)
    if (o.type === 'assistant' && Array.isArray(content)) {
      const texts: string[] = []
      for (const c of content as { type?: string; text?: string }[]) {
        if (c.type === 'text' && c.text) texts.push(c.text)
      }
      // A tool_use-only line is still the assistant talking (to a tool); it neither adds prose nor
      // resets the run — the tool RESULT does that below.
      if (texts.length) events.push({ role: 'assistant', text: texts.join('\n'), at })
    } else if (o.type === 'user') {
      if (Array.isArray(content)) {
        const hasResult = (content as { type?: string }[]).some((c) => c.type === 'tool_result')
        events.push({ role: hasResult ? 'tool' : 'user', at })
      } else if (typeof content === 'string') {
        events.push({ role: 'user', at })
      }
    }
  }
  return events
}

function codexEvents(buf: string): TurnEvent[] {
  const events: TurnEvent[] = []
  for (const raw of buf.split('\n')) {
    if (!raw.trim()) continue
    const o = parseJson(raw) as
      | { type?: string; timestamp?: unknown; payload?: { type?: string; role?: string; content?: unknown } }
      | undefined
    if (!o || o.type !== 'response_item' || !o.payload) continue
    const p = o.payload
    const at = stampOf(o.timestamp)
    if (p.type === 'message') {
      if (p.role === 'user') events.push({ role: 'user', at })
      else {
        const t = flatText(p.content)
        if (t) events.push({ role: 'assistant', text: t, at })
      }
    } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      events.push({ role: 'tool', at })
    }
  }
  return events
}

function geminiEvents(buf: string): TurnEvent[] {
  const events: TurnEvent[] = []
  for (const m of geminiMessages(buf)) {
    const at = stampOf(m.timestamp)
    if (m.type === 'user') events.push({ role: 'user', at })
    else if (m.type === 'gemini' || m.type === 'model') {
      const t = flatText(m.content)
      if (t) events.push({ role: 'assistant', text: t, at })
    }
  }
  return events
}

function grokEvents(buf: string): TurnEvent[] {
  const events: TurnEvent[] = []
  for (const o of grokParse(buf).lines) {
    const at = stampOf((o as { timestamp?: unknown }).timestamp)
    switch (o.type) {
      // A harness-injected `user` line (synthetic_reason) is still a boundary: what the agent said
      // BEFORE a compaction note or a subagent completion is not its answer to what came after.
      case 'user':
        events.push({ role: 'user', at })
        break
      case 'tool_result':
      case 'backend_tool_call':
        events.push({ role: 'tool', at })
        break
      case 'assistant': {
        const t = flatText(o.content)
        if (t) events.push({ role: 'assistant', text: t, at })
        break
      }
      default:
        break
    }
  }
  return events
}

function opencodeEvents(raw: string): TurnEvent[] | null {
  const msgs = opencodeMessages(raw)
  if (msgs === null) return null
  const events: TurnEvent[] = []
  for (const m of msgs) {
    if (m.role === 'user') {
      events.push({ role: 'user', at: null })
      continue
    }
    for (const p of m.parts) {
      if (p.kind === 'text') events.push({ role: 'assistant', text: p.text, at: null })
      else events.push({ role: 'tool', at: null })
    }
  }
  return events
}

/** The trailing assistant run joined as one reply, or null when the transcript ends on nothing the
 *  agent said (no turn yet, or a turn that ended in a tool call). */
function trailingReply(events: TurnEvent[]): LastReply | null {
  const run: TurnEvent[] = []
  for (const e of events) {
    if (e.role === 'assistant') run.push(e)
    else run.length = 0
  }
  const text = run
    .map((e) => e.text ?? '')
    .join('\n\n')
    .trim()
  if (!text) return null
  // The run's own stamp: the moment its last block was written, which is what the renderer
  // compares against the time it submitted the prompt to tell a fresh reply from a stale file.
  const at = run.reduce<number | null>((acc, e) => (e.at !== null ? e.at : acc), null)
  return { text, at }
}

/**
 * Pure: the last assistant message of a transcript buffer, in the agent's own format. `agentId`
 * routes to the parser; an agent we cannot parse yields null rather than a guess. Exported for
 * its own tests and for the renderer-side dev seam.
 */
export function lastAssistantReply(agentId: string, buf: string): LastReply | null {
  const events = eventsFor(agentId, buf)
  return events ? trailingReply(events) : null
}

function eventsFor(agentId: string, buf: string): TurnEvent[] | null {
  switch (agentId) {
    case 'codex':
      return codexEvents(buf)
    case 'gemini':
      return geminiEvents(buf)
    case 'grok':
      return grokEvents(buf)
    case 'opencode':
      return opencodeEvents(buf)
    default:
      return readsClaudeShapedTranscript(agentId as AgentId) ? claudeEvents(buf) : null
  }
}

export interface LastReplyDeps {
  /** Hook-fed transcript path for a claude session (the context tail's) — authoritative when
   *  present; the sessionId scan below finds any transcript in a standard root otherwise. */
  pathFor?(sessionId: string): string | undefined
  /** `opencode export <sessionId>` — opencode keeps sessions in SQLite, so the export IS the
   *  transcript. Injectable so tests never spawn a CLI. */
  opencodeExport?(sessionId: string): Promise<string | null>
  /** Test seam over the on-disk locators (they walk `$HOME`). */
  locate?(query: LastReplyQuery): Promise<string | undefined>
  /** Test seam over the capped file read. */
  readFile?(path: string): Promise<string | undefined>
}

async function defaultOpencodeExport(sessionId: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process')
    return await new Promise<string | null>((resolve) => {
      execFile('opencode', ['export', sessionId], { encoding: 'utf8', timeout: 8_000 }, (error, stdout) =>
        resolve(error ? null : stdout)
      )
    })
  } catch {
    return null
  }
}

/** Which file holds this node's conversation — the SAME locators context links use, routed by
 *  agent BEFORE anything claude-shaped runs (`resolveTranscript` has a cwd fallback that would
 *  answer a codex node with the newest claude transcript for that folder). */
async function defaultLocate(q: LastReplyQuery, pathFor: LastReplyDeps['pathFor']): Promise<string | undefined> {
  switch (q.agentId) {
    case 'codex':
      return locateCodex(q.sessionId, q.accountId)
    case 'gemini':
      return locateGemini(q.sessionId)
    case 'grok':
      return locateGrok(q.sessionId)
    default:
      return readsClaudeShapedTranscript(q.agentId as AgentId)
        ? resolveTranscript({ sessionId: q.sessionId, cwd: q.cwd, accountId: q.accountId }, pathFor)
        : undefined
  }
}

/** Locate + read + parse. `null` = no transcript, unreadable, or no assistant prose yet — the
 *  renderer says "nothing to read" in every case; the distinction is not worth a fourth state. */
export async function readLastReply(q: LastReplyQuery, deps: LastReplyDeps = {}): Promise<LastReply | null> {
  if (!q || typeof q.sessionId !== 'string' || !SAFE_SESSION_ID.test(q.sessionId)) return null
  if (typeof q.agentId !== 'string' || !q.agentId) return null
  if (q.agentId === 'opencode') {
    const raw = await (deps.opencodeExport ?? defaultOpencodeExport)(q.sessionId)
    return raw === null ? null : lastAssistantReply('opencode', raw)
  }
  const locate = deps.locate ?? ((query: LastReplyQuery) => defaultLocate(query, deps.pathFor))
  const p = await locate(q)
  if (!p) return null
  const buf = await (deps.readFile ?? readCappedTail)(p)
  if (buf === undefined) return null
  return lastAssistantReply(q.agentId, buf)
}

/** Register `speech:last-reply` on the platform seam. Call it in both shells. */
export function registerLastReplyIpc(deps: LastReplyDeps = {}): void {
  platform().handle(IPC.speechLastReply, (query: LastReplyQuery) => readLastReply(query, deps))
}
