import { describe, expect, it } from 'vitest'
import {
  WHISPER_MODELS,
  whisperModel,
  WHISPER_DOWNLOAD_BASE,
  hasSpeechModel,
  modelAfterDownload,
  modelAfterDelete,
  SPEECH_MODEL_NONE,
  type ModelDownloadState,
  SPEECH_LANGUAGES,
  SPEECH_LANGUAGE_AUTO,
  speechLanguage,
  speechLanguageLabel,
  filterSpeechLanguages,
  modelKnowsV3Languages,
  normalizeReplyRate,
  normalizeSpeechReplySettings,
  REPLY_RATE_DEFAULT,
  REPLY_RATE_MAX,
  REPLY_RATE_MIN
} from './speech'
import { DEFAULT_SETTINGS } from './types'

describe('whisper model catalog', () => {
  it('matches the spec table exactly', () => {
    expect(WHISPER_MODELS.map((m) => m.id)).toEqual(['tiny', 'base', 'small', 'large-v3-turbo'])
    expect(WHISPER_MODELS.map((m) => m.file)).toEqual([
      'ggml-tiny.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-large-v3-turbo.bin',
    ])
    expect(WHISPER_MODELS.every((m) => !('pro' in m))).toBe(true)
  })

  it('looks up by id and rejects unknowns', () => {
    expect(whisperModel('base')?.approxMB).toBe(142)
    expect(whisperModel('nope')).toBeUndefined()
  })

  it('download base is the whisper.cpp HF repo', () => {
    expect(WHISPER_DOWNLOAD_BASE).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')
  })

  it('defaults to the multilingual small model for zero-configuration voice', () => {
    expect(DEFAULT_SETTINGS.speech).toEqual({
      engine: 'whisper',
      model: 'small',
      language: 'auto',
      shortcut: 'Cmd+Alt',
      // Voice conversation: system voice per reply language, natural rate, replies spoken.
      replyVoice: '',
      replyRate: 1,
      speakReplies: true
    })
  })

  describe('voice conversation reply settings', () => {
    it('clamps the rate into the audible band and defaults a non-number', () => {
      expect(normalizeReplyRate(1.3)).toBe(1.3)
      expect(normalizeReplyRate(0.1)).toBe(REPLY_RATE_MIN)
      expect(normalizeReplyRate(9)).toBe(REPLY_RATE_MAX)
      expect(normalizeReplyRate('fast')).toBe(REPLY_RATE_DEFAULT)
      expect(normalizeReplyRate(Number.NaN)).toBe(REPLY_RATE_DEFAULT)
      expect(normalizeReplyRate(undefined)).toBe(REPLY_RATE_DEFAULT)
    })

    it('reads a hand-edited settings.json defensively: strings stay strings, booleans stay booleans', () => {
      expect(
        normalizeSpeechReplySettings({ replyVoice: 'com.apple.voice.compact.es-MX.Paulina', replyRate: 1.5, speakReplies: false })
      ).toEqual({ replyVoice: 'com.apple.voice.compact.es-MX.Paulina', replyRate: 1.5, speakReplies: false })
      // A truthy string is NOT "on": the switch could not render it and the loop would speak anyway.
      expect(normalizeSpeechReplySettings({ replyVoice: 42, replyRate: '2', speakReplies: 'yes' })).toEqual({
        replyVoice: '',
        replyRate: REPLY_RATE_DEFAULT,
        speakReplies: true
      })
      expect(normalizeSpeechReplySettings({})).toEqual({ replyVoice: '', replyRate: 1, speakReplies: true })
    })
  })

  it('hasSpeechModel reads None as off and any id as on', () => {
    expect(hasSpeechModel(SPEECH_MODEL_NONE)).toBe(false)
    expect(hasSpeechModel('tiny')).toBe(true)
  })
})

const list = (...ids: Array<[string, boolean]>): ModelDownloadState[] =>
  ids.map(([id, downloaded]) => ({ id, downloaded }))

describe('modelAfterDownload', () => {
  it('adopts the first download — the default selection points at a model nobody fetched', () => {
    // `tiny` is selected out of the box (see the default above), so a user whose first download is
    // `base` was left pointed at a file that is not on disk, and dictation failed.
    expect(modelAfterDownload(list(['tiny', false], ['base', true]), 'tiny', 'base')).toBe('base')
  })

  it('leaves a working selection alone when a second model is tried out', () => {
    expect(modelAfterDownload(list(['tiny', true], ['small', true]), 'tiny', 'small')).toBeNull()
  })

  it('is a no-op when the selection is what was just downloaded', () => {
    expect(modelAfterDownload(list(['tiny', true]), 'tiny', 'tiny')).toBeNull()
  })

  it('adopts when the selected id is not in the catalogue at all', () => {
    // A removed/renamed model in an old settings file has nothing behind it either.
    expect(modelAfterDownload(list(['base', true]), 'ancient', 'base')).toBe('base')
  })

  it('adopts out of the None state — starting a download IS asking for dictation (#143)', () => {
    expect(modelAfterDownload(list(['base', true]), SPEECH_MODEL_NONE, 'base')).toBe('base')
  })
})

