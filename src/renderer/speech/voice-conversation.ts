/**
 * Voice conversation with an agent node (docs/VOICE.md): the state machine that joins the ears
 * (PcmCapture → EnergyVad → `speech:transcribe`) to the mouth (`agent:status` done → `speech:last-reply`
 * → speakable → speechSynthesis).
 *
 *   idle → listening ⇄ hearing → transcribing → thinking → speaking → listening
 *            ↕ paused                                  ↖ barge-in cuts speaking back to hearing
 *
 * `reduce` is PURE: (state, event) → (state, effects). It knows nothing about audio, IPC, timers or
 * the DOM; the controller below runs the effects through injected deps, which is what makes the
 * transitions unit-testable with fakes and the live wiring (voice-conversation-live.ts) thin.
 *
 * The state holds FACTS (capturing, hearing, transcribing count, awaiting a reply, speaking, paused)
 * and the phase the chip shows is a PROJECTION of them (`phaseOf`). That is deliberate: the facts
 * overlap in real use — an agent's `done` lands while the next utterance is still transcribing, a
 * reply is being spoken while a fresh prompt is already on its way — and a single enum would have
 * to invent a state for every overlap. The projection ranks them for display instead.
 */
import type { LastReply } from '@shared/speech'
import { EnergyVad, type VadEvent } from './vad'
import { wordCount } from './speakable'

export type VoicePhase =
  | 'idle'
  | 'starting'
  | 'downloading'
  | 'listening'
  | 'hearing'
  | 'transcribing'
  | 'thinking'
  | 'speaking'
  | 'paused'
  | 'error'

/** Transient notices the chip can surface (as a tooltip / secondary line). Codes, not copy: the
 *  UI owns the wording and the language. */
export type VoiceNotice = 'too-short' | 'no-reply' | 'not-delivered' | 'transcribe-failed' | 'reply-timeout'

export interface VoiceState {
  active: boolean
  /** A start was requested and the capture is not ready yet. */
  starting: boolean
  /** Model download in progress (percent), else null. */
  downloadPct: number | null
  /** The microphone is open and the VAD is fed. */
  capturing: boolean
  paused: boolean
  /** The VAD has announced speech and not yet delivered the utterance. */
  hearing: boolean
  /** Utterances currently in `speech:transcribe` (FIFO on the service side). */
  transcribing: number
  /** A prompt was submitted and the agent has not reported `done` for it. */
  awaitingReply: boolean
  /** `done` arrived and the reply is being read from the transcript (still "Thinking" on screen). */
  reading: boolean
  submittedAt: number | null
  /** The needs-you phrase was spoken for the current submission (once per turn). */
  attentionSpoken: boolean
  speaking: boolean
  /** The last accepted transcription. */
  heard: string | null
  notice: VoiceNotice | null
  /** Fatal for this session (mic denied/lost, model missing); the toggle stays on so the chip can
   *  say why, and a resume/start retries. */
  error: string | null
}

export const INITIAL_VOICE_STATE: VoiceState = {
  active: false,
  starting: false,
  downloadPct: null,
  capturing: false,
  paused: false,
  hearing: false,
  transcribing: 0,
  awaitingReply: false,
  reading: false,
  submittedAt: null,
  attentionSpoken: false,
  speaking: false,
  heard: null,
  notice: null,
  error: null
}

export function phaseOf(s: VoiceState): VoicePhase {
  if (!s.active) return 'idle'
  if (s.error) return 'error'
  if (s.paused) return 'paused'
  if (s.downloadPct !== null) return 'downloading'
  if (s.starting) return 'starting'
  if (s.speaking) return 'speaking'
  if (s.hearing) return 'hearing'
  if (s.transcribing > 0) return 'transcribing'
  if (s.awaitingReply || s.reading) return 'thinking'
  return 'listening'
}

