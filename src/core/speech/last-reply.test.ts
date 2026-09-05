import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../shared/ipc'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { lastAssistantReply, readLastReply, registerLastReplyIpc } from './last-reply'

const fixture = (rel: string): string =>
  readFileSync(path.join(__dirname, '..', '__fixtures__', rel), 'utf8')

const codexRollout = fixture('codex/rollout-conversation.jsonl')
const CODEX_FINAL =
  'El proyecto tiene `package.json` y la carpeta `src`.\n\n```bash\nls\n```\n\nMás detalles en https://example.com/proyecto.'

describe('lastAssistantReply — codex rollout', () => {
  it('returns the final answer, not the commentary that preceded the tool call', () => {
    const r = lastAssistantReply('codex', codexRollout)
    expect(r).toEqual({ text: CODEX_FINAL, at: Date.parse('2026-09-04T18:00:07.000Z') })
    expect(r?.text).not.toContain('Voy a listar')
  })

  it('is null when the turn ends on a tool call (nothing has been said yet)', () => {
    // Every line up to and including the function_call_output — the final message has not landed.
    const cut = codexRollout.split('\n').filter((l) => l && !l.includes('"phase":"final_answer"') && !l.includes('task_complete'))
    // The commentary before the tool call is NOT the answer: the tool result reset the run.
    expect(lastAssistantReply('codex', cut.join('\n'))).toBeNull()
  })

  it('is null for a rollout that carries only usage events (the context-meter fixture)', () => {
    expect(lastAssistantReply('codex', fixture('codex/rollout.jsonl'))).toBeNull()
  })

  it('joins two consecutive assistant messages of one turn', () => {
    const lines = [
      { type: 'response_item', timestamp: '2026-09-04T10:00:00.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q' }] } },
      { type: 'response_item', timestamp: '2026-09-04T10:00:01.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Part one.' }] } },
      { type: 'response_item', timestamp: '2026-09-04T10:00:02.000Z', payload: { type: 'reasoning', summary: [], encrypted_content: 'x' } },
      { type: 'response_item', timestamp: '2026-09-04T10:00:03.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Part two.' }] } }
    ]
    expect(lastAssistantReply('codex', lines.map((l) => JSON.stringify(l)).join('\n'))).toEqual({
      text: 'Part one.\n\nPart two.',
      at: Date.parse('2026-09-04T10:00:03.000Z')
    })
  })
})

describe('lastAssistantReply — claude transcript', () => {
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)
  const claude = [
    line({ type: 'user', timestamp: '2026-09-04T09:00:00.000Z', message: { content: 'show me the files' } }),
    line({ type: 'assistant', timestamp: '2026-09-04T09:00:01.000Z', message: { content: [{ type: 'text', text: 'Let me check.' }] } }),
    line({ type: 'assistant', timestamp: '2026-09-04T09:00:02.000Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    line({ type: 'user', timestamp: '2026-09-04T09:00:03.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb' }] } }),
    line({ type: 'assistant', timestamp: '2026-09-04T09:00:04.000Z', message: { content: [{ type: 'text', text: 'Two files: a and b.' }] } }),
    line({ type: 'assistant', timestamp: '2026-09-04T09:00:05.000Z', message: { content: [{ type: 'text', text: 'Anything else?' }] } }),
    // A sidechain (subagent) line interleaved into the parent file is not something said to the user.
    line({ type: 'assistant', isSidechain: true, timestamp: '2026-09-04T09:00:06.000Z', message: { content: [{ type: 'text', text: 'subagent chatter' }] } }),
    '',
    'garbled'
  ]

  it('returns the trailing run after the last tool result, both text blocks, stamped by the last', () => {
    expect(lastAssistantReply('claude', claude.join('\n'))).toEqual({
      text: 'Two files: a and b.\n\nAnything else?',
      at: Date.parse('2026-09-04T09:00:05.000Z')
    })
  })

  it('is null once a new prompt has been typed and nothing has been answered yet', () => {
    const withPrompt = [...claude, line({ type: 'user', timestamp: '2026-09-04T09:01:00.000Z', message: { content: [{ type: 'text', text: 'and now?' }] } })]
    expect(lastAssistantReply('claude', withPrompt.join('\n'))).toBeNull()
  })

  it('has no timestamp when the transcript carries none', () => {
    const bare = [
      line({ type: 'user', message: { content: 'hi' } }),
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })
    ]
    expect(lastAssistantReply('claude', bare.join('\n'))).toEqual({ text: 'hello', at: null })
  })
})

