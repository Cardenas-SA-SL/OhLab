// Hands-free voice mode (docs/VOICE.md): while a voice conversation is on, this layer covers the
// node's terminal (and the kanban card modal's pane) with an animated orb whose motion IS the state
// machine — Listening / Hearing / Transcribing / Thinking / Speaking / Paused — the live text of what
// was heard and what is being said (for peace of mind; nothing here has to be READ to use the
// feature), and three big controls: Pause, Stop, Show on screen. Escape ends the conversation.
//
// One component for both surfaces, so the canvas node and the board's card modal cannot disagree
// about what a voice conversation looks like.
import { useEffect } from 'react'
import { useVoiceConversation } from '../state/voiceConversation'
import { stopVoiceConversation, toggleVoicePause } from '../speech/voice-conversation-live'
import type { VoicePhase } from '../speech/voice-conversation'
import { voiceNoticeText } from './VoiceChip'

/** Pure: the overlay's status line per phase. Exported for its tests. */
export function voiceOverlayStatus(phase: VoicePhase, downloadPct: number | null): string {
  switch (phase) {
    case 'idle':
      return ''
    case 'starting':
      return 'Starting…'
    case 'downloading':
      return `Downloading the speech model… ${Math.round(downloadPct ?? 0)}%`
    case 'listening':
      return 'Listening — just talk'
    case 'hearing':
      return 'Hearing you…'
    case 'transcribing':
      return 'Transcribing…'
    case 'thinking':
      return 'Thinking…'
    case 'speaking':
      return 'Speaking'
    case 'paused':
      return 'Paused — resume to keep talking'
    case 'error':
      return 'Voice conversation stopped'
  }
}

export function VoiceOverlay({ nodeId }: { nodeId: string }) {
  const view = useVoiceConversation()
  const mine = view.nodeId === nodeId && view.phase !== 'idle'

  // Escape ends the conversation (the toggle does too). Capture phase, so the terminal under the
  // overlay never sees the key; only while this overlay is the visible one for its node.
  useEffect(() => {
    if (!mine) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      stopVoiceConversation(nodeId)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [mine, nodeId])

  if (!mine) return null
  const status = voiceOverlayStatus(view.phase, view.downloadPct)
  const said = view.spokenChunk ?? (view.phase === 'speaking' ? view.replyText : null)
  const notice = voiceNoticeText(view.notice)
  const pausable = view.phase !== 'starting' && view.phase !== 'downloading' && view.phase !== 'error'
  return (
    <div
      className={`voice-overlay voice-overlay--${view.phase} nodrag nowheel`}
      role="dialog"
      aria-label="Voice conversation"
      data-voice-phase={view.phase}
      onMouseDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <div className="voice-orb" aria-hidden="true">
        <span className="voice-orb__ring voice-orb__ring--outer" />
        <span className="voice-orb__ring" />
        <span className="voice-orb__core" />
      </div>
      <div className="voice-overlay__status">{status}</div>
      <div className="voice-overlay__text">
        {view.error ? <p className="voice-overlay__error">{view.error}</p> : null}
        {view.heard ? (
          <p className="voice-overlay__heard">
            <span className="voice-overlay__label">You</span>“{view.heard}”
          </p>
        ) : null}
        {said ? (
          <p className="voice-overlay__reply">
            <span className="voice-overlay__label">Agent</span>
            {said}
          </p>
        ) : view.replyText && view.phase !== 'thinking' ? (
          <p className="voice-overlay__reply voice-overlay__reply--past">
            <span className="voice-overlay__label">Agent</span>
            {view.replyText}
          </p>
        ) : null}
        {notice ? <p className="voice-overlay__notice">{notice}</p> : null}
      </div>
      <div className="voice-overlay__controls">
        {pausable ? (
          <button
            type="button"
            className="voice-overlay__btn"
            aria-pressed={view.paused}
            onClick={() => toggleVoicePause(nodeId)}
          >
            {view.paused ? 'Resume' : 'Pause'}
          </button>
        ) : null}
        <button type="button" className="voice-overlay__btn voice-overlay__btn--stop" onClick={() => stopVoiceConversation(nodeId)}>
          Stop
        </button>
        <button
          type="button"
          className="voice-overlay__btn voice-overlay__btn--ghost"
          onClick={() => useVoiceConversation.getState().setOverlayHidden(true)}
        >
          Show on screen
        </button>
      </div>
      <div className="voice-overlay__hint">Esc ends the conversation · headphones recommended</div>
    </div>
  )
}