export type VoiceEvent =
  | { type: 'start' }
  | { type: 'download-progress'; pct: number }
  | { type: 'capture-ready' }
  | { type: 'capture-failed'; message: string }
  | { type: 'mic-lost' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'stop' }
  | { type: 'speech-start' }
  | { type: 'utterance'; pcm: Float32Array }
  | { type: 'dropped' }
  | { type: 'transcribed'; text: string }
  | { type: 'transcribe-failed' }
  | { type: 'submitted'; ok: boolean; at: number }
  | { type: 'agent-working' }
  /** The agent stopped on a permission prompt or a question (blocked / waiting). */
  | { type: 'agent-attention' }
  | { type: 'agent-done'; at: number }
  /** The reply, already made speakable (or null when nothing could be read). */
  | { type: 'reply'; text: string | null }
  | { type: 'reply-timeout'; submittedAt: number }
  | { type: 'speak-end' }

export type VoiceEffect =
  | { kind: 'start-capture' }
  | { kind: 'stop-capture' }
  | { kind: 'transcribe'; pcm: Float32Array }
  | { kind: 'submit'; text: string }
  | { kind: 'read-reply'; submittedAt: number }
  | { kind: 'speak'; text: string }
  | { kind: 'speak-phrase'; phrase: 'needsYou' }
  | { kind: 'cancel-speech' }
  | { kind: 'guard-vad'; on: boolean }
  | { kind: 'arm-reply-timeout'; submittedAt: number }

export interface ReduceOptions {
  /** Transcriptions with fewer words are ignored (the spec's "shorter than 2 words"). */
  minWords: number
  /** Settings → Speech → "Speak replies". Off = the loop still listens and submits. */
  speakReplies: boolean
}

export const DEFAULT_REDUCE_OPTIONS: ReduceOptions = { minWords: 2, speakReplies: true }

/** A `done` whose stamp predates the submission by more than this is a stale turn, not our reply. */
const STALE_DONE_SLACK_MS = 1_000

type Step = { state: VoiceState; effects: VoiceEffect[] }
const same = (state: VoiceState): Step => ({ state, effects: [] })

/** Cut the current speech (barge-in, pause, mic loss): the two effects always travel together. */
function silence(s: VoiceState, effects: VoiceEffect[]): VoiceState {
  if (!s.speaking) return s
  effects.push({ kind: 'cancel-speech' }, { kind: 'guard-vad', on: false })
  return { ...s, speaking: false }
}

