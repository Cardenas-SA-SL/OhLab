// The persistent half of "answer for speech" (docs/VOICE.md, voice conversation). Agents answer
// like coders — long, code blocks, lists — and a speech synthesizer reading that is unusable, so
// voice conversation tags every spoken prompt (`[Modo voz]` / `[Voice mode]`,
// renderer/speech/voice-prompt.ts) and this block, merged once into each agent's GLOBAL
// instruction file, tells the agent what the tag means. The per-prompt prefix can therefore stay
// one sentence; the rules live here.
//
// Same mechanism as the context-link note: a marker-delimited block, idempotent, everything
// outside the markers preserved (`mergeMarkerBlock`). Codex → `<codexHome>/AGENTS.md`, gemini →
// `~/.gemini/GEMINI.md`, opencode → its config dir's `AGENTS.md`; claude → a SKILL.md under
// `~/.claude/skills/` (claude reads skills, not a global markdown file we own). Installed at boot
// by BOTH shells; every write is best-effort and logged, never fatal.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { opencodeConfigDir } from './agents/hooks/opencode'
import { systemCodexHome } from './codex-accounts-core'

export const VOICE_INSTR_START = '<!-- ohlab:voice-mode:start -->'
export const VOICE_INSTR_END = '<!-- ohlab:voice-mode:end -->'

/** Idempotently merge a marker-delimited block into a file's text; everything outside the
 *  markers is preserved, a stale copy between them is replaced. Pure. */
export function mergeMarkerBlock(existing: string, start: string, end: string, block: string): string {
  const full = `${start}\n${block.trim()}\n${end}`
  const s = existing.indexOf(start)
  const e = existing.indexOf(end)
  if (s >= 0 && e > s) return existing.slice(0, s) + full + existing.slice(e + end.length)
  const sep = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  return existing + sep + full + '\n'
}

export function mergeVoiceModeBlock(existing: string, block: string): string {
  return mergeMarkerBlock(existing, VOICE_INSTR_START, VOICE_INSTR_END, block)
}

/** The rules, bilingual by example: the tag names the language the answer must be in. */
export function buildVoiceModeInstructions(): string {
  return [
    '# Voice mode (OhLab voice conversation)',
    '',
    'When a user message starts with `[Modo voz]` or `[Voice mode]`, the person is TALKING to you',
    'and will HEAR your reply read aloud by a speech synthesizer. Answer for the ear:',
    '',
    '- 1 to 3 short sentences, in the language of the message (`[Modo voz]` = Spanish).',
    '- No code blocks, no lists, no tables, no headings, no markdown, no URLs.',
    '- If the answer needs code, a diff, a file listing or a long explanation: do the work, then',
    '  summarize the outcome in one or two spoken sentences and ASK whether the person wants to',
    '  see it on screen. Show the full version only after they say yes.',
    '- If you need a decision or a permission, ask ONE short question and stop.',
    '- Never repeat the tag or the instruction in your answer.',
    '',
    'A message without the tag was typed: answer as you normally would.'
  ].join('\n')
}

/** The Claude skill: same rules, in the shape claude discovers (`~/.claude/skills/<name>/SKILL.md`). */
export const VOICE_SKILL_DIR = 'ohlab-voice-mode'

export function buildVoiceModeSkill(): string {
  return [
    '---',
    `name: ${VOICE_SKILL_DIR}`,
    'description: Use whenever the user message begins with "[Modo voz]" or "[Voice mode]" — the person is speaking to you through OhLab voice conversation and will hear the reply read aloud. Answer in 1 to 3 short spoken sentences, no code, lists or markdown; summarize long answers aloud and ask before showing them on screen.',
    '---',
    '',
    buildVoiceModeInstructions()
  ].join('\n')
}

export interface VoiceModeInstructionTargets {
  /** Files that take the marker block. */
  markdown: string[]
  /** The claude SKILL.md path. */
  skill: string
}

export function voiceModeInstructionTargets(home = os.homedir()): VoiceModeInstructionTargets {
  return {
    markdown: [
      path.join(systemCodexHome(), 'AGENTS.md'),
      path.join(home, '.gemini', 'GEMINI.md'),
      path.join(opencodeConfigDir(), 'AGENTS.md')
    ],
    skill: path.join(home, '.claude', 'skills', VOICE_SKILL_DIR, 'SKILL.md')
  }
}

/** Merge the block into every target (creating files/dirs as needed). Best-effort per file. */
export function installVoiceModeInstructions(targets = voiceModeInstructionTargets()): void {
  const block = buildVoiceModeInstructions()
  for (const p of targets.markdown) {
    try {
      let existing = ''
      try {
        existing = fs.readFileSync(p, 'utf8')
      } catch {
        /* new file */
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, mergeVoiceModeBlock(existing, block), 'utf8')
    } catch (e) {
      console.warn('[voice-mode] instructions install failed', p, e)
    }
  }
  try {
    fs.mkdirSync(path.dirname(targets.skill), { recursive: true })
    const next = buildVoiceModeSkill()
    let cur = ''
    try {
      cur = fs.readFileSync(targets.skill, 'utf8')
    } catch {
      /* new */
    }
    if (cur !== next) fs.writeFileSync(targets.skill, next, 'utf8')
  } catch (e) {
    console.warn('[voice-mode] skill install failed', targets.skill, e)
  }
}
