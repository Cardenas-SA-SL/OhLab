/**
 * The "mouth" of voice conversation: reply language, voice choice and a thin speaker over the
 * renderer's `window.speechSynthesis` (Electron on macOS exposes the system voices — no new
 * dependency). The choice logic is pure and unit-tested; only `SynthSpeaker` touches the DOM API.
 */

/** The subset of `SpeechSynthesisVoice` the choice logic reads. */
export interface VoiceLike {
  name: string
  lang: string
  voiceURI: string
  default?: boolean
  localService?: boolean
}

/** Spanish regions in preference order when the user has not chosen a voice: the user's own
 *  locale comes first via `replyLanguage`; among the rest, Latin-American voices read a Chilean
 *  developer's replies more naturally than Castilian ones. */
export const SPANISH_REGION_PREFERENCE = ['es-CL', 'es-MX', 'es-ES']

/** `es_MX` → `es-MX`, lowercase base, uppercase region. */
export function normalizeLang(tag: string): string {
  const [base, region] = tag.trim().replace(/_/g, '-').split('-')
  if (!base) return ''
  return region ? `${base.toLowerCase()}-${region.toUpperCase()}` : base.toLowerCase()
}

export function baseLang(tag: string): string {
  return normalizeLang(tag).split('-')[0]
}

/**
 * Which language replies are spoken in: the dictation language when the user pinned one (a
 * whisper code such as `es`; the system locale's region is kept when it agrees, so `es` on an
 * `es-CL` Mac speaks `es-CL`), else the system language (`auto` = "whatever I speak", and the
 * system locale is the best guess at that).
 */
export function replyLanguage(dictationLanguage: string, systemLanguage: string): string {
  const sys = normalizeLang(systemLanguage || 'en-US') || 'en-US'
  if (!dictationLanguage || dictationLanguage === 'auto') return sys
  const pinned = normalizeLang(dictationLanguage)
  return baseLang(sys) === baseLang(pinned) ? sys : pinned
}

/** Voices for a language, best first: exact region, then the preferred regions (Spanish), then a
 *  system-default flag, then on-device voices, then name order (stable, so the picker is too). */
export function voicesForLanguage(voices: readonly VoiceLike[], lang: string): VoiceLike[] {
  const want = normalizeLang(lang)
  const base = baseLang(want)
  const rank = (v: VoiceLike): number => {
    const l = normalizeLang(v.lang)
    if (l === want) return 0
    const pref = base === 'es' ? SPANISH_REGION_PREFERENCE.indexOf(l) : -1
    return pref >= 0 ? 1 + pref : 10
  }
  return voices
    .filter((v) => baseLang(v.lang) === base)
    .map((v, i) => ({ v, i }))
    .sort((a, b) => {
      const r = rank(a.v) - rank(b.v)
      if (r) return r
      if (!!a.v.default !== !!b.v.default) return a.v.default ? -1 : 1
      if (!!a.v.localService !== !!b.v.localService) return a.v.localService ? -1 : 1
      const n = a.v.name.localeCompare(b.v.name)
      return n || a.i - b.i
    })
    .map(({ v }) => v)
}

/**
 * The voice to speak with: the user's explicit choice when it is still installed, else the best
 * voice for the reply language, else the best `en-US` voice, else undefined (the synthesizer's
 * own default — a reply is still spoken, in whatever the system considers its voice).
 */
export function pickReplyVoice(
  voices: readonly VoiceLike[],
  preferredURI: string,
  lang: string
): VoiceLike | undefined {
  if (preferredURI) {
    const exact = voices.find((v) => v.voiceURI === preferredURI)
    if (exact) return exact
  }
  return voicesForLanguage(voices, lang)[0] ?? voicesForLanguage(voices, 'en-US')[0]
}

export interface SpeakRequest {
  text: string
  voice?: VoiceLike
  rate: number
  lang: string
}

/** What a test seam records per utterance — the proof of what was handed to the synthesizer. */
export interface SpokenRecord extends SpeakRequest {
  voiceURI: string | null
  at: number
}

/** The synthesizer surface `SynthSpeaker` needs (a `SpeechSynthesis`, or a fake in tests). */
export interface SynthLike {
  speak(u: SpeechSynthesisUtterance): void
  cancel(): void
  getVoices(): SpeechSynthesisVoice[]
}

/**
 * Speaks one utterance at a time over `speechSynthesis`, with an `onEnd` that fires EXACTLY ONCE
 * per `speak()` — on end, on error, on cancel, or on a watchdog. The watchdog exists because
 * Chromium has been known to drop `end` after a `cancel()` and, with some remote voices, to stall
 * mid-utterance without any event; a conversation loop that waits forever for `end` is a loop
 * stuck on "Speaking". The budget is generous (character count at the rate, plus slack).
 */
export class SynthSpeaker {
  private current: { utterance: SpeechSynthesisUtterance; done: () => void } | null = null
  constructor(
    private readonly synth: SynthLike,
    private readonly makeUtterance: (text: string) => SpeechSynthesisUtterance = (t) =>
      new SpeechSynthesisUtterance(t),
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly clearTimer: (h: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    private readonly record?: (r: SpokenRecord) => void
  ) {}

  speak(req: SpeakRequest, onEnd: () => void): void {
    this.cancel()
    const u = this.makeUtterance(req.text)
    if (req.voice) u.voice = req.voice as SpeechSynthesisVoice
    u.rate = req.rate
    u.lang = req.voice?.lang ?? req.lang
    let ended = false
    let watchdog: unknown = null
    const done = (): void => {
      if (ended) return
      ended = true
      if (watchdog !== null) this.clearTimer(watchdog)
      if (this.current?.utterance === u) this.current = null
      onEnd()
    }
    u.onend = done
    u.onerror = done
    this.current = { utterance: u, done }
    this.record?.({ ...req, voiceURI: req.voice?.voiceURI ?? null, at: Date.now() })
    // ~120 ms per character at rate 1 is far slower than any voice; the point is a bound, not an estimate.
    watchdog = this.setTimer(done, Math.min(180_000, (req.text.length * 120) / Math.max(0.5, req.rate) + 5_000))
    this.synth.speak(u)
  }

  /** Stop what is being said (barge-in / pause / stop). The pending `onEnd` fires synchronously
   *  here so the caller's state is settled before the synthesizer's own late events land. */
  cancel(): void {
    const cur = this.current
    this.current = null
    this.synth.cancel()
    cur?.done()
  }

  speaking(): boolean {
    return this.current !== null
  }
}