export function reduce(s: VoiceState, e: VoiceEvent, opts: ReduceOptions = DEFAULT_REDUCE_OPTIONS): Step {
  switch (e.type) {
    case 'start': {
      if (s.active && !s.error) return same(s)
      return { state: { ...INITIAL_VOICE_STATE, active: true, starting: true }, effects: [{ kind: 'start-capture' }] }
    }
    case 'stop':
      return {
        state: INITIAL_VOICE_STATE,
        effects: s.speaking
          ? [{ kind: 'cancel-speech' }, { kind: 'guard-vad', on: false }, { kind: 'stop-capture' }]
          : [{ kind: 'stop-capture' }]
      }
    case 'download-progress':
      if (!s.active) return same(s)
      return same({ ...s, downloadPct: e.pct })
    case 'capture-ready':
      if (!s.active || s.paused) return same(s)
      return same({ ...s, starting: false, downloadPct: null, capturing: true, error: null })
    case 'capture-failed':
      if (!s.active) return same(s)
      return { state: { ...s, starting: false, downloadPct: null, capturing: false, error: e.message }, effects: [{ kind: 'stop-capture' }] }
    case 'mic-lost': {
      if (!s.active || !s.capturing) return same(s)
      const effects: VoiceEffect[] = []
      const next = silence(s, effects)
      effects.push({ kind: 'stop-capture' })
      return {
        state: { ...next, capturing: false, hearing: false, error: 'The microphone was lost — check the input device and resume.' },
        effects
      }
    }
    case 'pause': {
      if (!s.active || s.paused) return same(s)
      const effects: VoiceEffect[] = []
      const next = silence(s, effects)
      effects.push({ kind: 'stop-capture' })
      // On hold means on hold: a reply that lands while paused is on screen, not spoken.
      return {
        state: { ...next, paused: true, capturing: false, starting: false, hearing: false, awaitingReply: false, reading: false, submittedAt: null },
        effects
      }
    }
    case 'resume':
      if (!s.active || !s.paused) return same(s)
      return { state: { ...s, paused: false, starting: true, error: null }, effects: [{ kind: 'start-capture' }] }

    case 'speech-start': {
      if (!s.active || !s.capturing || s.paused) return same(s)
      const effects: VoiceEffect[] = []
      const next = silence(s, effects) // barge-in
      return { state: { ...next, hearing: true }, effects }
    }
    case 'dropped':
      if (!s.active) return same(s)
      return same({ ...s, hearing: false, notice: 'too-short' })
    case 'utterance':
      if (!s.active || s.paused) return same(s)
      return {
        state: { ...s, hearing: false, transcribing: s.transcribing + 1 },
        effects: [{ kind: 'transcribe', pcm: e.pcm }]
      }
    case 'transcribed': {
      const transcribing = Math.max(0, s.transcribing - 1)
      if (!s.active || s.paused) return same({ ...s, transcribing })
      const text = e.text.trim()
      if (wordCount(text) < opts.minWords) return same({ ...s, transcribing, notice: 'too-short' })
      return { state: { ...s, transcribing, heard: text, notice: null }, effects: [{ kind: 'submit', text }] }
    }
    case 'transcribe-failed':
      return same({ ...s, transcribing: Math.max(0, s.transcribing - 1), notice: s.active ? 'transcribe-failed' : s.notice })
    case 'submitted': {
      if (!s.active || s.paused) return same(s)
      if (!e.ok) return same({ ...s, notice: 'not-delivered' })
      return {
        state: { ...s, awaitingReply: true, submittedAt: e.at, attentionSpoken: false, notice: null },
        effects: [{ kind: 'arm-reply-timeout', submittedAt: e.at }]
      }
    }
    case 'agent-working':
      return same(s)
    case 'agent-attention': {
      if (!s.active || s.paused || !s.awaitingReply || s.attentionSpoken || !opts.speakReplies) return same(s)
      const effects: VoiceEffect[] = []
      const next = silence(s, effects)
      effects.push({ kind: 'guard-vad', on: true }, { kind: 'speak-phrase', phrase: 'needsYou' })
      // The turn is still ours: when the user answers on screen and the agent finishes, its `done`
      // still reads the reply. Only the phrase is once-per-turn.
      return { state: { ...next, speaking: true, attentionSpoken: true }, effects }
    }
    case 'agent-done': {
      if (!s.active || s.paused || !s.awaitingReply || s.submittedAt === null) return same(s)
      if (e.at + STALE_DONE_SLACK_MS < s.submittedAt) return same(s)
      return {
        state: { ...s, awaitingReply: false, reading: true },
        effects: [{ kind: 'read-reply', submittedAt: s.submittedAt }]
      }
    }
    case 'reply-timeout':
      if (!s.active || !s.awaitingReply || s.submittedAt !== e.submittedAt) return same(s)
      return same({ ...s, awaitingReply: false, notice: 'reply-timeout' })
    case 'reply': {
      if (!s.active || s.paused) return same(s)
      if (!e.text) return same({ ...s, reading: false, notice: 'no-reply' })
      if (!opts.speakReplies) return same({ ...s, reading: false })
      const effects: VoiceEffect[] = []
      const next = silence({ ...s, reading: false }, effects)
      effects.push({ kind: 'guard-vad', on: true }, { kind: 'speak', text: e.text })
      return { state: { ...next, speaking: true }, effects }
    }
    case 'speak-end':
      if (!s.speaking) return same(s)
      return { state: { ...s, speaking: false }, effects: [{ kind: 'guard-vad', on: false }] }
  }
}

// ---------------------------------------------------------------------------------------------
// Controller: runs the effects through injected deps.

