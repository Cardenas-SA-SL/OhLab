import { describe, expect, it } from 'vitest'
import { voiceOverlayStatus } from './VoiceOverlay'
import type { VoicePhase } from '../speech/voice-conversation'

describe('voiceOverlayStatus', () => {
  it('has a spoken-mode sentence for every phase, and the download percent', () => {
    const phases: VoicePhase[] = ['starting', 'listening', 'hearing', 'transcribing', 'thinking', 'speaking', 'paused', 'error']
    for (const p of phases) expect(voiceOverlayStatus(p, null).length).toBeGreaterThan(5)
    expect(voiceOverlayStatus('downloading', 33.3)).toBe('Downloading the speech model… 33%')
    expect(voiceOverlayStatus('idle', null)).toBe('')
    expect(voiceOverlayStatus('listening', null)).toMatch(/just talk/)
  })
})
