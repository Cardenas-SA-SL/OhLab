import { describe, expect, it, vi } from 'vitest'
import {
  ChunkedSpeaker,
  normalizeLang,
  pickReplyVoice,
  replyLanguage,
  splitSentences,
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

describe('voice quality ranking', () => {
  it('prefers Premium, then Enhanced, then compact — and keeps region order inside a tier', () => {
    const list: VoiceLike[] = [
      v('Mónica', 'es_ES'),
      v('Paulina (Enhanced)', 'es_MX'),
      v('Paulina', 'es_MX'),
      v('Mónica (Premium)', 'es_ES'),
      v('Eddy (español (Chile))', 'es_CL')
    ]
    expect(voicesForLanguage(list, 'es-CL').map((x) => x.name)).toEqual([
      'Mónica (Premium)',
      'Paulina (Enhanced)',
      'Eddy (español (Chile))',
      'Paulina',
      'Mónica'
    ])
    expect(pickReplyVoice(list, '', 'es-CL')?.name).toBe('Mónica (Premium)')
  })
})

describe('splitSentences', () => {
  it('cuts at sentence ends, glues tiny fragments, splits run-on sentences at a comma', () => {
    expect(splitSentences('Hay dos archivos. El primero es package.json! ¿Quieres verlos? OK.')).toEqual([
      'Hay dos archivos.',
      'El primero es package.json!',
      '¿Quieres verlos? OK.'
    ])
    expect(splitSentences('')).toEqual([])
    const long = Array.from({ length: 12 }, (_, i) => `parte número ${i + 1} de una frase interminable`).join(', ')
    const pieces = splitSentences(long, 12, 100)
    expect(pieces.length).toBeGreaterThan(2)
    for (const p of pieces) expect(p.length).toBeLessThanOrEqual(100)
    expect(pieces.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })
})

describe('ChunkedSpeaker', () => {
  function inner() {
    const spoken: { text: string; end: () => void }[] = []
    const speaker = {
      speak: vi.fn((req: { text: string }, onEnd: () => void) => {
        spoken.push({ text: req.text, end: onEnd })
      }),
      cancel: vi.fn(),
      speaking: () => false
    }
    return { speaker, spoken }
  }

  it('speaks one sentence at a time, announcing each, and ends once after the last', () => {
    const h = inner()
    const s = new ChunkedSpeaker(h.speaker)
    const chunks: string[] = []
    const onEnd = vi.fn()
    s.speak({ text: 'Uno largo aquí. Dos largo aquí. Tres largo aquí.', rate: 1, lang: 'es' }, onEnd, (t) => chunks.push(t))
    expect(h.spoken.map((x) => x.text)).toEqual(['Uno largo aquí.'])
    expect(s.speaking()).toBe(true)
    h.spoken[0].end()
    h.spoken[1].end()
    expect(onEnd).not.toHaveBeenCalled()
    h.spoken[2].end()
    expect(chunks).toEqual(['Uno largo aquí.', 'Dos largo aquí.', 'Tres largo aquí.'])
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(s.speaking()).toBe(false)
  })

  it('cancel drops the queue and the piece in flight, settling onEnd exactly once (barge-in)', () => {
    const h = inner()
    const s = new ChunkedSpeaker(h.speaker)
    const onEnd = vi.fn()
    s.speak({ text: 'Primera frase larga. Segunda frase larga. Tercera frase larga.', rate: 1, lang: 'es' }, onEnd)
    s.cancel()
    expect(h.speaker.cancel).toHaveBeenCalledTimes(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
    // A late end from the cancelled piece must not resurrect the queue.
    h.spoken[0].end()
    expect(h.spoken).toHaveLength(1)
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('an empty reply ends immediately', () => {
    const h = inner()
    const onEnd = vi.fn()
    new ChunkedSpeaker(h.speaker).speak({ text: '   ', rate: 1, lang: 'es' }, onEnd)
    expect(onEnd).toHaveBeenCalledTimes(1)
    expect(h.spoken).toEqual([])
  })
})
