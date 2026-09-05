import { describe, expect, it } from 'vitest'
import { decodeWavPcm16 } from './wav'

/** A canonical PCM16 WAVE writer for the tests (the production encoder lives in core, which this
 *  shared module must not import). `extraChunk` inserts a foreign chunk before `data`, the way
 *  afconvert's `FLLR` padding sits in the files the voice tests decode. */
function wav(samples: number[], channels = 1, sampleRate = 16000, extraChunk = 0): Uint8Array {
  const dataBytes = samples.length * 2
  const extra = extraChunk ? 8 + extraChunk : 0
  const out = new Uint8Array(44 + extra + dataBytes)
  const dv = new DataView(out.buffer)
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + extra + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true)
  dv.setUint16(20, 1, true)
  dv.setUint16(22, channels, true)
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2 * channels, true)
  dv.setUint16(32, 2 * channels, true)
  dv.setUint16(34, 16, true)
  let at = 36
  if (extraChunk) {
    ascii(at, 'FLLR')
    dv.setUint32(at + 4, extraChunk, true)
    at += 8 + extraChunk
  }
  ascii(at, 'data')
  dv.setUint32(at + 4, dataBytes, true)
  at += 8
  for (const s of samples) {
    dv.setInt16(at, s, true)
    at += 2
  }
  return out
}

describe('decodeWavPcm16', () => {
  it('decodes mono PCM16 into [-1, 1] floats with the header sample rate', () => {
    const d = decodeWavPcm16(wav([0, 16384, -16384, 32767, -32768]))
    expect(d.sampleRate).toBe(16000)
    expect(d.channels).toBe(1)
    expect(Array.from(d.samples).map((v) => Number(v.toFixed(4)))).toEqual([0, 0.5, -0.5, 1, -1])
  })

  it('skips foreign chunks before data (afconvert writes FLLR padding there)', () => {
    const d = decodeWavPcm16(wav([1000, -1000], 1, 16000, 30))
    expect(d.samples.length).toBe(2)
    expect(d.samples[0]).toBeGreaterThan(0)
    expect(d.samples[1]).toBeLessThan(0)
  })

  it('downmixes stereo by averaging', () => {
    const d = decodeWavPcm16(wav([32767, 0, 0, -32768], 2, 44100))
    expect(d.channels).toBe(2)
    expect(d.sampleRate).toBe(44100)
    expect(d.samples.length).toBe(2)
    expect(d.samples[0]).toBeCloseTo(0.5, 3)
    expect(d.samples[1]).toBeCloseTo(-0.5, 3)
  })

  it('refuses what is not PCM16 WAVE', () => {
    expect(() => decodeWavPcm16(new Uint8Array([1, 2, 3]))).toThrow(/RIFF/)
    const notPcm = wav([0])
    new DataView(notPcm.buffer).setUint16(34, 8, true) // 8-bit
    expect(() => decodeWavPcm16(notPcm)).toThrow(/Unsupported/)
  })
})