describe('modelAfterDelete', () => {
  it('falls back to another downloaded model when the selected one is deleted', () => {
    expect(modelAfterDelete(list(['tiny', false], ['small', true]), 'tiny')).toBe('small')
  })

  it('keeps the selection when it is still on disk', () => {
    expect(modelAfterDelete(list(['tiny', true], ['small', true]), 'tiny')).toBeNull()
  })

  it('answers null when nothing is downloaded — there is nothing truthful to select', () => {
    expect(modelAfterDelete(list(['tiny', false], ['small', false]), 'tiny')).toBeNull()
  })

  it('NEVER heals an explicit None — deleting a leftover model keeps dictation off (#143)', () => {
    // With None selected and another model still on disk, the old fallback would have re-adopted
    // it behind the user's back. An unset state is a legitimate value, not a dangling pointer.
    expect(modelAfterDelete(list(['tiny', true], ['small', true]), SPEECH_MODEL_NONE)).toBeNull()
  })
})

describe('speech language catalog', () => {
  it('covers whisper’s own language set, Polish and the rest included', () => {
    // The 7-entry hand-written list this replaced (issue #586) is the floor, not the shape:
    // every code whisper accepts must be reachable from the picker.
    const codes = SPEECH_LANGUAGES.map((l) => l.code)
    expect(codes).toHaveLength(100)
    expect(new Set(codes).size).toBe(100)
    for (const c of ['pl', 'it', 'pt', 'ru', 'uk', 'nl', 'zh', 'ko', 'hi', 'cs']) {
      expect(codes).toContain(c)
    }
    // The codes the old list had must all still be there — nobody loses their setting.
    for (const c of ['en', 'tr', 'de', 'fr', 'es', 'ja']) expect(codes).toContain(c)
    // `auto` is NOT a whisper language: it means "no hint", and lives outside the table.
    expect(codes).not.toContain(SPEECH_LANGUAGE_AUTO)
  })

  it('is ordered by English name and fully populated', () => {
    const labels = SPEECH_LANGUAGES.map((l) => l.label)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b, 'en')))
    for (const l of SPEECH_LANGUAGES) {
      expect(l.code).toMatch(/^[a-z]{2,3}$/)
      expect(l.label.length).toBeGreaterThan(0)
      expect(l.endonym.length).toBeGreaterThan(0)
      // An alias that only repeats the label costs a scan and teaches nothing.
      for (const a of l.aliases ?? []) expect(a.toLowerCase()).not.toBe(l.label.toLowerCase())
    }
  })

  it('marks Cantonese as the one large-v3-only entry', () => {
    expect(SPEECH_LANGUAGES.filter((l) => l.sinceV3).map((l) => l.code)).toEqual(['yue'])
    expect(modelKnowsV3Languages('large-v3-turbo')).toBe(true)
    expect(modelKnowsV3Languages('tiny')).toBe(false)
    expect(modelKnowsV3Languages('small')).toBe(false)
  })

  it('names the stored value, and hands back an unknown code instead of eating it', () => {
    expect(speechLanguageLabel('auto')).toBe('Auto-detect')
    expect(speechLanguageLabel('pl')).toBe('Polish')
    // The old <select> rendered a stored code it did not know as blank and overwrote it on the
    // next click. A code we cannot name is still the user's setting.
    expect(speechLanguageLabel('xx')).toBe('xx')
    expect(speechLanguageLabel('')).toBe('')
    expect(speechLanguage('pl')).toMatchObject({ label: 'Polish', endonym: 'polski' })
    expect(speechLanguage('xx')).toBeUndefined()
  })

  it('finds a language by code, English name, endonym or alias', () => {
    const first = (q: string): string | undefined => filterSpeechLanguages(q)[0]?.code
    expect(first('pl')).toBe('pl')
    expect(first('pol')).toBe('pl')
    expect(first('polski')).toBe('pl')
    expect(first('Polish')).toBe('pl')
    expect(first('deutsch')).toBe('de')
    expect(first('mandarin')).toBe('zh') // whisper's own alias table
    expect(first('bengali')).toBe('bn') // CLDR calls it Bangla
    expect(filterSpeechLanguages('zzzz')).toEqual([])
    expect(filterSpeechLanguages('  ')).toEqual(SPEECH_LANGUAGES)
  })

  it('folds diacritics, so a speaker can type their own name without them', () => {
    const first = (q: string): string | undefined => filterSpeechLanguages(q)[0]?.code
    expect(first('turkce')).toBe('tr') // Türkçe
    expect(first('cestina')).toBe('cs') // čeština
    expect(first('islenska')).toBe('is') // íslenska
    // Non-Latin scripts are searched as typed.
    expect(first('русский')).toBe('ru')
    expect(first('日本語')).toBe('ja')
  })

  it('ranks an exact code above a name that merely contains it', () => {
    // "pl" is a substring of Nepali's endonym neighbourhood; the code must still win.
    expect(filterSpeechLanguages('pl')[0].code).toBe('pl')
    // Prefix beats substring: "ka" is Georgian's code, and also inside "Slovak"/"Kazakh".
    expect(filterSpeechLanguages('ka')[0].code).toBe('ka')
  })
})