/** A capture the controller can open and close; the live one is `PcmCapture`, tests use a fake. */
export interface VoiceCapture {
  start(): Promise<void>
  stop(): void
}

export interface VoiceDeps {
  /** Open the microphone; `onChunk` receives 16 kHz mono PCM, `onEnded` fires if the track dies. */
  createCapture(onChunk: (pcm: Float32Array) => void, onEnded: () => void): VoiceCapture
  /** Everything that must be true before the mic opens: the whisper model is on disk (download it,
   *  reporting progress) and the microphone is consented. Throws with a user-facing message. */
  prepare(onProgress: (pct: number) => void): Promise<void>
  transcribe(pcm: Float32Array): Promise<string>
  /** Deliver a prompt into the node's composer AND submit it (`pty.sendText(…, { enter: true })`). */
  submit(text: string): Promise<boolean>
  /** The node's last assistant message, raw (`speech:last-reply`). */
  readReply(): Promise<LastReply | null>
  /** Markdown → speech text in the reply language (`speakable`). */
  sanitize(text: string): string
  speak(text: string, onEnd: () => void): void
  speakPhrase(phrase: 'needsYou', onEnd: () => void): void
  cancelSpeech(): void
  /** The node's agent-status transitions. Returns the unsubscribe. */
  subscribeAgent(cb: { working(): void; attention(): void; done(at: number): void }): () => void
  options(): ReduceOptions
  onChange(state: VoiceState, phase: VoicePhase): void
  now?(): number
  sleep?(ms: number): Promise<void>
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(handle: unknown): void
  vad?: EnergyVad
}

/** How long to wait for the agent's `done` before giving up on a reply (hooks not installed, a
 *  CLI that never reports). Long: real turns run for minutes. */
export const REPLY_TIMEOUT_MS = 10 * 60_000
/** The transcript can lag the `done` hook by a beat; re-read a few times before saying "no reply". */
const REPLY_READ_ATTEMPTS = 4
const REPLY_READ_DELAY_MS = 350
/** A reply stamped this much before the submission is the PREVIOUS turn's, still on disk. */
const REPLY_STALE_SLACK_MS = 2_000

export class VoiceConversation {
  state: VoiceState = INITIAL_VOICE_STATE
  private capture: VoiceCapture | null = null
  private unsubAgent: (() => void) | null = null
  private readonly vad: EnergyVad
  /** Bumped by stop/pause so a capture that finishes opening afterwards is closed, not adopted. */
  private generation = 0
  private replyTimer: unknown = null

  constructor(private readonly deps: VoiceDeps) {
    this.vad = deps.vad ?? new EnergyVad()
  }

  phase(): VoicePhase {
    return phaseOf(this.state)
  }

  start(): void {
    this.dispatch({ type: 'start' })
  }
  stop(): void {
    this.dispatch({ type: 'stop' })
  }
  pause(): void {
    this.dispatch({ type: 'pause' })
  }
  resume(): void {
    this.dispatch({ type: 'resume' })
  }
  togglePause(): void {
    if (this.state.paused) this.resume()
    else this.pause()
  }

  /** Feed audio as if it came from the microphone (the live capture's onChunk, or a test seam). */
  injectPcm(pcm: Float32Array): void {
    if (!this.state.capturing) return
    for (const ev of this.vad.push(pcm)) this.onVad(ev)
  }

  dispatch(event: VoiceEvent): void {
    const { state, effects } = reduce(this.state, event, this.deps.options())
    const prevActive = this.state.active
    this.state = state
    if (prevActive && !state.active) this.teardownSubscriptions()
    if (!prevActive && state.active) this.ensureSubscriptions()
    this.deps.onChange(state, phaseOf(state))
    for (const effect of effects) this.run(effect)
  }

  private onVad(ev: VadEvent): void {
    if (ev.type === 'speech-start') this.dispatch({ type: 'speech-start' })
    else if (ev.type === 'utterance') this.dispatch({ type: 'utterance', pcm: ev.pcm })
    else this.dispatch({ type: 'dropped' })
  }

