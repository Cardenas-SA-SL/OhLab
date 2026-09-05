import { describe, expect, it } from 'vitest'
import { phrasesFor, speakable, SPEAKABLE_MAX_CHARS, SPEAKABLE_PHRASES, wordCount } from './speakable'

describe('speakable', () => {
  it('reads a Codex-style reply: inline code as words, the fence as a phrase, the URL as "enlace"', () => {
    const codex =
      'El proyecto tiene `package.json` y la carpeta `src`.\n\n```bash\nls\n```\n\nMás detalles en https://example.com/proyecto.'
    expect(speakable(codex, { lang: 'es' })).toBe(
      'El proyecto tiene package.json y la carpeta src. código omitido. Más detalles en enlace.'
    )
  })

  it('reads a Claude-style reply: headings, bullets, bold, a link and a table', () => {
    const claude = [
      '## Resumen',
      '',
      'Encontré **dos** problemas en `src/app.ts`:',
      '',
      '- El _import_ de `fs` no se usa',
      '- Falta el `await` en la línea 12 — ver [la doc](https://nodejs.org/api/fs.html)',
      '',
      '| Archivo | Líneas |',
      '|---|---|',
      '| app.ts | 120 |',
      '',
      '> Nota: nada se ejecutó.',
      '',
      '---',
      '1. Corregir el import',
      '2. Añadir el await'
    ].join('\n')
    expect(speakable(claude, { lang: 'es-CL' })).toBe(
      'Resumen. Encontré dos problemas en src/app.ts: El import de fs no se usa. Falta el await en la línea 12 — ver la doc. tabla omitida. Nota: nada se ejecutó. 1. Corregir el import. 2. Añadir el await'
    )
  })

  it('uses English phrases for a non-Spanish reply language', () => {
    expect(speakable('See <https://x.y/z>\n\n```js\n1\n```', { lang: 'en-US' })).toBe('See link. code omitted.')
    expect(phrasesFor('de')).toBe(SPEAKABLE_PHRASES.en)
    expect(phrasesFor('es_MX')).toBe(SPEAKABLE_PHRASES.es)
    expect(phrasesFor(undefined)).toBe(SPEAKABLE_PHRASES.en)
  })

  it('caps a long reply at a sentence boundary and says the screen has the rest', () => {
    const sentence = 'Esta es una frase de prueba con varias palabras dentro. '
    const long = sentence.repeat(60) // ~3300 chars
    const out = speakable(long, { lang: 'es' })
    expect(out.endsWith(' …y sigue en pantalla')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(SPEAKABLE_MAX_CHARS + ' …y sigue en pantalla'.length)
    // The cut is at a sentence end, never mid-word.
    const body = out.slice(0, -' …y sigue en pantalla'.length)
    expect(body.endsWith('dentro.')).toBe(true)
    expect(speakable(long, { lang: 'es', maxChars: 200 }).length).toBeLessThanOrEqual(200 + 22)
  })

  it('strips HTML, task boxes, strikethrough and images; keeps ordered-list numbers', () => {
    const md = '<details><summary>Plan</summary>\n- [x] ~~done~~ step\n- [ ] next ![shot](a.png)\n</details>'
    expect(speakable(md, { lang: 'en' })).toBe('Plan. done step. next shot.')
  })

  it('returns an empty string for nothing speakable and a bare phrase for code-only replies', () => {
    expect(speakable('', { lang: 'es' })).toBe('')
    expect(speakable('   \n\n', { lang: 'es' })).toBe('')
    expect(speakable('```\nnpm test\n```', { lang: 'es' })).toBe('código omitido.')
    // An unterminated fence swallows the rest — it IS code.
    expect(speakable('Listo:\n```ts\nconst a = 1', { lang: 'es' })).toBe('Listo: código omitido.')
  })

  it('leaves snake_case identifiers and arithmetic alone while stripping emphasis', () => {
    expect(speakable('Usa `max_tokens` y *no* `top_p`; 2*3 = 6', { lang: 'es' })).toBe(
      'Usa max_tokens y no top_p; 2*3 = 6'
    )
  })
})

describe('wordCount', () => {
  it('counts whitespace-separated words', () => {
    expect(wordCount('')).toBe(0)
    expect(wordCount('  hola  ')).toBe(1)
    expect(wordCount('hola Codex, muéstrame los archivos')).toBe(5)
  })
})
