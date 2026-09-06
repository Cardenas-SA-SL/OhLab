import { describe, expect, it } from 'vitest'
import { voiceChipLabel, voiceNoticeText } from './VoiceChip'

describe('voiceChipLabel', () => {
  it('names every phase the spec lists, and the two setup phases', () => {
    expect(voiceChipLabel('listening', null, null)).toBe('Listening')
    expect(voiceChipLabel('hearing', null, null)).toBe('Hearing…')
    expect(voiceChipLabel('transcribing', null, null)).toBe('Transcribing…')
    expect(voiceChipLabel('thinking', null, null)).toBe('Thinking')
    expect(voiceChipLabel('speaking', null, null)).toBe('Speaking')
    expect(voiceChipLabel('paused', null, null)).toBe('Paused')
    expect(voiceChipLabel('error', null, null)).toBe('Voice error')
    expect(voiceChipLabel('starting', null, null)).toBe('Starting…')
    expect(voiceChipLabel('downloading', null, 42.4)).toBe('Downloading model 42%')
    expect(voiceChipLabel('idle', null, null)).toBe('')
  })

  it('shows what was heard while thinking, ellipsized so the header never widens', () => {
    expect(voiceChipLabel('thinking', 'muéstrame los archivos', null)).toBe('Heard “muéstrame los archivos” · Thinking')
    const long = 'hola Codex, muéstrame todos los archivos del proyecto por favor'
    const label = voiceChipLabel('thinking', long, null)
    expect(label.startsWith('Heard “hola Codex, muéstrame')).toBe(true)
    expect(label.endsWith('…” · Thinking')).toBe(true)
    expect(label.length).toBeLessThan(long.length)
  })
})

describe('voiceNoticeText', () => {
  it('has a sentence for every notice code and null for none', () => {
    for (const code of ['too-short', 'no-reply', 'not-delivered', 'transcribe-failed', 'reply-timeout'] as const) {
      expect(voiceNoticeText(code)?.length).toBeGreaterThan(8)
    }
    expect(voiceNoticeText(null)).toBeNull()
  })
})