describe('lastAssistantReply — gemini, grok, opencode', () => {
  it('gemini: replays the event-sourced file and returns the last model message', () => {
    const r = lastAssistantReply('gemini', fixture('gemini/session.jsonl'))
    expect(r?.text.startsWith('Acknowledged. I have noted that the context link')).toBe(true)
    expect(r?.at).toBe(Date.parse('2026-08-09T11:12:30.911Z'))
  })

  it('grok: the last assistant line after the last tool result; the measured fixture parses', () => {
    const synthetic = [
      { type: 'user', content: 'do it' },
      { type: 'assistant', content: 'Running the tool.', tool_calls: [{ id: 'c1', name: 'bash', arguments: 'ls' }] },
      { type: 'tool_result', tool_call_id: 'c1', content: 'ok' },
      { type: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] },
      { type: 'reasoning', encrypted_content: 'zzz' }
    ]
    expect(lastAssistantReply('grok', synthetic.map((l) => JSON.stringify(l)).join('\n'))).toEqual({
      text: 'Final answer.',
      at: null
    })
    const real = lastAssistantReply('grok', fixture('grok/chat_history.jsonl'))
    expect(real === null || typeof real.text === 'string').toBe(true)
  })

  it('opencode: the export is the transcript; a tool part inside the reply resets the run', () => {
    const doc = JSON.stringify({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'list files' }] },
        {
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Listing…' },
            { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } },
            { type: 'text', text: 'There are two files.' }
          ]
        }
      ]
    })
    expect(lastAssistantReply('opencode', doc)).toEqual({ text: 'There are two files.', at: null })
    expect(lastAssistantReply('opencode', 'not json')).toBeNull()
  })

  it('an agent with no parser yields null, never a guess', () => {
    expect(lastAssistantReply('copilot', codexRollout)).toBeNull()
    expect(lastAssistantReply('custom:abc', codexRollout)).toBeNull()
  })
})

describe('readLastReply', () => {
  it('refuses a path-shaped or empty session id before touching the disk', async () => {
    const locate = vi.fn()
    expect(await readLastReply({ agentId: 'codex', sessionId: '../etc' }, { locate })).toBeNull()
    expect(await readLastReply({ agentId: 'codex', sessionId: '' }, { locate })).toBeNull()
    expect(locate).not.toHaveBeenCalled()
  })

  it('locates by agent, reads the capped tail and parses in that agent\'s format', async () => {
    const locate = vi.fn(async () => '/fake/rollout.jsonl')
    const readFile = vi.fn(async () => codexRollout)
    const r = await readLastReply(
      { agentId: 'codex', sessionId: '01a06f3b-aaaa-7b63-9aef-baeb2e238d04', accountId: 'acc-1' },
      { locate, readFile }
    )
    expect(locate).toHaveBeenCalledWith({ agentId: 'codex', sessionId: '01a06f3b-aaaa-7b63-9aef-baeb2e238d04', accountId: 'acc-1' })
    expect(readFile).toHaveBeenCalledWith('/fake/rollout.jsonl')
    expect(r?.text).toBe(CODEX_FINAL)
  })

  it('answers null when nothing is located or the file cannot be read', async () => {
    expect(await readLastReply({ agentId: 'gemini', sessionId: 'abcd-1234' }, { locate: async () => undefined })).toBeNull()
    expect(
      await readLastReply({ agentId: 'gemini', sessionId: 'abcd-1234' }, { locate: async () => '/x', readFile: async () => undefined })
    ).toBeNull()
  })

  it('opencode goes through the export runner and never a file locator', async () => {
    const locate = vi.fn()
    const opencodeExport = vi.fn(async () =>
      JSON.stringify({ messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'Exported answer' }] }] })
    )
    const r = await readLastReply({ agentId: 'opencode', sessionId: 'ses_abc123' }, { locate, opencodeExport })
    expect(opencodeExport).toHaveBeenCalledWith('ses_abc123')
    expect(locate).not.toHaveBeenCalled()
    expect(r).toEqual({ text: 'Exported answer', at: null })
    expect(await readLastReply({ agentId: 'opencode', sessionId: 'ses_abc123' }, { opencodeExport: async () => null })).toBeNull()
  })
})

describe('registerLastReplyIpc', () => {
  afterEach(() => resetPlatformForTests())

  it('serves speech:last-reply on the platform seam with the injected deps', async () => {
    const fake = fakePlatform()
    initPlatform(fake)
    registerLastReplyIpc({ locate: async () => '/fake/rollout.jsonl', readFile: async () => codexRollout })
    const handler = fake.handlers[IPC.speechLastReply]
    expect(typeof handler).toBe('function')
    const r = (await handler({ agentId: 'codex', sessionId: '01a06f3b-aaaa-7b63-9aef-baeb2e238d04' })) as {
      text: string
    } | null
    expect(r?.text).toBe(CODEX_FINAL)
  })
})
