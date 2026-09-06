/**
 * The live wiring of voice conversation: ONE controller at a time (toggling it on another node moves
 * the conversation there), built from the session api, `PcmCapture`, the agent-status store, the
 * settings and `window.speechSynthesis`. The state machine itself is `voice-conversation.ts`;
 * this file only supplies its deps and publishes its state to `state/voiceConversation.ts`.
 *
 * Also owns the dev-instance test seam `window.__ohlabVoiceTest` (fake microphone, PCM/WAV
 * injection, the record of every utterance handed to the synthesizer), installed only for a
 * `NT_MULTI` dev instance or a vite dev build — see `installVoiceTestSeam`.
 */
import type { ClaudeAccount, NodeTerminalApi, ObservedClaudeAccount } from '@shared/types'
import { canVoiceConverse, createdAgentId } from '@shared/agents/config'
import { hasSpeechModel, type LastReply, type LastReplyQuery } from '@shared/speech'
import { decodeWavPcm16 } from '@shared/wav'
import { effectiveAccountId } from '../lib/accountChip'
import { agentEnvReady, agentEnvSnapshot, refreshAgentEnv } from '../lib/agentEnv'
import { readsClaudeTranscript } from '../lib/transcriptGates'
import { PcmCapture } from '../lib/pcm-capture'
import { agentStatusForApi } from '../state/agentStatus'
import { useSettings } from '../state/settings'
import { useVoiceConversation } from '../state/voiceConversation'
import { phrasesFor, speakable } from './speakable'
import { ChunkedSpeaker, pickReplyVoice, replyLanguage, SynthSpeaker, type ReplySpeaker, type SpokenRecord } from './tts'
import { voicePrompt } from './voice-prompt'
import { VoiceConversation, type VoiceCapture, type VoiceDeps, type VoicePhase, type VoiceState } from './voice-conversation'

/** Everything the loop needs to know about the node it talks to. `sessionId` is re-read from the
 *  agent-status store at reply time (it can appear after the toggle), `agentSessionId` is the id
 *  minted at node creation, the fallback for a node whose hooks have not spoken yet. */
export interface VoiceTarget {
  nodeId: string
  agentId: string
  title: string
  cwd?: string
  accountId?: string
  agentSessionId?: string
}

/**
 * The ONE decision "can this node hold a voice conversation, and as what": the header toggle, the
 * kanban card modal, the node menu and the registry command all ask here, so none of them can
 * disagree about the gate (`canVoiceConverse`) or about which account's transcript is read (the
 * OBSERVED claude account for claude-shaped readers, the node's own for everyone else — the same
 * split the ⌘M view makes). `null` = not an agent this feature can talk to.
 */
export function voiceTargetFor(
  nodeId: string,
  data: { agentId?: unknown; tags?: unknown; title?: unknown; cwd?: unknown; accountId?: unknown; agentSessionId?: unknown },
  observedAccount: ObservedClaudeAccount | undefined,
  claudeAccounts: readonly ClaudeAccount[]
): VoiceTarget | null {
  const agentId = createdAgentId(data)
  if (!agentId || !canVoiceConverse(agentId)) return null
  const dataAccount = typeof data.accountId === 'string' ? data.accountId : undefined
  return {
    nodeId,
    agentId,
    title: typeof data.title === 'string' && data.title ? data.title : 'Untitled',
    cwd: typeof data.cwd === 'string' ? data.cwd : undefined,
    accountId: readsClaudeTranscript(agentId)
      ? effectiveAccountId(dataAccount, observedAccount, claudeAccounts)
      : dataAccount,
    agentSessionId: typeof data.agentSessionId === 'string' ? data.agentSessionId : undefined
  }
}

interface Live {
  target: VoiceTarget
  controller: VoiceConversation
}

let live: Live | null = null
let fakeMic = false
const spoken: SpokenRecord[] = []

const MIC_DENIED =
  'Microphone access was not granted — allow it in System Settings (or your browser site settings) and try again.'

/** A microphone that never opens the device: the dev seam pushes PCM through `injectPcm` instead. */
class FakeCapture implements VoiceCapture {
  async start(): Promise<void> {}
  stop(): void {}
}

/** The mouth: sentence-chunked over the system synthesizer. `ReplySpeaker` is the seam an optional
 *  cloud TTS would replace — one line here, nothing in the state machine. */
function speaker(): ReplySpeaker {
  return new ChunkedSpeaker(
    new SynthSpeaker(window.speechSynthesis, undefined, undefined, undefined, (r) => {
      spoken.push(r)
      if (spoken.length > 50) spoken.shift()
    })
  )
}

