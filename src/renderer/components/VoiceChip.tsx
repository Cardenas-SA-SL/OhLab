// The live state of a voice conversation, on the node that holds it (docs/VOICE.md): Listening /
// Hearing… / Transcribing… / Heard "…" · Thinking / Speaking / Paused, plus the model download and
// an error, with a Pause/Resume control. Rendered by the terminal node header (`variant="node"`,
// the `term-node__status` idiom beside RUNNING) and by the kanban card modal (`variant="badge"`,
// the board's badge idiom) — one component, so the two views of a session cannot disagree.
import { useVoiceConversation } from '../state/voiceConversation'
import { toggleVoicePause } from '../speech/voice-conversation-live'
import type { VoiceNotice, VoicePhase } from '../speech/voice-conversation'

const HEARD_MAX = 28

/** Pure: the chip's label for a phase. Exported for its tests. */
export function voiceChipLabel(phase: VoicePhase, heard: string | null, downloadPct: number | null): string {
  switch (phase) {
    case 'idle':
      return ''
    case 'starting':
      return 'Starting…'
    case 'downloading':
      return `Downloading model ${Math.round(downloadPct ?? 0)}%`
    case 'listening':
      return 'Listening'
    case 'hearing':
      return 'Hearing…'
    case 'transcribing':
      return 'Transcribing…'
    case 'thinking': {
      if (!heard) return 'Thinking'
      const short = heard.length > HEARD_MAX ? `${heard.slice(0, HEARD_MAX - 1).trimEnd()}…` : heard
      return `Heard “${short}” · Thinking`
    }
    case 'speaking':
      return 'Speaking'
    case 'paused':
      return 'Paused'
    case 'error':
      return 'Voice error'
  }
}

/** Pure: a transient notice as a sentence for the tooltip, or null. */
export function voiceNoticeText(notice: VoiceNotice | null): string | null {
  switch (notice) {
    case 'too-short':
      return 'Ignored: fewer than two words.'
    case 'no-reply':
      return 'The turn ended but no reply text could be read.'
    case 'not-delivered':
      return 'Could not deliver the text to the terminal.'
    case 'transcribe-failed':
      return 'Transcription failed.'
    case 'reply-timeout':
      return 'No turn end was reported for the last prompt.'
    default:
      return null
  }
}

/** Phases in which Pause/Resume makes sense (a download or a fatal error has nothing to pause). */
function pausable(phase: VoicePhase): boolean {
  return phase !== 'starting' && phase !== 'downloading' && phase !== 'error' && phase !== 'idle'
}

export function VoiceChip({ nodeId, variant = 'node' }: { nodeId: string; variant?: 'node' | 'badge' }) {
  const view = useVoiceConversation()
  if (view.nodeId !== nodeId || view.phase === 'idle') return null
  const label = voiceChipLabel(view.phase, view.heard, view.downloadPct)
  const tooltip = [
    view.error ?? `Voice conversation: ${label}`,
    view.heard && view.phase !== 'thinking' ? `Last heard: “${view.heard}”` : null,
    voiceNoticeText(view.notice)
  ]
    .filter(Boolean)
    .join('\n')
  const base = variant === 'node' ? 'term-node__status term-node__status--voice' : 'kanban-badge kanban-badge--voice'
  const phaseClass = variant === 'node' ? `term-node__status--voice-${view.phase}` : `kanban-badge--voice-${view.phase}`
  return (
    <span
      className={`${base} ${phaseClass} nodrag`}
      title={tooltip}
      data-voice-phase={view.phase}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {variant === 'node' && <span className="term-node__status-dot" />}
      {/* "Show on screen" hid the overlay: the label is the way back to it. */}
      <span
        className="term-node__status-label"
        role={view.overlayHidden ? 'button' : undefined}
        title={view.overlayHidden ? 'Back to voice mode' : undefined}
        onClick={view.overlayHidden ? (e) => { e.stopPropagation(); useVoiceConversation.getState().setOverlayHidden(false) } : undefined}
      >
        {label}
      </span>
      {pausable(view.phase) && (
        <button
          type="button"
          className="voice-chip__pause"
          aria-pressed={view.paused}
          title={view.paused ? 'Resume listening' : 'Pause: stop listening and speaking until resumed'}
          onClick={(e) => {
            e.stopPropagation()
            toggleVoicePause(nodeId)
          }}
        >
          {view.paused ? '▶' : '⏸'}
        </button>
      )}
    </span>
  )
}
