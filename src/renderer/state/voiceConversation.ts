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
  notice: VoiceNotice | null
  error: string | null
  downloadPct: number | null
  paused: boolean
  set(nodeId: string, state: VoiceState, phase: VoicePhase): void
  clear(): void
}

export const useVoiceConversation = create<VoiceConversationView>((set) => ({
  nodeId: null,
  phase: 'idle',
  heard: null,
  notice: null,
  error: null,
  downloadPct: null,
  paused: false,
  set: (nodeId, state, phase) =>
    set({
      nodeId,
      phase,
      heard: state.heard,
      notice: state.notice,
      error: state.error,
      downloadPct: state.downloadPct,
      paused: state.paused
    }),
  clear: () =>
    set({ nodeId: null, phase: 'idle', heard: null, notice: null, error: null, downloadPct: null, paused: false })
}))

/** Is the live voice conversation on THIS node? A primitive selector, so node headers do not
 *  re-render on every phase change of another node's conversation. */
export function useVoiceActiveOn(nodeId: string): boolean {
  return useVoiceConversation((s) => s.nodeId === nodeId)
}
