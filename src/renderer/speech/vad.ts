/**
 * Energy-based voice-activity detector over 16 kHz mono PCM — the "ears" segmenter of voice
 * conversation (docs/VOICE.md). Pure: frames in, utterance boundaries out; no audio APIs, no
 * timers, so it runs under plain node in its tests against synthetic signals and a `say` WAV.
 *
 * How it decides:
 *  - Audio is cut into 20 ms frames and each frame's RMS is compared to a threshold.
 *  - The threshold ADAPTS: an exponential average of the RMS of frames judged silent is the noise
 *    floor, and speech must clear `floor * noiseRatio + noiseMargin` (never less than
 *    `minThreshold`, so a dead-quiet room does not turn breathing into speech).
 *  - Speech STARTS after `startFrames` consecutive frames above threshold (100 ms — quick, because
 *    barge-in while the app talks must cut the speech fast), and the emitted utterance carries
 *    `preRollMs` of audio from before that onset so the first syllable is not clipped.
 *  - Speech ENDS after `endFrames` consecutive frames below threshold (700 ms — a natural pause
 *    between sentences is shorter; the pause before a reply is longer). Only `tailKeepMs` of that
 *    silence is kept in the utterance.
 *  - An utterance whose speech part is under `minSpeechMs` (400 ms) is DROPPED — a cough, a
 *    chair. `maxUtteranceMs` cuts a monologue so whisper gets bounded audio.
 *  - SPEAKER GUARD: while the app is speaking, the threshold is multiplied and the onset needs
 *    more frames, so the reply coming out of laptop speakers does not re-trigger the listener.
 *    It is a mitigation, not echo cancellation — headphones are the real fix (docs/VOICE.md).
 */
export interface VadConfig {
  sampleRate: number
  frameMs: number
  startFrames: number
  endFrames: number
  minSpeechMs: number
  preRollMs: number
  tailKeepMs: number
  maxUtteranceMs: number
  minThreshold: number
  noiseRatio: number
  noiseMargin: number
  /** EMA coefficient applied to the noise floor per silent frame (0..1; higher = faster). */
  noiseAdapt: number
  /** Ceiling on the adaptive floor, so a burst of noise cannot deafen the detector for good. */
  noiseFloorMax: number
  speakerGuardRatio: number
  guardStartFrames: number
}

export const DEFAULT_VAD_CONFIG: VadConfig = {
  sampleRate: 16000,
  frameMs: 20,
  startFrames: 5,
  endFrames: 35,
  minSpeechMs: 400,
  preRollMs: 300,
  tailKeepMs: 200,
  maxUtteranceMs: 30_000,
  minThreshold: 0.01,
  noiseRatio: 2.5,
  noiseMargin: 0.005,
  noiseAdapt: 0.05,
  noiseFloorMax: 0.1,
  speakerGuardRatio: 3,
  guardStartFrames: 10
}

export type VadEvent =
  | { type: 'speech-start'; atMs: number }
  | {
      type: 'utterance'
      /** Pre-roll + speech + a short tail, ready for `speech:transcribe`. */
      pcm: Float32Array
      /** Duration of the part judged speech (onset to last loud frame). */
      speechMs: number
      startMs: number
      endMs: number
    }
  | { type: 'dropped'; reason: 'too-short'; speechMs: number }

