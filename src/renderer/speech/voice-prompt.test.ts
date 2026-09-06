import { describe, expect, it } from 'vitest'
import { VOICE_TAG, voiceLangOf, voicePrompt } from './voice-prompt'

describe('voicePrompt', () => {
  it('wraps the utterance in the Spanish speech instruction for an es-* reply language', () => {
    const p = voicePrompt('muéstrame los archivos del proyecto', 'es-CL', true)
    expect(p.startsWith(VOICE_TAG.es)).toBe(true)
    expect(p).toMatch(/1 a 3 frases cortas en español/)
    expect(p).toMatch(/sin código, sin listas ni markdown/)
    expect(p).toMatch(/pregunta si quiero verla en pantalla/)
    expect(p.endsWith('Mensaje: muéstrame los archivos del proyecto')).toBe(true)
    // One line: the composer submits on Enter, and a newline would split the prompt.
    expect(p).not.toContain('\n')
  })

  it('uses the English instruction for any other language', () => {
    const p = voicePrompt('show me the files', 'en-US', true)
    expect(p.startsWith(VOICE_TAG.en)).toBe(true)
    expect(p.endsWith('Message: show me the files')).toBe(true)
    expect(voicePrompt('zeig mir die Dateien', 'de', true).startsWith(VOICE_TAG.en)).toBe(true)
  })

  it('is the bare utterance when the prefix is off or the utterance is empty', () => {
    expect(voicePrompt('  hola Codex  ', 'es', false)).toBe('hola Codex')
    expect(voicePrompt('   ', 'es', true)).toBe('')
  })

  it('maps languages to the two instruction sets', () => {
    expect(voiceLangOf('es')).toBe('es')
    expect(voiceLangOf('es_MX')).toBe('es')
    expect(voiceLangOf('en-GB')).toBe('en')
    expect(voiceLangOf(undefined)).toBe('en')
  })
})
