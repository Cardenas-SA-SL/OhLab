import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildVoiceModeInstructions,
  buildVoiceModeSkill,
  installVoiceModeInstructions,
  mergeVoiceModeBlock,
  VOICE_INSTR_END,
  VOICE_INSTR_START,
  voiceModeInstructionTargets
} from './voice-mode-instructions'

describe('voice-mode instructions', () => {
  it('says the four things the spoken prefix relies on', () => {
    const body = buildVoiceModeInstructions()
    expect(body).toContain('[Modo voz]')
    expect(body).toContain('[Voice mode]')
    expect(body).toMatch(/1 to 3 short sentences/)
    expect(body).toMatch(/No code blocks, no lists/)
    expect(body).toMatch(/ASK whether the person wants to\s+see it on screen/)
    expect(body).toMatch(/without the tag was typed/)
  })

  it('merges idempotently and preserves everything outside the markers', () => {
    const block = buildVoiceModeInstructions()
    const once = mergeVoiceModeBlock('# My rules\n\nBe nice.\n', block)
    expect(once.startsWith('# My rules\n\nBe nice.\n')).toBe(true)
    expect(once).toContain(VOICE_INSTR_START)
    expect(once).toContain(VOICE_INSTR_END)
    const twice = mergeVoiceModeBlock(once, block)
    expect(twice).toBe(once)
    const updated = mergeVoiceModeBlock(once, 'NEW BODY')
    expect(updated).toContain('NEW BODY')
    expect(updated).not.toContain('1 to 3 short sentences')
    expect(updated.split(VOICE_INSTR_START)).toHaveLength(2)
    // An empty file gets just the block.
    expect(mergeVoiceModeBlock('', block).startsWith(VOICE_INSTR_START)).toBe(true)
  })

  it('targets the codex, gemini and opencode instruction files and a claude skill', () => {
    const t = voiceModeInstructionTargets('/home/u')
    expect(t.markdown.some((p) => p.endsWith(path.join('.codex', 'AGENTS.md')) || /AGENTS\.md$/.test(p))).toBe(true)
    expect(t.markdown).toContain(path.join('/home/u', '.gemini', 'GEMINI.md'))
    expect(t.markdown.filter((p) => p.endsWith('AGENTS.md'))).toHaveLength(2)
    expect(t.skill).toBe(path.join('/home/u', '.claude', 'skills', 'ohlab-voice-mode', 'SKILL.md'))
    expect(buildVoiceModeSkill().startsWith('---\nname: ohlab-voice-mode\n')).toBe(true)
  })

  describe('installVoiceModeInstructions', () => {
    let dir: string
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it('creates missing files, keeps existing content, writes the skill once', () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'ohlab-voice-instr-'))
      const agents = path.join(dir, 'codex', 'AGENTS.md')
      const gemini = path.join(dir, 'gemini', 'GEMINI.md')
      writeFileSync(path.join(dir, 'existing.md'), '# Mine\n')
      const targets = { markdown: [agents, gemini, path.join(dir, 'existing.md')], skill: path.join(dir, 'skills', 'x', 'SKILL.md') }
      installVoiceModeInstructions(targets)
      installVoiceModeInstructions(targets)
      for (const p of targets.markdown) {
        const text = readFileSync(p, 'utf8')
        expect(text.split(VOICE_INSTR_START)).toHaveLength(2)
      }
      expect(readFileSync(path.join(dir, 'existing.md'), 'utf8').startsWith('# Mine\n')).toBe(true)
      expect(readFileSync(targets.skill, 'utf8')).toBe(buildVoiceModeSkill())
    })
  })
})
