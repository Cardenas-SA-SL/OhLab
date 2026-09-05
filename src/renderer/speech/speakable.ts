/**
 * Turn an agent's markdown reply into something a speech synthesizer can read aloud — the text
 * handed to `SpeechSynthesisUtterance` by voice conversation (docs/VOICE.md). Pure.
 *
 * What is SPOKEN: prose, headings, list items, the text of links, inline code (a filename or a
 * command reads fine). What is REPLACED by a short phrase: fenced code blocks ("código omitido"),
 * URLs ("enlace"), tables ("tabla omitida"). What is DROPPED: markdown syntax, HTML tags, rules,
 * task-list boxes. A long reply is capped near `SPEAKABLE_MAX_CHARS` at a sentence boundary and
 * ends with "…y sigue en pantalla" — the screen has the rest.
 *
 * Phrases follow the reply LANGUAGE (`phrasesFor`), Spanish and English; an unknown language gets
 * English, because a Spanish placeholder inside a German reply is stranger than an English one.
 */
export interface SpeakablePhrases {
  codeOmitted: string
  link: string
  tableOmitted: string
  continues: string
  /** Spoken when the agent stops on a permission prompt / question instead of an answer. */
  needsYou: string
  /** Spoken (or shown) when the turn ended but no assistant prose could be read. */
  noReply: string
}

export const SPEAKABLE_PHRASES: Record<'es' | 'en', SpeakablePhrases> = {
  es: {
    codeOmitted: 'código omitido',
    link: 'enlace',
    tableOmitted: 'tabla omitida',
    continues: '…y sigue en pantalla',
    needsYou: 'El agente necesita tu respuesta en pantalla.',
    noReply: 'No encontré una respuesta para leer.'
  },
  en: {
    codeOmitted: 'code omitted',
    link: 'link',
    tableOmitted: 'table omitted',
    continues: '…and it continues on screen',
    needsYou: 'The agent needs your answer on screen.',
    noReply: 'I found no reply to read.'
  }
}

export const SPEAKABLE_MAX_CHARS = 1500

/** The phrase set for a BCP-47 tag or a whisper code ('es-CL', 'es', 'en-US', undefined). */
export function phrasesFor(lang: string | undefined): SpeakablePhrases {
  const base = (lang ?? '').trim().toLowerCase().split(/[-_]/)[0]
  return base === 'es' ? SPEAKABLE_PHRASES.es : SPEAKABLE_PHRASES.en
}

/** Does the text so far already carry a pause the synthesizer will honour? A colon before a list,
 *  a comma or a dash need no added period — inserting one there reads as a stutter. */
const PAUSES_ALREADY = /[.!?…:;,—–-]["')\]]?$/

/** Is this line part of a markdown table (a row or the `|---|` separator)? */
function isTableLine(line: string): boolean {
  const t = line.trim()
  return t.startsWith('|') || /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(t)
}

export function speakable(
  markdown: string,
  opts: { lang?: string; maxChars?: number } = {}
): string {
  const phrases = phrasesFor(opts.lang)
  const maxChars = opts.maxChars ?? SPEAKABLE_MAX_CHARS
  let text = markdown.replace(/\r\n?/g, '\n')

  // Fenced code first, so nothing inside a block is read as markdown.
  text = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, `\n${phrases.codeOmitted}.\n`)
  // An unterminated fence: everything after it is code.
  text = text.replace(/```[\s\S]*$/, `\n${phrases.codeOmitted}.\n`)

  // Tables: runs of table lines collapse to one phrase.
  const lines = text.split('\n')
  const folded: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i]) && i + 1 < lines.length && isTableLine(lines[i + 1])) {
      while (i + 1 < lines.length && isTableLine(lines[i + 1])) i++
      folded.push(`${phrases.tableOmitted}.`)
    } else {
      folded.push(lines[i])
    }
  }
  text = folded.join('\n')

  // Images and links keep their text; bare URLs become the phrase.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, phrases.link)
  // A URL never ends in sentence punctuation — that period belongs to the sentence, not the link.
  text = text.replace(/\bhttps?:\/\/[^\s)<>"'`]*[^\s)<>"'`.,;:!?]/g, phrases.link)
  text = text.replace(/\bwww\.[^\s)<>"'`]*[^\s)<>"'`.,;:!?]/g, phrases.link)
  // HTML tags (after the autolink form above, which is also angle-bracketed).
  text = text.replace(/<\/?[a-zA-Z][^<>]*>/g, '')

  const spoken: string[] = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line) {
      spoken.push('')
      continue
    }
    // Horizontal rules and setext underlines.
    if (/^([-*_=]\s*){3,}$/.test(line)) continue
    line = line.replace(/^#{1,6}\s+/, '') // heading
    line = line.replace(/^>\s?/, '') // blockquote
    line = line.replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '') // bullet (+ task box)
    line = line.replace(/^\s*(\d+)[.)]\s+/, '$1. ') // ordered list keeps its number
    line = line.replace(/`([^`]*)`/g, '$1') // inline code
    line = line.replace(/(\*\*|__)(.+?)\1/g, '$2') // bold
    line = line.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=$|[\s.,;:!?)])/g, '$1$2') // italics
    line = line.replace(/~~(.+?)~~/g, '$1') // strikethrough
    line = line.replace(/\s+/g, ' ').trim()
    if (line) spoken.push(line)
  }

  // Join: a blank line or a line without terminal punctuation gets a sentence break, so the
  // synthesizer pauses between list items instead of running them into one breath.
  let out = ''
  for (const line of spoken) {
    if (!line) {
      if (out && !PAUSES_ALREADY.test(out)) out += '.'
      continue
    }
    if (!out) out = line
    else if (PAUSES_ALREADY.test(out) || /^[.,;:!?]/.test(line)) out += ` ${line}`
    else out += `. ${line}`
  }
  out = out.replace(/\s+([.,;:!?])/g, '$1').replace(/([.!?…])\.(\s|$)/g, '$1$2').replace(/\s{2,}/g, ' ').trim()

  if (out.length > maxChars) {
    const head = out.slice(0, maxChars)
    let cut = -1
    for (const m of head.matchAll(/[.!?…]\s/g)) cut = m.index! + 1
    if (cut < maxChars * 0.6) cut = head.lastIndexOf(' ')
    if (cut <= 0) cut = maxChars
    out = `${head.slice(0, cut).trim()} ${phrases.continues}`
  }
  return out
}

/** The whitespace-separated word count of a transcription — the "at least two words" gate. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}
