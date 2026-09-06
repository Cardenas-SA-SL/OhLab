/**
 * The prompt a spoken utterance becomes (docs/VOICE.md, "Voice conversation"). Agents answer like
 * coders — long, code blocks, lists — and that is unusable aloud, so with
 * `settings.speech.voicePromptPrefix` on, every transcription is wrapped in a short instruction
 * the agent follows: answer for speech, 1-3 short sentences, no code / lists / markdown, and if the
 * answer needs code or is long, summarize it aloud and ASK whether to show it on screen. The
 * instruction follows the reply language (Spanish for `es-*`, English otherwise).
 *
 * The persistent half lives in each agent's instruction file (`core/voice-mode-instructions.ts`,
 * the same marker-block mechanism the context-link note uses), which is what lets this prefix stay
 * one sentence: the tag `[Modo voz]` / `[Voice mode]` is the cue those instructions key on.
 * Pure.
 */
export const VOICE_TAG: Record<'es' | 'en', string> = { es: '[Modo voz]', en: '[Voice mode]' }

const PREFIX: Record<'es' | 'en', string> = {
  es:
    '[Modo voz] Responde hablado: 1 a 3 frases cortas en español, sin código, sin listas ni markdown; ' +
    'si la respuesta necesita código o es larga, resume en voz y pregunta si quiero verla en pantalla. Mensaje: ',
  en:
    '[Voice mode] Answer for speech: 1 to 3 short sentences in English, no code, no lists or markdown; ' +
    'if the answer needs code or is long, summarize it aloud and ask whether I want to see it on screen. Message: '
}

export function voiceLangOf(lang: string | undefined): 'es' | 'en' {
  return (lang ?? '').trim().toLowerCase().split(/[-_]/)[0] === 'es' ? 'es' : 'en'
}

/** The text handed to `pty.sendText`: the instruction + the utterance, or the utterance alone. */
export function voicePrompt(text: string, lang: string | undefined, prefixEnabled: boolean): string {
  const t = text.trim()
  if (!prefixEnabled || !t) return t
  return PREFIX[voiceLangOf(lang)] + t
}
