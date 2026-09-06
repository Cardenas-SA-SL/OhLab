// End-to-end STT without a microphone: a Spanish sentence synthesized by macOS `say`, resampled
// to the capture format by `afconvert`, transcribed by the REAL SpeechService (smart-whisper) with
// a whisper model already on disk. This is the proof the voice-conversation "ears" work against
// actual speech, not only against the synthetic tones the VAD tests use.
//
// Skips — saying why — when it cannot run: off macOS / without the tools, or with no model file
// in any of the directories below (nothing here downloads 75 MB on a CI runner's behalf). Point
// `OHLAB_SPEECH_MODELS_DIR` at a directory holding `ggml-<model>.bin` to run it elsewhere.
import { existsSync, readdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { WHISPER_MODELS } from '../../shared/speech'
import { SPOKEN_TEXT, spokenWav, spokenWavAvailable } from '../../shared/__fixtures__/spoken-wav'
import { SpeechService } from './speech-service'
import { WhisperModelStore } from './whisper-models'

/** Where a dev machine keeps its models: the app's userData, then any dev-instance sandbox. */
function candidateDirs(): string[] {
  const dirs: string[] = []
  if (process.env.OHLAB_SPEECH_MODELS_DIR) dirs.push(process.env.OHLAB_SPEECH_MODELS_DIR)
  dirs.push(path.join(os.homedir(), 'Library', 'Application Support', 'ohlab', 'speech-models'))
  dirs.push(path.join(os.homedir(), '.config', 'ohlab', 'speech-models'))
  const scratch = '/private/tmp/claude-501/-Users-sebas/02c9165e-3044-414b-832f-3c5c8a8d9ef9/scratchpad'
  try {
    for (const d of readdirSync(scratch)) {
      if (d.startsWith('ud-')) dirs.push(path.join(scratch, d, 'speech-models'))
    }
  } catch {
    /* no scratchpad on this machine */
  }
  return dirs
}

/** The smallest model present in any candidate dir (fastest transcription), or null. */
function findModel(): { dir: string; id: string } | null {
  for (const dir of candidateDirs()) {
    for (const m of WHISPER_MODELS) {
      if (existsSync(path.join(dir, m.file))) return { dir, id: m.id }
    }
  }
  return null
}

const model = findModel()
const reason = !spokenWavAvailable()
  ? 'needs macOS `say` + `afconvert` to synthesize the spoken fixture'
  : !model
    ? 'no whisper model on disk (set OHLAB_SPEECH_MODELS_DIR to a dir holding ggml-tiny.bin)'
    : null

describe('SpeechService over real speech (say → afconvert → whisper)', () => {
  it.skipIf(reason !== null)(
    `transcribes "${SPOKEN_TEXT}" with the ${model?.id ?? '?'} model${reason ? ` [skipped: ${reason}]` : ''}`,
    async () => {
      const wav = spokenWav()
      expect(wav.sampleRate).toBe(16000)
      const store = new WhisperModelStore({ dir: model!.dir })
      const service = new SpeechService({ models: store })
      try {
        const text = await service.transcribe(wav.samples, { model: model!.id, language: 'es' })
        // Whisper's spelling of the rest varies by model size ("Codex" / "códex" / "codecs"), but
        // "hola" opens every transcription of this sentence.
        expect(text.toLowerCase()).toContain('hola')
        expect(text.toLowerCase()).toMatch(/archivos|proyecto/)
      } finally {
        await service.shutdown()
      }
    },
    120_000
  )
})
