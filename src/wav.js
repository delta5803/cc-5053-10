// Minimal 16-bit PCM WAV reader/writer helpers (Node and browser safe).
import { SamplerError } from './engine.js';

export function decodeWav(buffer) {  const view = new DataView(buffer.buffer ?? buffer, buffer.byteOffset ?? 0, buffer.byteLength);
  const readTag = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
  if (readTag(0) !== 'RIFF' || readTag(8) !== 'WAVE') {
    throw new SamplerError('WAV_FORMAT', 'Not a RIFF/WAVE file');
  }
  let offset = 12;
  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  while (offset + 8 <= view.byteLength) {
    const tag = readTag(offset);
    const size = view.getUint32(offset + 4, true);
    if (tag === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (tag === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, view.byteLength - dataOffset);
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt) throw new SamplerError('WAV_FORMAT', 'Missing fmt chunk');
  if (fmt.audioFormat !== 1) {
    throw new SamplerError('WAV_FORMAT', `Only PCM WAV is supported (format ${fmt.audioFormat})`);
  }
  if (fmt.channels < 1 || fmt.channels > 2) {
    throw new SamplerError('WAV_FORMAT', `Unsupported channel count ${fmt.channels}`);
  }
  if (!dataOffset || dataLength <= 0) throw new SamplerError('WAV_FORMAT', 'Missing data chunk');

  const bytes = fmt.bitsPerSample / 8;
  const frames = Math.floor(dataLength / (bytes * fmt.channels));
  const pcm = new Float32Array(frames);
  const gain = fmt.bitsPerSample === 16 ? 1 / 32768 : fmt.bitsPerSample === 8 ? 1 / 128 : 1;
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const o = dataOffset + (i * fmt.channels + c) * bytes;
      if (fmt.bitsPerSample === 16) acc += view.getInt16(o, true);
      else if (fmt.bitsPerSample === 8) acc += view.getUint8(o) - 128;
      else if (fmt.bitsPerSample === 24) {
        const v = (view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16));
        acc += v;
      } else if (fmt.bitsPerSample === 32) acc += view.getInt32(o, true) / 65536;
      else throw new SamplerError('WAV_FORMAT', `Unsupported bit depth ${fmt.bitsPerSample}`);
    }
    pcm[i] = (acc / fmt.channels) * gain;
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    frames,
    pcm,
  };
}

// Encode mono Float32 PCM as a 16-bit PCM WAV ArrayBuffer.
export function encodeWav16(pcm, sampleRate) {
  const n = pcm.length;
  const out = new ArrayBuffer(44 + n * 2);
  const view = new DataView(out);
  const tag = (o, s) => { for (let i = 0; i < 4; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, n * 2, true);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  const g = peak > 0.999 ? 0.999 / peak : 1;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i] * g));
    view.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return out;
}
