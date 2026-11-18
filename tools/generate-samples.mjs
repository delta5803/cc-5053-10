#!/usr/bin/env node
// Generates the small original sample set used by the sampler.
// Deterministic synthesis: no external recordings are used.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets', 'samples');
const SR = 48000;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Struck-string/reed hybrid. The loop body is phase-aligned with the note's
// natural partials, so entering the loop and wrapping are both continuous.
// The last `fade` samples blend the steady tone onto the material immediately
// before loopStart, making the wrap exact to within a fraction of a sample.
function recordNote({ midi, seconds, loop = null, brightness = 1, seed = 1 }) {
  let n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const f0 = midiToHz(midi);
  const rnd = mulberry32(seed);

  const partials = [];
  for (let h = 1; h <= 12; h++) {
    const detune = (rnd() - 0.5) * 0.35;
    const amp = (1 / Math.pow(h, 1.25)) * (h <= 2 ? 1 : Math.pow(brightness, h - 2));
    const decay = 0.55 + h * 0.19;
    const phase = rnd() * Math.PI * 2;
    partials.push({ f: f0 * h * Math.pow(2, detune / 1200), amp, decay, phase });
  }
  partials[9].f *= 1.0035;
  partials[10].f *= 1.0071;
  partials[11].f *= 1.0102;

  const attack = 0.006;
  const bloom = 0.09;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const atk = Math.min(1, t / attack);
    const env = atk * (0.72 + 0.28 * Math.exp(-t / bloom));
    let s = 0;
    for (const p of partials) {
      s += p.amp * Math.exp(-t / p.decay) * Math.sin(2 * Math.PI * p.f * t + p.phase);
    }
    out[i] = s * env * 0.19;
  }

  let lp = 0;
  for (let i = 0; i < Math.min(n, Math.round(0.025 * SR)); i++) {
    const t = i / SR;
    lp += 0.35 * ((rnd() * 2 - 1) - lp);
    out[i] += lp * 0.16 * Math.exp(-t / 0.008);
  }

  let loopStart = 0, loopEnd = n, fade = 0, loopFrames = 0;
  if (loop) {
    const cycles = Math.max(4, Math.round(loop.loopSeconds * f0));
    loopFrames = Math.round((SR / f0) * cycles);
    fade = Math.round(loop.fadeSeconds * SR);
    loopStart = Math.round(loop.startSeconds * SR);
    const tailEnd = loopStart + loopFrames + fade;
    if (loopStart < fade + 1 || tailEnd > n) throw new Error('loop does not fit');

    const s0 = loopStart / SR;
    // Freeze the partial amplitudes *and the bloom envelope* at the loop
    // entry; keep the exact phase continuation of the naturally decaying
    // note. The result is a steady tone whose samples at and before loopStart
    // join smoothly with the natural pre-loop material.
    const env0 = 0.72 + 0.28 * Math.exp(-s0 / bloom);
    const steady = new Float32Array(loopFrames + fade);
    for (let k = 0; k < steady.length; k++) {
      const t = s0 + k / SR;
      let s = 0;
      for (const p of partials) {
        const amp = p.amp * Math.exp(-s0 / p.decay);
        s += amp * Math.sin(2 * Math.PI * p.f * t + p.phase);
      }
      steady[k] = s * 0.19 * env0;
    }
    for (let k = 0; k < steady.length; k++) out[loopStart + k] = steady[k];

    // Crossfade the loop tail onto the pre-loop material. At k = fade-1 the
    // output equals out[loopStart-1], so wrapping to loopStart continues the
    // pre-loop waveform with no jump.
    for (let k = 0; k < fade; k++) {
      const idx = loopStart + loopFrames + k;
      const pre = loopStart - fade + k;
      const w = 0.5 - 0.5 * Math.cos(Math.PI * k / (fade - 1));
      out[idx] = out[idx] * (1 - w) + out[pre] * w;
    }
    // Keep the final sample equal to the pre-loop trajectory exactly.
    out[tailEnd - 1] = out[loopStart - 1];
    loopEnd = tailEnd;
    n = loopEnd;
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const trimmed = out.slice(0, n);
  for (let i = 0; i < n; i++) trimmed[i] *= scale;

  return { data: trimmed, loopStart, loopEnd, loopFade: fade, loopFrames };
}

function encodeWav(samples, sr) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

// Six roots a octave apart. Every playable key is within ±6 semitones of its
// zone's root, so resampling stays musical. Keyboard range is C2..C7.
const ROOTS = [
  { root: 36, name: 'c2', seconds: 1.45, loop: { startSeconds: 0.52, loopSeconds: 0.12, fadeSeconds: 0.020 }, soft: 0.62, hard: 1.0 },
  { root: 48, name: 'c3', seconds: 1.40, loop: { startSeconds: 0.50, loopSeconds: 0.13, fadeSeconds: 0.018 }, soft: 0.60, hard: 1.0 },
  { root: 60, name: 'c4', seconds: 1.30, loop: { startSeconds: 0.46, loopSeconds: 0.12, fadeSeconds: 0.016 }, soft: 0.59, hard: 1.0 },
  { root: 72, name: 'c5', seconds: 1.20, loop: { startSeconds: 0.42, loopSeconds: 0.12, fadeSeconds: 0.014 }, soft: 0.64, hard: 1.0 },
  { root: 84, name: 'c6', seconds: 1.10, loop: { startSeconds: 0.38, loopSeconds: 0.11, fadeSeconds: 0.012 }, soft: 0.68, hard: 1.0 },
  { root: 96, name: 'c7', seconds: 1.00, loop: { startSeconds: 0.34, loopSeconds: 0.10, fadeSeconds: 0.010 }, soft: 0.72, hard: 1.0 },
];

mkdirSync(OUT, { recursive: true });
const manifest = [];
for (const r of ROOTS) {
  for (const layer of ['soft', 'hard']) {
    const name = `${r.name}-${layer}`;
    const seed = r.root * 10 + (layer === 'soft' ? 1 : 2);
    const { data, loopStart, loopEnd, loopFade, loopFrames } = recordNote({
      midi: r.root,
      seconds: r.seconds,
      loop: r.loop,
      brightness: layer === 'soft' ? r.soft : r.hard,
      seed,
    });
    writeFileSync(join(OUT, `${name}.wav`), encodeWav(data, SR));
    manifest.push({
      file: `${name}.wav`,
      name,
      rootMidi: r.root,
      layer,
      sampleRate: SR,
      frames: data.length,
      seconds: +(data.length / SR).toFixed(3),
      loop: r.loop
        ? { start: loopStart, end: loopEnd, bodyFrames: loopFrames, fadeFrames: loopFade }
        : null,
    });
    console.log(`wrote ${name}.wav root=${r.root} frames=${data.length} loop=${r.loop ? `${loopStart}-${loopEnd} fade=${loopFade}` : 'none'}`);
  }
}
writeFileSync(join(OUT, 'recordings.json'), JSON.stringify({ sampleRate: SR, notes: manifest }, null, 2) + '\n');
console.log(`wrote recordings.json (${manifest.length} recordings)`);
