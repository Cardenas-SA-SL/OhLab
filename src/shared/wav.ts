/**
 * Decode a RIFF/WAVE file holding 16-bit little-endian PCM into Float32 samples in [-1, 1].
 *
 * Pure and dependency-free (no DOM, no node), so the same decoder serves the core-side speech
 * tests (a `say`-generated WAV through the real SpeechService), the renderer's VAD tests and the
 * dev-instance seam that injects a WAV into a live voice conversation. The counterpart encoder is
 * `core/speech/pcm.ts` `pcmToWav`.
 *
 * Multi-channel input is downmixed by averaging. Chunks other than `fmt ` / `data` are skipped
 * (afconvert writes a `FLLR` padding chunk before `data`; a naive 44-byte header offset reads that
 * padding as audio). Anything that is not PCM16 WAVE throws — a caller that wants leniency has
 * the wrong file.
 */
export interface DecodedWav {
  sampleRate: number
  channels: number
  samples: Float32Array
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3])
}

export function decodeWavPcm16(bytes: Uint8Array): DecodedWav {
  if (bytes.byteLength < 12 || fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let audioFormat = 0
  let data: { offset: number; length: number } | null = null
  let pos = 12
  while (pos + 8 <= bytes.byteLength) {
    const id = fourcc(bytes, pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) }
    }
    // Chunks are word-aligned: an odd size carries one pad byte.
    pos = body + size + (size % 2)
  }
  if (!data) throw new Error('WAVE file has no data chunk.')
  // 1 = PCM; 0xFFFE = WAVE_FORMAT_EXTENSIBLE, which afconvert emits for some layouts and which
  // wraps PCM when the bit depth says so.
  if ((audioFormat !== 1 && audioFormat !== 0xfffe) || bitsPerSample !== 16 || channels < 1) {
    throw new Error(`Unsupported WAVE format (format ${audioFormat}, ${bitsPerSample}-bit, ${channels} ch).`)
  }
  const frames = Math.floor(data.length / (2 * channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let sum = 0
    for (let c = 0; c < channels; c++) {
      const v = view.getInt16(data.offset + (i * channels + c) * 2, true)
      sum += v / (v < 0 ? 32768 : 32767)
    }
    samples[i] = sum / channels
  }
  return { sampleRate, channels, samples }
}