  private ensureSubscriptions(): void {
    if (this.unsubAgent) return
    this.unsubAgent = this.deps.subscribeAgent({
      working: () => this.dispatch({ type: 'agent-working' }),
      attention: () => this.dispatch({ type: 'agent-attention' }),
      done: (at) => this.dispatch({ type: 'agent-done', at })
    })
  }

  private teardownSubscriptions(): void {
    this.unsubAgent?.()
    this.unsubAgent = null
    this.clearReplyTimer()
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== null) {
      ;(this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.replyTimer)
      this.replyTimer = null
    }
  }

  private run(effect: VoiceEffect): void {
    switch (effect.kind) {
      case 'start-capture':
        void this.openCapture()
        return
      case 'stop-capture':
        this.generation++
        this.capture?.stop()
        this.capture = null
        this.vad.reset()
        this.vad.setSpeakerGuard(false)
        return
      case 'transcribe': {
        const gen = this.generation
        this.deps.transcribe(effect.pcm).then(
          (text) => {
            if (gen === this.generation) this.dispatch({ type: 'transcribed', text })
            else this.dispatch({ type: 'transcribe-failed' })
          },
          () => this.dispatch({ type: 'transcribe-failed' })
        )
        return
      }
      case 'submit': {
        const gen = this.generation
        this.deps.submit(effect.text).then(
          (ok) => {
            if (gen === this.generation) this.dispatch({ type: 'submitted', ok, at: this.now() })
          },
          () => {
            if (gen === this.generation) this.dispatch({ type: 'submitted', ok: false, at: this.now() })
          }
        )
        return
      }
      case 'arm-reply-timeout': {
        this.clearReplyTimer()
        const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
        this.replyTimer = setTimer(() => {
          this.replyTimer = null
          this.dispatch({ type: 'reply-timeout', submittedAt: effect.submittedAt })
        }, REPLY_TIMEOUT_MS)
        return
      }
      case 'read-reply':
        this.clearReplyTimer()
        void this.readReply(effect.submittedAt)
        return
      case 'speak':
        this.deps.speak(effect.text, () => this.dispatch({ type: 'speak-end' }))
        return
      case 'speak-phrase':
        this.deps.speakPhrase(effect.phrase, () => this.dispatch({ type: 'speak-end' }))
        return
      case 'cancel-speech':
        this.deps.cancelSpeech()
        return
      case 'guard-vad':
        this.vad.setSpeakerGuard(effect.on)
        return
    }
  }

  private async openCapture(): Promise<void> {
    const gen = ++this.generation
    try {
      await this.deps.prepare((pct) => {
        if (gen === this.generation) this.dispatch({ type: 'download-progress', pct })
      })
      if (gen !== this.generation) return
      const capture = this.deps.createCapture(
        (pcm) => {
          if (this.capture === capture) this.injectPcm(pcm)
        },
        () => {
          if (this.capture === capture) this.dispatch({ type: 'mic-lost' })
        }
      )
      await capture.start()
      if (gen !== this.generation) {
        // Stopped/paused while the mic was opening: never leave a live track behind.
        capture.stop()
        return
      }
      this.capture = capture
      this.dispatch({ type: 'capture-ready' })
    } catch (err) {
      if (gen !== this.generation) return
      this.dispatch({ type: 'capture-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  private async readReply(submittedAt: number): Promise<void> {
    const gen = this.generation
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let reply: LastReply | null = null
    for (let attempt = 0; attempt < REPLY_READ_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(REPLY_READ_DELAY_MS)
      if (gen !== this.generation) return
      try {
        reply = await this.deps.readReply()
      } catch {
        reply = null
      }
      // Fresh enough (or undated) — the transcript may lag the hook by a beat, hence the retries.
      if (reply && (reply.at === null || reply.at >= submittedAt - REPLY_STALE_SLACK_MS)) break
      reply = null
    }
    if (gen !== this.generation) return
    const text = reply ? this.deps.sanitize(reply.text) : ''
    this.dispatch({ type: 'reply', text: text || null })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}