/** RMS of a frame, clamped to [0, 1]. */
export function frameRms(frame: Float32Array): number {
  if (frame.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.min(1, Math.sqrt(sum / frame.length))
}

function concat(frames: Float32Array[]): Float32Array {
  let total = 0
  for (const f of frames) total += f.length
  const out = new Float32Array(total)
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}

export class EnergyVad {
  readonly config: VadConfig
  private readonly frameSize: number
  private readonly preRollFrames: number
  private readonly tailKeepFrames: number
  private readonly maxFrames: number

  private carry: Float32Array = new Float32Array(0)
  /** Recent frames while silent — becomes the utterance's pre-roll. */
  private ring: Float32Array[] = []
  private inSpeech = false
  private onsetRun = 0
  private silentRun = 0
  private utterance: Float32Array[] = []
  /** Frames from onset up to and including the last loud frame. */
  private speechFrames = 0
  private startFrameIndex = 0
  private frameIndex = 0
  private floor: number
  private lastRms = 0
  private guard = false

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config }
    const c = this.config
    this.frameSize = Math.round((c.sampleRate * c.frameMs) / 1000)
    this.preRollFrames = Math.round(c.preRollMs / c.frameMs)
    this.tailKeepFrames = Math.round(c.tailKeepMs / c.frameMs)
    this.maxFrames = Math.round(c.maxUtteranceMs / c.frameMs)
    this.floor = c.minThreshold
  }

  /** While the app speaks: raise the bar so the speakers do not trigger the listener. */
  setSpeakerGuard(on: boolean): void {
    this.guard = on
    // A guard change resets a half-formed onset — its frames were judged under the other bar.
    if (!this.inSpeech) this.onsetRun = 0
  }

  /** The bar a frame has to clear right now. */
  threshold(): number {
    const c = this.config
    const base = Math.max(c.minThreshold, this.floor * c.noiseRatio + c.noiseMargin)
    return this.guard ? base * c.speakerGuardRatio : base
  }

  noiseFloor(): number {
    return this.floor
  }

  /** RMS of the most recent frame (0..1), for a level meter. */
  level(): number {
    return this.lastRms
  }

  speaking(): boolean {
    return this.inSpeech
  }

  reset(): void {
    this.carry = new Float32Array(0)
    this.ring = []
    this.inSpeech = false
    this.onsetRun = 0
    this.silentRun = 0
    this.utterance = []
    this.speechFrames = 0
    this.frameIndex = 0
    this.floor = this.config.minThreshold
    this.lastRms = 0
  }

  /** Feed audio of any chunk size; returns the events the new frames completed. */
  push(chunk: Float32Array): VadEvent[] {
    const events: VadEvent[] = []
    let buf: Float32Array
    if (this.carry.length) {
      buf = new Float32Array(this.carry.length + chunk.length)
      buf.set(this.carry, 0)
      buf.set(chunk, this.carry.length)
    } else {
      buf = chunk
    }
    let at = 0
    while (at + this.frameSize <= buf.length) {
      this.frame(buf.subarray(at, at + this.frameSize), events)
      at += this.frameSize
    }
    this.carry = at < buf.length ? buf.slice(at) : new Float32Array(0)
    return events
  }

  /** End an in-progress utterance now (capture stopping): delivered if long enough. */
  flush(): VadEvent[] {
    const events: VadEvent[] = []
    if (this.inSpeech) this.finish(events, this.utterance.length)
    this.carry = new Float32Array(0)
    return events
  }

  private frame(frame: Float32Array, events: VadEvent[]): void {
    const c = this.config
    const rms = frameRms(frame)
    this.lastRms = rms
    const loud = rms > this.threshold()
    const idx = this.frameIndex++
    // The worklet hands us views over reused memory — own the bytes we keep.
    const kept = frame.slice()

    if (!this.inSpeech) {
      this.ring.push(kept)
      const cap = this.preRollFrames + Math.max(c.startFrames, c.guardStartFrames)
      if (this.ring.length > cap) this.ring.shift()
      if (loud) {
        this.onsetRun++
        const need = this.guard ? c.guardStartFrames : c.startFrames
        if (this.onsetRun >= need) {
          this.inSpeech = true
          this.silentRun = 0
          this.speechFrames = this.onsetRun
          this.startFrameIndex = idx - this.onsetRun + 1
          // Pre-roll + the onset frames, in order.
          const take = Math.min(this.ring.length, this.preRollFrames + this.onsetRun)
          this.utterance = this.ring.slice(this.ring.length - take)
          this.ring = []
          this.onsetRun = 0
          events.push({ type: 'speech-start', atMs: this.startFrameIndex * c.frameMs })
        }
      } else {
        this.onsetRun = 0
        // Adapt the floor on silence only; speech must not raise the bar against itself.
        this.floor = Math.min(c.noiseFloorMax, this.floor + c.noiseAdapt * (rms - this.floor))
      }
      return
    }

    this.utterance.push(kept)
    if (loud) {
      this.silentRun = 0
      this.speechFrames = this.utterance.length - this.preRollFramesInUtterance()
    } else {
      this.silentRun++
      if (this.silentRun >= c.endFrames) {
        // Keep only `tailKeepFrames` of the trailing silence.
        this.finish(events, this.utterance.length - (this.silentRun - this.tailKeepFrames))
        return
      }
    }
    if (this.utterance.length >= this.maxFrames) this.finish(events, this.utterance.length)
  }

  /** How many leading frames of the current utterance are pre-roll (silence before onset). */
  private preRollFramesInUtterance(): number {
    // The utterance started as ring.slice(-(preRoll + onsetRun)); whatever exceeded the onset run
    // is pre-roll. Recomputed from the start index so it stays exact after the ring was cleared.
    return Math.max(0, this.utterance.length - (this.frameIndex - this.startFrameIndex))
  }

  private finish(events: VadEvent[], keepFrames: number): void {
    const c = this.config
    const speechMs = this.speechFrames * c.frameMs
    const frames = this.utterance.slice(0, Math.max(1, keepFrames))
    const startMs = this.startFrameIndex * c.frameMs
    const endMs = (this.startFrameIndex + this.speechFrames) * c.frameMs
    this.inSpeech = false
    this.utterance = []
    this.silentRun = 0
    this.speechFrames = 0
    this.ring = []
    if (speechMs < c.minSpeechMs) {
      events.push({ type: 'dropped', reason: 'too-short', speechMs })
      return
    }
    events.push({ type: 'utterance', pcm: concat(frames), speechMs, startMs, endMs })
  }
}
