import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REDUCE_OPTIONS,
  INITIAL_VOICE_STATE,
  phaseOf,
  reduce,
  VoiceConversation,
  type ReduceOptions,
  type VoiceDeps,
  type VoiceEffect,
  type VoiceEvent,
  type VoiceState
} from './voice-conversation'
import { EnergyVad } from './vad'

/** Run a script of events through the pure reducer; returns the final state and every effect. */
function play(
  events: VoiceEvent[],
  opts: ReduceOptions = DEFAULT_REDUCE_OPTIONS,
  from: VoiceState = INITIAL_VOICE_STATE
): { state: VoiceState; effects: VoiceEffect[]; phases: string[] } {
  let state = from
  const effects: VoiceEffect[] = []
  const phases: string[] = []
  for (const e of events) {
    const step = reduce(state, e, opts)
    state = step.state
    effects.push(...step.effects)
    phases.push(phaseOf(state))
  }
  return { state, effects, phases }
}

const pcm = new Float32Array(16000)
const kinds = (effects: VoiceEffect[]) => effects.map((e) => e.kind)

const LISTENING: VoiceEvent[] = [{ type: 'start' }, { type: 'capture-ready' }]
const ONE_TURN: VoiceEvent[] = [
  ...LISTENING,
  { type: 'speech-start' },
  { type: 'utterance', pcm },
  { type: 'transcribed', text: 'hola Codex, muéstrame los archivos' },
  { type: 'submitted', ok: true, at: 1000 }
]

