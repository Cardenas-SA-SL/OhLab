import { create } from 'zustand'
import type { VoiceNotice, VoicePhase, VoiceState } from '../speech/voice-conversation'

/**
 * What the UI needs of the ONE live voice conversation: which node it is on and how it is doing.
 * Fed by the controller in `speech/voice-conversation-live.ts`; read by the node header chip, the
 * kanban card modal and the node context menu. "Only one node listens at a time" is this store's
 * shape — a single `nodeId`, not a map.
 */
export interface VoiceConversationView {
  nodeId: string | null
  phase: VoicePhase
  heard: string | null
  /** The reply being (or last) spoken, sanitized — the overlay's "what I said" line. */
  replyText: string | null
  /** The sentence the synthesizer is on right now (ChunkedSpeaker's onChunk). */
  spokenChunk: string | null
  notice: VoiceNotice | null
  error: string | null
  downloadPct: number | null
  paused: boolean
  /** "Show on screen": the voice overlay steps aside for the terminal; the header chip remains. */
  overlayHidden: boolean
  set(nodeId: string, state: VoiceState, phase: VoicePhase): void
  setSpokenChunk(text: string | null): void
  setOverlayHidden(hidden: boolean): void
  clear(): void
}

export const useVoiceConversation = create<VoiceConversationView>((set) => ({
  nodeId: null,
  phase: 'idle',
  heard: null,
  replyText: null,
  spokenChunk: null,
  notice: null,
  error: null,
  downloadPct: null,
  paused: false,
  overlayHidden: false,
  set: (nodeId, state, phase) =>
    set((prev) => ({
      // A conversation moving to another node starts with the overlay visible again.
      overlayHidden: prev.nodeId === nodeId ? prev.overlayHidden : false,
      nodeId,
      phase,
      heard: state.heard,
      replyText: state.replyText,
      spokenChunk: state.speaking ? prev.spokenChunk : null,
      notice: state.notice,
      error: state.error,
      downloadPct: state.downloadPct,
      paused: state.paused
    })),
  setSpokenChunk: (text) => set({ spokenChunk: text }),
  setOverlayHidden: (hidden) => set({ overlayHidden: hidden }),
  clear: () =>
    set({
      nodeId: null,
      phase: 'idle',
      heard: null,
      replyText: null,
      spokenChunk: null,
      notice: null,
      error: null,
      downloadPct: null,
      paused: false,
      overlayHidden: false
    })
}))

/** Is the live voice conversation on THIS node? A primitive selector, so node headers do not
 *  re-render on every phase change of another node's conversation. */
export function useVoiceActiveOn(nodeId: string): boolean {
  return useVoiceConversation((s) => s.nodeId === nodeId)
}