function replyLang(): string {
  return replyLanguage(useSettings.getState().settings.speech.language, navigator.language)
}

function buildDeps(api: NodeTerminalApi, target: VoiceTarget): VoiceDeps {
  const status = agentStatusForApi(api).store
  const synth = speaker()
  const speakText = (text: string, onEnd: () => void): void => {
    const speech = useSettings.getState().settings.speech
    const lang = replyLang()
    const voice = pickReplyVoice(window.speechSynthesis.getVoices(), speech.replyVoice, lang)
    synth.speak(
      { text, voice, rate: speech.replyRate, lang },
      () => {
        useVoiceConversation.getState().setSpokenChunk(null)
        onEnd()
      },
      (chunk) => useVoiceConversation.getState().setSpokenChunk(chunk)
    )
  }
  return {
    createCapture: (onChunk, onEnded) =>
      fakeMic ? new FakeCapture() : new PcmCapture({ onChunk, onEnded, retain: false }),
    prepare: async (onProgress) => {
      const speech = useSettings.getState().settings.speech
      if (speech.engine === 'whisper') {
        if (!hasSpeechModel(speech.model)) {
          throw new Error('Dictation is off — choose a Whisper model in Settings → Speech.')
        }
        const selected = (await api.speech.models()).find((m) => m.id === speech.model)
        if (!selected?.downloaded) {
          const unsubscribe = api.speech.onProgress((p) => {
            if (p.id === speech.model) onProgress(p.pct)
          })
          try {
            onProgress(0)
            await api.speech.downloadModel(speech.model)
          } finally {
            unsubscribe()
          }
        }
      }
      if (!fakeMic && !(await api.speech.micConsent())) throw new Error(MIC_DENIED)
    },
    transcribe: async (pcm) => (await api.speech.transcribe(pcm)).text,
    // What the agent receives: the utterance wrapped in the "answer for speech" instruction when
    // the prefix is on (renderer/speech/voice-prompt.ts). The chip/overlay keep showing the bare
    // utterance as `heard`.
    submit: (text) => {
      const speech = useSettings.getState().settings.speech
      return api.pty.sendText(target.nodeId, voicePrompt(text, replyLang(), speech.voicePromptPrefix), { enter: true })
    },
    readReply: () => {
      const sessionId = status.getState().byId[target.nodeId]?.sessionId ?? target.agentSessionId
      if (!sessionId) return Promise.resolve(null)
      const query: LastReplyQuery = {
        agentId: target.agentId,
        sessionId,
        accountId: target.accountId,
        cwd: target.cwd
      }
      return api.speech.lastReply(query)
    },
    sanitize: (text) => speakable(text, { lang: replyLang() }),
    speak: speakText,
    speakPhrase: (phrase, onEnd) => speakText(phrasesFor(replyLang())[phrase], onEnd),
    cancelSpeech: () => synth.cancel(),
    subscribeAgent: (cb) => {
      let prev = status.getState().byId[target.nodeId]
      return status.subscribe((s) => {
        const next = s.byId[target.nodeId]
        if (next === prev) return
        const before = prev
        prev = next
        // The node's entry left the table (`remove()` — the node was closed), or its CLI was put to
        // sleep / paused: the conversation ends with it and the microphone is released.
        if ((!next && before) || next?.hibernated || next?.paused) {
          stopVoiceConversation(target.nodeId)
          return
        }
        if (!next) return
        // Same-state refreshes mutate in place and never reach here; a new object with the same
        // state and stamp is a non-state change (unread, session name) and not a transition.
        if (next.state === before?.state && next.stateAt === before?.stateAt) return
        if (next.state === 'working') cb.working()
        else if (next.state === 'blocked' || next.state === 'waiting') cb.attention()
        else if (next.state === 'done') cb.done(next.stateAt ?? Date.now())
      })
    },
    options: () => ({ minWords: 2, speakReplies: useSettings.getState().settings.speech.speakReplies }),
    onChange: (state: VoiceState, phase: VoicePhase) => {
      if (!state.active) {
        if (useVoiceConversation.getState().nodeId === target.nodeId) useVoiceConversation.getState().clear()
        return
      }
      useVoiceConversation.getState().set(target.nodeId, state, phase)
    }
  }
}

/** Is the live conversation on this node? */
export function voiceConversationNodeId(): string | null {
  return live?.target.nodeId ?? null
}