describe('voice conversation reducer', () => {
  it('walks idle → starting → listening → hearing → transcribing → thinking → speaking → listening', () => {
    const { phases, effects } = play([
      ...ONE_TURN,
      { type: 'agent-working' },
      { type: 'agent-done', at: 5000 },
      { type: 'reply', text: 'Hay dos archivos.' },
      { type: 'speak-end' }
    ])
    expect(phases).toEqual([
      'starting',
      'listening',
      'hearing',
      'transcribing',
      'listening', // transcribed → the submit is in flight; nothing is awaited until it lands
      'thinking',
      'thinking',
      'thinking', // done → the reply is being read, still Thinking on screen
      'speaking',
      'listening'
    ])
    expect(kinds(effects)).toEqual([
      'start-capture',
      'transcribe',
      'submit',
      'arm-reply-timeout',
      'read-reply',
      'guard-vad',
      'speak',
      'guard-vad'
    ])
    const speak = effects.find((e) => e.kind === 'speak')
    expect(speak).toEqual({ kind: 'speak', text: 'Hay dos archivos.' })
    // The speaker guard is raised for the speech and dropped after it.
    expect(effects.filter((e) => e.kind === 'guard-vad')).toEqual([
      { kind: 'guard-vad', on: true },
      { kind: 'guard-vad', on: false }
    ])
  })

  it('shows Heard "…" while thinking (the last accepted transcription)', () => {
    const { state } = play(ONE_TURN)
    expect(state.heard).toBe('hola Codex, muéstrame los archivos')
    expect(phaseOf(state)).toBe('thinking')
  })

  it('ignores a transcription shorter than two words and an empty one', () => {
    for (const text of ['', '   ', 'hola', 'Codex.']) {
      const { state, effects } = play([...LISTENING, { type: 'utterance', pcm }, { type: 'transcribed', text }])
      expect(kinds(effects)).toEqual(['start-capture', 'transcribe'])
      expect(state.notice).toBe('too-short')
      expect(state.heard).toBeNull()
      expect(phaseOf(state)).toBe('listening')
    }
  })

  it('agent done while a second utterance is still transcribing: the reply is read AND the utterance still lands', () => {
    const { state, effects, phases } = play([
      ...ONE_TURN,
      { type: 'speech-start' },
      { type: 'utterance', pcm }, // transcribing = 1, awaitingReply still true
      { type: 'agent-done', at: 4000 },
      { type: 'reply', text: 'Primera respuesta.' },
      { type: 'transcribed', text: 'y ahora corre las pruebas' },
      { type: 'submitted', ok: true, at: 6000 }
    ])
    expect(kinds(effects).slice(4)).toEqual(['transcribe', 'read-reply', 'guard-vad', 'speak', 'submit', 'arm-reply-timeout'])
    // Speaking outranks transcribing for display; the second prompt is awaited once submitted.
    expect(phases.slice(-3)).toEqual(['speaking', 'speaking', 'speaking'])
    expect(state.speaking).toBe(true)
    expect(state.awaitingReply).toBe(true)
    expect(state.submittedAt).toBe(6000)
  })

  it('two quick utterances: both are transcribed and submitted, one done reads one reply', () => {
    const { effects } = play([
      ...LISTENING,
      { type: 'speech-start' },
      { type: 'utterance', pcm },
      { type: 'speech-start' },
      { type: 'utterance', pcm },
      { type: 'transcribed', text: 'primera frase corta' },
      { type: 'submitted', ok: true, at: 1000 },
      { type: 'transcribed', text: 'segunda frase corta' },
      { type: 'submitted', ok: true, at: 1500 },
      { type: 'agent-done', at: 9000 },
      { type: 'agent-done', at: 9500 } // a second done with nothing outstanding is ignored
    ])
    expect(effects.filter((e) => e.kind === 'transcribe')).toHaveLength(2)
    expect(effects.filter((e) => e.kind === 'submit').map((e) => (e as { text: string }).text)).toEqual([
      'primera frase corta',
      'segunda frase corta'
    ])
    expect(effects.filter((e) => e.kind === 'read-reply')).toEqual([{ kind: 'read-reply', submittedAt: 1500 }])
  })

  it('barge-in: speech while speaking cancels the TTS and drops the guard; the late speak-end is inert', () => {
    const speaking = play([...ONE_TURN, { type: 'agent-done', at: 5000 }, { type: 'reply', text: 'Largo.' }]).state
    expect(phaseOf(speaking)).toBe('speaking')
    const { state, effects } = play([{ type: 'speech-start' }, { type: 'speak-end' }], DEFAULT_REDUCE_OPTIONS, speaking)
    expect(kinds(effects)).toEqual(['cancel-speech', 'guard-vad'])
    expect(effects[1]).toEqual({ kind: 'guard-vad', on: false })
    expect(state.speaking).toBe(false)
    expect(phaseOf(state)).toBe('hearing')
  })

  it('node closed mid-speech: stop cancels the speech, releases the mic and resets to idle', () => {
    const speaking = play([...ONE_TURN, { type: 'agent-done', at: 5000 }, { type: 'reply', text: 'Largo.' }]).state
    const { state, effects } = play([{ type: 'stop' }], DEFAULT_REDUCE_OPTIONS, speaking)
    expect(kinds(effects)).toEqual(['cancel-speech', 'guard-vad', 'stop-capture'])
    expect(state).toEqual(INITIAL_VOICE_STATE)
    expect(phaseOf(state)).toBe('idle')
  })

  it('pause puts the whole loop on hold (mic released, speech cut, no pending reply); resume reopens the mic', () => {
    const thinking = play(ONE_TURN).state
    const paused = play([{ type: 'pause' }], DEFAULT_REDUCE_OPTIONS, thinking)
    expect(kinds(paused.effects)).toEqual(['stop-capture'])
    expect(phaseOf(paused.state)).toBe('paused')
    expect(paused.state.awaitingReply).toBe(false)
    // A done / reply arriving while paused changes nothing and speaks nothing.
    const held = play([{ type: 'agent-done', at: 3000 }, { type: 'reply', text: 'x y' }], DEFAULT_REDUCE_OPTIONS, paused.state)
    expect(held.effects).toEqual([])
    const resumed = play([{ type: 'resume' }, { type: 'capture-ready' }], DEFAULT_REDUCE_OPTIONS, paused.state)
    expect(kinds(resumed.effects)).toEqual(['start-capture'])
    expect(phaseOf(resumed.state)).toBe('listening')
    // Pausing while speaking also cuts the speech.
    const speaking = play([...ONE_TURN, { type: 'agent-done', at: 5000 }, { type: 'reply', text: 'Largo.' }]).state
    expect(kinds(play([{ type: 'pause' }], DEFAULT_REDUCE_OPTIONS, speaking).effects)).toEqual([
      'cancel-speech',
      'guard-vad',
      'stop-capture'
    ])
  })

  it('a stale done (stamped before the submission) is not our reply', () => {
    const { effects } = play([...ONE_TURN, { type: 'agent-done', at: 1000 - 5000 }])
    expect(effects.filter((e) => e.kind === 'read-reply')).toEqual([])
  })

  it('no reply text → a notice, nothing spoken; speakReplies off → the loop stays silent', () => {
    const noReply = play([...ONE_TURN, { type: 'agent-done', at: 5000 }, { type: 'reply', text: null }])
    expect(noReply.state.notice).toBe('no-reply')
    expect(noReply.effects.filter((e) => e.kind === 'speak')).toEqual([])
    expect(phaseOf(noReply.state)).toBe('listening')
    const quiet = play(
      [...ONE_TURN, { type: 'agent-done', at: 5000 }, { type: 'reply', text: 'Hay dos archivos.' }],
      { minWords: 2, speakReplies: false }
    )
    expect(quiet.effects.filter((e) => e.kind === 'speak')).toEqual([])
    expect(phaseOf(quiet.state)).toBe('listening')
  })

  it('a permission prompt / question speaks the needs-you phrase once per turn and keeps waiting', () => {
    const { state, effects } = play([
      ...ONE_TURN,
      { type: 'agent-attention' },
      { type: 'speak-end' },
      { type: 'agent-attention' },
      { type: 'agent-done', at: 9000 }
    ])
    expect(effects.filter((e) => e.kind === 'speak-phrase')).toEqual([{ kind: 'speak-phrase', phrase: 'needsYou' }])
    expect(effects.filter((e) => e.kind === 'read-reply')).toHaveLength(1)
    expect(state.awaitingReply).toBe(false)
  })

  it('the reply timeout releases a turn the agent never reported, but only the turn it was armed for', () => {
    const { state } = play([...ONE_TURN, { type: 'reply-timeout', submittedAt: 999 }])
    expect(state.awaitingReply).toBe(true)
    const timedOut = play([...ONE_TURN, { type: 'reply-timeout', submittedAt: 1000 }])
    expect(timedOut.state.awaitingReply).toBe(false)
    expect(timedOut.state.notice).toBe('reply-timeout')
  })

  it('mic loss and a failed capture are errors that keep the toggle on and release the mic', () => {
    const lost = play([...LISTENING, { type: 'mic-lost' }])
    expect(phaseOf(lost.state)).toBe('error')
    expect(kinds(lost.effects)).toEqual(['start-capture', 'stop-capture'])
    const failed = play([{ type: 'start' }, { type: 'capture-failed', message: 'Microphone access was denied' }])
    expect(phaseOf(failed.state)).toBe('error')
    expect(failed.state.error).toMatch(/denied/)
    // A start from the error state retries.
    expect(kinds(play([{ type: 'start' }], DEFAULT_REDUCE_OPTIONS, failed.state).effects)).toEqual(['start-capture'])
  })

  it('reports the model download as its own phase', () => {
    const { state } = play([{ type: 'start' }, { type: 'download-progress', pct: 42 }])
    expect(phaseOf(state)).toBe('downloading')
    expect(state.downloadPct).toBe(42)
    expect(phaseOf(play([{ type: 'capture-ready' }], DEFAULT_REDUCE_OPTIONS, state).state)).toBe('listening')
  })
})

