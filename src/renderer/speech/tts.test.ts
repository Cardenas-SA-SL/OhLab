import { describe, expect, it, vi } from 'vitest'
import {
  normalizeLang,
  pickReplyVoice,
  replyLanguage,
  SynthSpeaker,
  voicesForLanguage,
  type SpokenRecord,
  type VoiceLike
} from './tts'

const v = (name: string, lang: string, extra: Partial<VoiceLike> = {}): VoiceLike => ({
  name,
  lang,
  voiceURI: `com.apple.voice.${name}`,
  ...extra
})

// A macOS-shaped voice list (Electron reports the system voices with `es_MX`-style tags).
const VOICES: VoiceLike[] = [
  v('Samantha', 'en_US', { default: true, localService: true }),
  v('Daniel', 'en_GB', { localService: true }),
  v('Mónica', 'es_ES', { localService: true }),
  v('Paulina', 'es_MX', { localService: true }),
  v('Eddy (Español (Chile))', 'es_CL'),
  v('Anna', 'de_DE', { localService: true })
]

describe('replyLanguage', () => {
  it('auto = the system language; a pinned base keeps the system region when they agree', () => {
    expect(replyLanguage('auto', 'es-CL')).toBe('es-CL')
    expect(replyLanguage('', 'en_US')).toBe('en-US')
    expect(replyLanguage('es', 'es-CL')).toBe('es-CL')
    expect(replyLanguage('es', 'en-US')).toBe('es')
    expect(replyLanguage('pl', 'es-CL')).toBe('pl')
    expect(replyLanguage('auto', '')).toBe('en-US')
  })
  it('normalizes tags', () => {
    expect(normalizeLang('es_mx')).toBe('es-MX')
    expect(normalizeLang('EN')).toBe('en')
    expect(normalizeLang('')).toBe('')
  })
})

describe('voicesForLanguage / pickReplyVoice', () => {
  it('lists only the language, exact region first, then the Spanish preference order', () => {
    expect(voicesForLanguage(VOICES, 'es-MX').map((x) => x.name)).toEqual([
      'Paulina',
      'Eddy (Español (Chile))',
      'Mónica'
    ])
    expect(voicesForLanguage(VOICES, 'es').map((x) => x.name)).toEqual([
      'Eddy (Español (Chile))',
      'Paulina',
      'Mónica'
    ])
    expect(voicesForLanguage(VOICES, 'en-GB').map((x) => x.name)).toEqual(['Daniel', 'Samantha'])
    expect(voicesForLanguage(VOICES, 'fr')).toEqual([])
  })

  it('honours an installed explicit choice, ignores a vanished one, falls back to en-US, then undefined', () => {
    expect(pickReplyVoice(VOICES, 'com.apple.voice.Mónica', 'es-CL')?.name).toBe('Mónica')
    expect(pickReplyVoice(VOICES, 'com.apple.voice.Gone', 'es-CL')?.name).toBe('Eddy (Español (Chile))')
    expect(pickReplyVoice(VOICES, '', 'es-CL')?.name).toBe('Eddy (Español (Chile))')
    expect(pickReplyVoice(VOICES, '', 'fr-FR')?.name).toBe('Samantha')
    expect(pickReplyVoice([v('Anna', 'de_DE')], '', 'fr-FR')).toBeUndefined()
    expect(pickReplyVoice([], '', 'es')).toBeUndefined()
  })
})

describe('SynthSpeaker', () => {
  type Utt = {
    text: string
    voice?: unknown
    rate?: number
    lang?: string
    onend?: () => void
    onerror?: () => void
  }
  function harness() {
    const spoken: Utt[] = []
    const records: SpokenRecord[] = []
    const synth = { speak: vi.fn((u: Utt) => spoken.push(u)), cancel: vi.fn(), getVoices: () => [] }
    const timers: { fn: () => void; ms: number }[] = []
    const speaker = new SynthSpeaker(
      synth as never,
      (text) => ({ text }) as unknown as SpeechSynthesisUtterance,
      (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length - 1
      },
      () => {},
      (r) => records.push(r)
    )
    return { spoken, records, synth, timers, speaker }
  }

  it('hands text, voice, rate and lang to the synthesizer and records it for the test seam', () => {
    const h = harness()
    const voice = v('Paulina', 'es_MX')
    const onEnd = vi.fn()
    h.speaker.speak({ text: 'hola', voice, rate: 1.2, lang: 'es-CL' }, onEnd)
    expect(h.spoken).toHaveLength(1)
    expect(h.spoken[0]).toMatchObject({ text: 'hola', voice, rate: 1.2, lang: 'es_MX' })
    expect(h.records[0]).toMatchObject({ text: 'hola', voiceURI: 'com.apple.voice.Paulina', rate: 1.2 })
    expect(h.speaker.speaking()).toBe(true)
    h.spoken[0].onend!()
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(h.speaker.speaking()).toBe(false)
    // A late error after end must not fire the callback twice.
    h.spoken[0].onerror!()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('cancel() stops the synthesizer and settles onEnd synchronously, exactly once', () => {
    const h = harness()
    const onEnd = vi.fn()
    h.speaker.speak({ text: 'largo texto', rate: 1, lang: 'es' }, onEnd)
    h.speaker.cancel()
    expect(h.synth.cancel).toHaveBeenCalled()
    expect(onEnd).toHaveBeenCalledTimes(1)
    // Chromium sometimes fires `end` after a cancel — already settled, ignored.
    h.spoken[0].onend!()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('the watchdog ends a stalled utterance, bounded by text length and rate', () => {
    const h = harness()
    const onEnd = vi.fn()
    h.speaker.speak({ text: 'x'.repeat(100), rate: 2, lang: 'en' }, onEnd)
    expect(h.timers[0].ms).toBe((100 * 120) / 2 + 5000)
    h.timers[0].fn()
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('a second speak() cancels the first and settles its callback', () => {
    const h = harness()
    const first = vi.fn()
    const second = vi.fn()
    h.speaker.speak({ text: 'one', rate: 1, lang: 'en' }, first)
    h.speaker.speak({ text: 'two', rate: 1, lang: 'en' }, second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(h.spoken.map((u) => u.text)).toEqual(['one', 'two'])
  })
})