/** Start on `target`, moving the conversation off any other node first. */
export function startVoiceConversation(target: VoiceTarget, api: NodeTerminalApi): void {
  if (live && live.target.nodeId !== target.nodeId) stopVoiceConversation()
  if (live) {
    // Same node: a start while errored retries; otherwise it is already on.
    live.controller.start()
    return
  }
  const controller = new VoiceConversation(buildDeps(api, target))
  live = { target, controller }
  controller.start()
}

/** Stop everything and release the microphone. With a `nodeId`, only when it is that node's. */
export function stopVoiceConversation(nodeId?: string): void {
  if (!live) return
  if (nodeId && live.target.nodeId !== nodeId) return
  const cur = live
  live = null
  cur.controller.stop()
  // The controller's onChange cleared the store when it went inactive; belt and braces for a
  // teardown that raced a same-node restart.
  if (useVoiceConversation.getState().nodeId === cur.target.nodeId) useVoiceConversation.getState().clear()
}

/** The header/menu toggle: on → off for this node, otherwise (re)start here. */
export function toggleVoiceConversation(target: VoiceTarget, api: NodeTerminalApi): void {
  if (live?.target.nodeId === target.nodeId) stopVoiceConversation(target.nodeId)
  else startVoiceConversation(target, api)
}

/** The chip's Pause / Resume, for the node the conversation is on. */
export function toggleVoicePause(nodeId: string): void {
  if (live?.target.nodeId === nodeId) live.controller.togglePause()
}

// ---------------------------------------------------------------------------------------------
// Dev-instance test seam.

export interface VoiceTestSeam {
  /** Replace the microphone with a silent stand-in (before toggling on); consent is skipped too. */
  useFakeMic(on?: boolean): void
  /** Push 16 kHz mono PCM into the live conversation as if the microphone heard it. */
  injectPcm(pcm: Float32Array | ArrayBuffer | number[]): boolean
  /** Push a base64-encoded PCM16 WAV (a `say` + `afconvert` file) the same way. */
  injectWavBase64(b64: string): { samples: number; sampleRate: number } | null
  /** Every utterance handed to the synthesizer (text / voice / rate / lang / at), newest last. */
  spoken: SpokenRecord[]
  state(): (VoiceState & { phase: VoicePhase; nodeId: string }) | null
  speakable(markdown: string, lang?: string): string
  voices(): { name: string; lang: string; voiceURI: string; default: boolean }[]
  lastReply(query: LastReplyQuery, api?: NodeTerminalApi): Promise<LastReply | null>
}

declare global {
  interface Window {
    __ohlabVoiceTest?: VoiceTestSeam
  }
}

function toFloat32(input: Float32Array | ArrayBuffer | number[]): Float32Array {
  if (input instanceof Float32Array) return input
  if (Array.isArray(input)) return Float32Array.from(input)
  return new Float32Array(input)
}

/** Install `window.__ohlabVoiceTest` when this is a dev instance: a vite dev build, or an
 *  `NT_MULTI` sandbox (which main only honours when `!app.isPackaged`). Resolves to whether it did. */
export async function installVoiceTestSeam(api: NodeTerminalApi): Promise<boolean> {
  if (typeof window === 'undefined' || window.__ohlabVoiceTest) return !!window?.__ohlabVoiceTest
  let dev = import.meta.env.DEV
  if (!dev) {
    if (!agentEnvReady()) await refreshAgentEnv()
    dev = !!agentEnvSnapshot().NT_MULTI
  }
  if (!dev) return false
  window.__ohlabVoiceTest = {
    useFakeMic: (on = true) => {
      fakeMic = on
    },
    injectPcm: (input) => {
      if (!live) return false
      live.controller.injectPcm(toFloat32(input))
      return true
    },
    injectWavBase64: (b64) => {
      if (!live) return null
      const bin = atob(b64)
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      const wav = decodeWavPcm16(bytes)
      live.controller.injectPcm(wav.samples)
      return { samples: wav.samples.length, sampleRate: wav.sampleRate }
    },
    spoken,
    state: () => (live ? { ...live.controller.state, phase: live.controller.phase(), nodeId: live.target.nodeId } : null),
    speakable: (markdown, lang) => speakable(markdown, { lang: lang ?? replyLang() }),
    voices: () =>
      window.speechSynthesis
        .getVoices()
        .map((v) => ({ name: v.name, lang: v.lang, voiceURI: v.voiceURI, default: v.default })),
    lastReply: (query, viaApi = api) => viaApi.speech.lastReply(query)
  }
  return true
}
