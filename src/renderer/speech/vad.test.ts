import { describe, expect, it } from 'vitest'
import { DEFAULT_VAD_CONFIG, EnergyVad, frameRms, type VadEvent } from './vad'
import { SPOKEN_TEXT, spokenWav, spokenWavAvailable } from '@shared/__fixtures__/spoken-wav'

const RATE = 16000
const ms = (n: number): number => Math.round((RATE * n) / 1000)

function silence(durationMs: number, noise = 0): Float32Array {
  const out = new Float32Array(ms(durationMs))
  if (noise > 0) {
    // Deterministic pseudo-noise (no Math.random in a test): a fixed LCG.
    let seed = 12345
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      out[i] = ((seed / 0x7fffffff) * 2 - 1) * noise
    }
  }
  return out
}

function tone(durationMs: number, amplitude: number, hz = 220): Float32Array {
  const out = new Float32Array(ms(durationMs))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)
  return out
}

function join(...parts: Float32Array[]): Float32Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Float32Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Feed a signal in `chunk`-sample pieces (the worklet's 128 by default) and collect events. */
function run(vad: EnergyVad, signal: Float32Array, chunk = 128): VadEvent[] {
  const events: VadEvent[] = []
  for (let at = 0; at < signal.length; at += chunk) {
    events.push(...vad.push(signal.subarray(at, Math.min(signal.length, at + chunk))))
  }
  return events
}

const utterances = (events: VadEvent[]) =>
  events.filter((e): e is Extract<VadEvent, { type: 'utterance' }> => e.type === 'utterance')

describe('EnergyVad', () => {
  it('frameRms: a sine of amplitude A reads A/sqrt(2)', () => {
    expect(frameRms(tone(100, 0.3))).toBeCloseTo(0.3 / Math.SQRT2, 3)
    expect(frameRms(new Float32Array(0))).toBe(0)
  })

  it('emits nothing on silence, with or without a quiet noise floor', () => {
    expect(run(new EnergyVad(), silence(3000))).toEqual([])
    expect(run(new EnergyVad(), silence(3000, 0.004))).toEqual([])
  })

  it('segments one tone burst into exactly one utterance with sane boundaries', () => {
    const events = run(new EnergyVad(), join(silence(500), tone(1000, 0.3), silence(1500)))
    expect(events.map((e) => e.type)).toEqual(['speech-start', 'utterance'])
    const start = events[0] as Extract<VadEvent, { type: 'speech-start' }>
    // Onset is announced once `startFrames` (100 ms) of speech have been seen, stamped at the
    // FIRST loud frame — so it lands on the 500 ms edge, not 100 ms after it.
    expect(start.atMs).toBeGreaterThanOrEqual(480)
    expect(start.atMs).toBeLessThanOrEqual(540)
    const [u] = utterances(events)
    expect(u.speechMs).toBeGreaterThanOrEqual(940)
    expect(u.speechMs).toBeLessThanOrEqual(1060)
    expect(u.startMs).toBe(start.atMs)
    expect(u.endMs - u.startMs).toBe(u.speechMs)
    // pre-roll (300) + speech (1000) + kept tail (200) = 1500 ms of audio, give or take a frame.
    expect(u.pcm.length).toBeGreaterThanOrEqual(ms(1440))
    expect(u.pcm.length).toBeLessThanOrEqual(ms(1560))
    // The pre-roll really is the audio BEFORE the burst (silence), so the first syllable survives.
    expect(frameRms(u.pcm.subarray(0, ms(200)))).toBeLessThan(0.001)
    expect(frameRms(u.pcm.subarray(ms(400), ms(600)))).toBeGreaterThan(0.2)
  })

  it('drops a blip shorter than minSpeechMs (a cough, a chair) after announcing its onset', () => {
    const events = run(new EnergyVad(), join(silence(500), tone(200, 0.3), silence(1500)))
    expect(events.map((e) => e.type)).toEqual(['speech-start', 'dropped'])
    expect((events[1] as Extract<VadEvent, { type: 'dropped' }>).speechMs).toBeLessThan(
      DEFAULT_VAD_CONFIG.minSpeechMs
    )
  })

  it('does not end an utterance on a pause shorter than endFrames, and does on a longer one', () => {
    // Two words 400 ms apart are ONE utterance; two sentences 1.2 s apart are TWO.
    const one = run(new EnergyVad(), join(silence(400), tone(600, 0.3), silence(400), tone(600, 0.3), silence(1500)))
    expect(utterances(one)).toHaveLength(1)
    expect(utterances(one)[0].speechMs).toBeGreaterThanOrEqual(1500)
    const two = run(new EnergyVad(), join(silence(400), tone(600, 0.3), silence(1200), tone(600, 0.3), silence(1500)))
    expect(utterances(two)).toHaveLength(2)
  })

  it('tracks a drifting noise floor without firing, and still hears speech over it', () => {
    // Noise that creeps from 0.002 to 0.03 amplitude over 4 s: never speech on its own.
    const drift = new Float32Array(ms(4000))
    let seed = 7
    for (let i = 0; i < drift.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const amp = 0.002 + (0.028 * i) / drift.length
      drift[i] = ((seed / 0x7fffffff) * 2 - 1) * amp
    }
    const vad = new EnergyVad()
    expect(run(vad, drift)).toEqual([])
    expect(vad.noiseFloor()).toBeGreaterThan(0.01)
    // A real voice over that floor is still one clean utterance.
    const events = run(vad, join(tone(1000, 0.3), silence(1500, 0.03)))
    expect(utterances(events)).toHaveLength(1)
  })

  it('with the speaker guard on, speaker-level echo is ignored but a loud barge-in is heard', () => {
    // Echo at 0.06 amplitude (rms 0.042): over the quiet-room bar (0.03), under the guarded one (0.09).
    const echo = join(silence(300), tone(1000, 0.06), silence(1500))
    expect(utterances(run(new EnergyVad(), echo))).toHaveLength(1)
    const guarded = new EnergyVad()
    guarded.setSpeakerGuard(true)
    expect(run(guarded, echo)).toEqual([])
    // The user talking over the app (0.3) still cuts through the guard.
    const barge = new EnergyVad()
    barge.setSpeakerGuard(true)
    const events = run(barge, join(silence(300), tone(1000, 0.3), silence(1500)))
    expect(events[0]?.type).toBe('speech-start')
    expect(utterances(events)).toHaveLength(1)
  })

  it('is independent of the chunk size it is fed', () => {
    const signal = join(silence(500), tone(900, 0.3), silence(1500))
    const small = run(new EnergyVad(), signal, 128)
    const big = run(new EnergyVad(), signal, signal.length)
    const odd = run(new EnergyVad(), signal, 333)
    const shape = (es: VadEvent[]) =>
      es.map((e) => (e.type === 'utterance' ? { ...e, pcm: e.pcm.length } : e))
    expect(shape(small)).toEqual(shape(big))
    expect(shape(small)).toEqual(shape(odd))
  })

  it('cuts a monologue at maxUtteranceMs and keeps listening', () => {
    const vad = new EnergyVad({ maxUtteranceMs: 3000 })
    const events = run(vad, join(silence(300), tone(5000, 0.3), silence(1500)))
    const us = utterances(events)
    expect(us).toHaveLength(2)
    expect(us[0].pcm.length).toBeLessThanOrEqual(ms(3000) + 1)
  })

  it('flush() delivers an in-progress utterance when the capture stops', () => {
    const vad = new EnergyVad()
    run(vad, join(silence(300), tone(800, 0.3)))
    expect(vad.speaking()).toBe(true)
    const events = vad.flush()
    expect(utterances(events)).toHaveLength(1)
    expect(vad.speaking()).toBe(false)
  })

  // The microphone stand-in: a Spanish sentence synthesized by macOS `say`, resampled to the
  // capture format by `afconvert`, through the very same detector.
  it.skipIf(!spokenWavAvailable())(
    `segments the spoken sentence "${SPOKEN_TEXT}" into exactly one utterance`,
    () => {
      const wav = spokenWav()
      expect(wav.sampleRate).toBe(16000)
      const events = run(new EnergyVad(), join(silence(300), wav.samples, silence(1500)))
      const us = utterances(events)
      expect(us, `events: ${events.map((e) => e.type).join(',')}`).toHaveLength(1)
      const [u] = us
      // A ~2-3 s sentence: the onset lands in the leading silence's neighbourhood, the speech part is
      // seconds long, and the delivered audio is at least as long as the speech it frames.
      expect(u.startMs).toBeLessThan(1000)
      expect(u.speechMs).toBeGreaterThan(1200)
      expect(u.speechMs).toBeLessThan(5000)
      expect(u.pcm.length).toBeGreaterThanOrEqual(ms(u.speechMs))
      expect(events.filter((e) => e.type === 'dropped')).toEqual([])
    }
  )
})