// ---------------------------------------------------------------------------------------------

function tone(durationMs: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round((16000 * durationMs) / 1000))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / 16000)
  return out
}

/** Fake deps with hand-resolvable promises, so the test decides WHEN each async leg completes. */
function fakeDeps(overrides: Partial<VoiceDeps> = {}) {
  const captures: { started: boolean; stopped: boolean; onEnded: () => void }[] = []
  const submitted: string[] = []
  const spoken: string[] = []
  const phrases: string[] = []
  const phases: string[] = []
  let agent: { working(): void; attention(): void; done(at: number): void } | null = null
  let unsubscribed = 0
  const pending: { transcribe: ((t: string) => void)[]; submit: ((ok: boolean) => void)[] } = { transcribe: [], submit: [] }
  let replies: (import('@shared/speech').LastReply | null)[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const deps: VoiceDeps = {
    createCapture: (_onChunk, onEnded) => {
      const c = { started: false, stopped: false, onEnded }
      captures.push(c)
      return {
        start: async () => {
          c.started = true
        },
        stop: () => {
          c.stopped = true
        }
      }
    },
    prepare: async () => {},
    transcribe: () => new Promise<string>((resolve) => pending.transcribe.push(resolve)),
    submit: (text) => {
      submitted.push(text)
      return new Promise<boolean>((resolve) => pending.submit.push(resolve))
    },
    readReply: async () => replies.shift() ?? null,
    sanitize: (t) => `[s]${t}`,
    speak: (text) => {
      spoken.push(text)
    },
    speakPhrase: (phrase) => {
      phrases.push(phrase)
    },
    cancelSpeech: vi.fn(),
    subscribeAgent: (cb) => {
      agent = cb
      return () => {
        unsubscribed++
        agent = null
      }
    },
    options: () => DEFAULT_REDUCE_OPTIONS,
    onChange: (_s, phase) => {
      phases.push(phase)
    },
    now: () => 10_000,
    sleep: async () => {},
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length - 1
    },
    clearTimer: () => {},
    vad: new EnergyVad(),
    ...overrides
  }
  return {
    deps,
    captures,
    submitted,
    spoken,
    phrases,
    phases,
    pending,
    timers,
    agent: () => agent,
    unsubscribed: () => unsubscribed,
    setReplies: (r: typeof replies) => {
      replies = r
    }
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

describe('VoiceConversation controller', () => {
  it('runs a whole turn through fakes: mic → VAD → transcribe → submit → done → read → speak', async () => {
    const h = fakeDeps()
    const c = new VoiceConversation(h.deps)
    c.start()
    await flush()
    expect(c.phase()).toBe('listening')
    expect(h.captures[0].started).toBe(true)
    expect(h.agent()).not.toBeNull()

    // Someone talks for a second, then stops.
    c.injectPcm(new Float32Array(16000 * 0.3))
    c.injectPcm(tone(1000))
    expect(c.phase()).toBe('hearing')
    c.injectPcm(new Float32Array(16000 * 1.5))
    expect(c.phase()).toBe('transcribing')
    expect(h.pending.transcribe).toHaveLength(1)

    h.pending.transcribe[0]('hola Codex, muéstrame los archivos')
    await flush()
    expect(h.submitted).toEqual(['hola Codex, muéstrame los archivos'])
    h.pending.submit[0](true)
    await flush()
    expect(c.phase()).toBe('thinking')
    expect(c.state.heard).toBe('hola Codex, muéstrame los archivos')
    expect(h.timers.at(-1)?.ms).toBeGreaterThan(60_000) // the reply timeout is armed

    // The transcript lags the hook: first read is the PREVIOUS turn (stale), the retry is fresh.
    h.setReplies([{ text: 'old', at: 1000 }, { text: 'Hay **dos** archivos.', at: 12_000 }])
    h.agent()!.working()
    h.agent()!.done(12_000)
    await flush()
    await flush()
    expect(h.spoken).toEqual(['[s]Hay **dos** archivos.'])
    expect(c.phase()).toBe('speaking')
    // Guard up while speaking: 3x the quiet-room bar (which sits at its 0.01 floor after silence).
    expect(h.deps.vad!.threshold()).toBeCloseTo(0.03, 5)
  })

  it('injectPcm is ignored until the capture is ready, and a stop during startup never adopts the mic', async () => {
    let releaseStart: () => void = () => {}
    const h = fakeDeps({
      createCapture: (_c, onEnded) => {
        const cap = { started: false, stopped: false, onEnded }
        h.captures.push(cap)
        return {
          start: () =>
            new Promise<void>((resolve) => {
              releaseStart = () => {
                cap.started = true
                resolve()
              }
            }),
          stop: () => {
            cap.stopped = true
          }
        }
      }
    })
    const c = new VoiceConversation(h.deps)
    c.injectPcm(tone(1000)) // idle: nothing happens
    c.start()
    await flush()
    expect(c.phase()).toBe('starting')
    c.stop()
    releaseStart()
    await flush()
    expect(c.phase()).toBe('idle')
    // The late-opening capture was closed, not left listening with no conversation.
    expect(h.captures[0].stopped).toBe(true)
    expect(h.unsubscribed()).toBe(1)
  })

  it('a transcription that resolves after stop is dropped, not submitted', async () => {
    const h = fakeDeps()
    const c = new VoiceConversation(h.deps)
    c.start()
    await flush()
    c.injectPcm(tone(1000))
    c.injectPcm(new Float32Array(16000 * 1.5))
    expect(h.pending.transcribe).toHaveLength(1)
    c.stop()
    h.pending.transcribe[0]('texto que llega tarde')
    await flush()
    expect(h.submitted).toEqual([])
  })

  it('mic loss reported by the capture becomes the error phase and releases the capture', async () => {
    const h = fakeDeps()
    const c = new VoiceConversation(h.deps)
    c.start()
    await flush()
    h.captures[0].onEnded()
    expect(c.phase()).toBe('error')
    expect(h.captures[0].stopped).toBe(true)
    // Resume-by-start retries with a fresh capture.
    c.start()
    await flush()
    expect(c.phase()).toBe('listening')
    expect(h.captures).toHaveLength(2)
  })

  it('a failed prepare (model missing, mic denied) is the error phase with its message', async () => {
    const h = fakeDeps({
      prepare: async () => {
        throw new Error('Microphone access was not granted')
      }
    })
    const c = new VoiceConversation(h.deps)
    c.start()
    await flush()
    expect(c.phase()).toBe('error')
    expect(c.state.error).toMatch(/not granted/)
    expect(h.captures).toHaveLength(0)
  })

  it('barge-in cancels the synthesizer; pause/resume release and reopen the mic', async () => {
    const h = fakeDeps()
    const c = new VoiceConversation(h.deps)
    c.start()
    await flush()
    c.injectPcm(tone(1000))
    c.injectPcm(new Float32Array(16000 * 1.5))
    h.pending.transcribe[0]('hola Codex, muéstrame los archivos')
    await flush()
    h.pending.submit[0](true)
    await flush()
    h.setReplies([{ text: 'Respuesta larga.', at: null }])
    h.agent()!.done(11_000)
    await flush()
    await flush()
    expect(c.phase()).toBe('speaking')
    // The user talks over the reply: loud enough to pass the speaker guard.
    c.injectPcm(tone(300, 0.5))
    expect(h.deps.cancelSpeech).toHaveBeenCalledTimes(1)
    expect(c.phase()).toBe('hearing')
    c.pause()
    expect(c.phase()).toBe('paused')
    expect(h.captures[0].stopped).toBe(true)
    c.resume()
    await flush()
    expect(c.phase()).toBe('listening')
    expect(h.captures).toHaveLength(2)
  })
})
