// Sample-keyboard engine core (pure JS: no DOM, no Web Audio).
// The browser UI, the offline report and the test-suite all run this code, so
// selection, voice accounting, loop checks and rendered pitch agree exactly.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function noteName(midi) {
  const m = Math.round(midi);
  return `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

export class SamplerError extends Error {
  constructor(code, message, hint = '') {
    super(message);
    this.name = 'SamplerError';
    this.code = code;
    this.hint = hint;
  }
}

export const DEFAULTS = Object.freeze({
  maxVoices: 24,
  cacheBytes: 2 * 1024 * 1024,
  attackMs: 6,
  releaseMs: 180,
  stealReleaseMs: 8,
  velocityBlendLo: 76,
  velocityBlendHi: 100,
  velocityBlendKind: 'linear',
  velocityFloor: 0.06,
  velocityExponent: 1.4,
  // Loop acceptance: the raw wrap discontinuity must not exceed this multiple
  // of the waveform's normal sample-to-sample motion.
  loopMaxStepRatio: 3,
  // The two halves of the loop body must have similar RMS, otherwise the loop
  // audibly pumps.
  loopMaxRmsDrift: 0.12,
});

function assertInt(value, lo, hi, code, label) {
  if (!Number.isFinite(value) || Math.round(value) !== value || value < lo || value > hi) {
    throw new SamplerError(code, `${label} must be an integer in [${lo}, ${hi}] (got ${value})`);
  }
  return value;
}

export function velocityGain(velocity, cfg = DEFAULTS) {
  const v = assertInt(velocity, 1, 127, 'VELOCITY_RANGE', 'velocity');
  const floor = cfg.velocityFloor ?? DEFAULTS.velocityFloor;
  const exp = cfg.velocityExponent ?? DEFAULTS.velocityExponent;
  return floor + (1 - floor) * Math.pow(v / 127, exp);
}

// ---------------------------------------------------------------------------
// Instrument definition: explicit zones and explicit boundary rule
// ---------------------------------------------------------------------------

// Zone boundaries use the ceiling of the midpoint toward the upper root, so
// the boundary note belongs to the LOWER root's zone. With roots 48 and 60 the
// midpoint is 54: MIDI 48..53 use C3, MIDI 54..65 use C4. A boundary note is
// therefore always resolved by a published rule, never arbitrarily.
export function buildInstrument(manifest, options = {}) {
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) if (v !== undefined) cfg[k] = v;
  validateConfig(cfg);
  if (!manifest || !Array.isArray(manifest.notes) || manifest.notes.length === 0) {
    throw new SamplerError('MANIFEST_EMPTY', 'The sample manifest contains no notes');
  }
  const byRoot = new Map();
  for (const rec of manifest.notes) {
    if (!(rec.frames > 0)) throw new SamplerError('BAD_SAMPLE', `Sample ${rec.file} has no frames`);
    if (!byRoot.has(rec.rootMidi)) byRoot.set(rec.rootMidi, {});
    const store = byRoot.get(rec.rootMidi);
    if (store[rec.layer]) {
      throw new SamplerError('DUPLICATE_LAYER', `Root ${noteName(rec.rootMidi)} has two ${rec.layer} recordings`);
    }
    store[rec.layer] = rec;
  }
  const roots = [...byRoot.keys()].sort((a, b) => a - b);
  const zones = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    const store = byRoot.get(root);
    const missing = ['soft', 'hard'].filter((l) => !store[l]);
    if (missing.length) {
      throw new SamplerError(
        'MANIFEST_INCOMPLETE',
        `Root ${noteName(root)} is missing velocity layer(s): ${missing.join(', ')}`,
        'Every root must supply both soft and hard recordings',
      );
    }
    const lo = i === 0 ? 0 : Math.ceil((roots[i - 1] + root) / 2);
    const hi = i === roots.length - 1 ? 127 : Math.ceil((root + roots[i + 1]) / 2) - 1;
    zones.push({
      index: i,
      rootMidi: root,
      lo,
      hi,
      samples: { soft: store.soft, hard: store.hard },
      boundaryNote: i === 0 ? null : lo,
      boundaryRule:
        i === 0
          ? 'first zone, starts at MIDI 0'
          : i === roots.length - 1
            ? `starts at ceiling midpoint of ${noteName(roots[i - 1])}/${noteName(root)} = ${lo}`
            : `starts at ceiling midpoint of ${noteName(roots[i - 1])}/${noteName(root)} = ${lo}; ` +
              `next zone starts at ${hi + 1}`,
    });
  }
  return {
    manifest,
    cfg,
    roots,
    zones,
    velocityBlend: { lo: cfg.velocityBlendLo, hi: cfg.velocityBlendHi, kind: cfg.velocityBlendKind },
    noteRange: { lo: zones[0].lo, hi: zones[zones.length - 1].hi },
  };
}

function validateConfig(cfg) {
  if (!(cfg.velocityBlendLo >= 1 && cfg.velocityBlendHi <= 127 && cfg.velocityBlendLo < cfg.velocityBlendHi)) {
    throw new SamplerError(
      'VELOCITY_BLEND_BAND',
      `Velocity crossfade band needs 1 <= lo < hi <= 127 (got ${cfg.velocityBlendLo}..${cfg.velocityBlendHi})`,
    );
  }
  if (!(cfg.maxVoices >= 1 && cfg.maxVoices <= 128)) {
    throw new SamplerError('VOICE_LIMIT_RANGE', `maxVoices must be in [1, 128] (got ${cfg.maxVoices})`);
  }
  if (!(cfg.cacheBytes > 0)) {
    throw new SamplerError('CACHE_LIMIT_RANGE', `cacheBytes must be positive (got ${cfg.cacheBytes})`);
  }
  for (const k of ['attackMs', 'releaseMs', 'stealReleaseMs']) {
    if (!(cfg[k] >= 0)) throw new SamplerError('ENVELOPE_RANGE', `${k} must be >= 0 (got ${cfg[k]})`);
  }
  if (!(cfg.velocityFloor >= 0 && cfg.velocityFloor < 1)) {
    throw new SamplerError('VELOCITY_FLOOR', `velocityFloor must be in [0, 1) (got ${cfg.velocityFloor})`);
  }
}

export function zoneFor(instrument, midi) {
  assertInt(midi, 0, 127, 'MIDI_RANGE', 'midi');
  for (const z of instrument.zones) if (midi >= z.lo && midi <= z.hi) return z;
  throw new SamplerError('ZONE_NOT_FOUND', `No zone covers MIDI ${midi}`);
}

// Deterministic layer decision: soft below the band, hard above it, fixed
// equal-power crossfade inside it. Nothing here depends on call history.
export function layerMixFor(velocity, instrument) {
  const v = assertInt(velocity, 1, 127, 'VELOCITY_RANGE', 'velocity');
  const cfg = instrument.cfg;
  const lo = cfg.velocityBlendLo;
  const hi = cfg.velocityBlendHi;
  // Bands: [1..lo-1] soft, [lo..hi-1] blend (both layers audible at every
  // point in the band), [hi..127] hard.
  if (v < lo) return { kind: 'soft', soft: 1, hard: 0, band: 0 };
  if (v >= hi) return { kind: 'hard', soft: 0, hard: 1, band: 1 };
  const x = (v - lo + 1) / (hi - lo + 1);
  const hardW = cfg.velocityBlendKind === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x;
  return { kind: 'blend', soft: 1 - hardW, hard: hardW, band: x };
}

// Fully deterministic selection. The same (note, velocity) always yields the
// same recording(s) and playback rate; the reason string records why.
export function selectSample(instrument, note, velocity) {
  const zone = zoneFor(instrument, note);
  const mix = layerMixFor(velocity, instrument);
  const semitones = note - zone.rootMidi;
  const rate = Math.pow(2, semitones / 12);
  const gain = velocityGain(velocity, instrument.cfg);
  const entries = [];
  for (const layer of ['soft', 'hard']) {
    if (mix[layer] <= 0) continue;
    const rec = zone.samples[layer];
    entries.push({
      layer,
      gain: mix[layer] * gain,
      layerWeight: mix[layer],
      sample: rec,
      rate,
      semitones,
      cents: 1200 * (semitones / 12),
      loop: rec.loop ? { ...rec.loop } : null,
    });
  }
  return {
    note,
    velocity,
    zoneIndex: zone.index,
    zone: { rootMidi: zone.rootMidi, lo: zone.lo, hi: zone.hi },
    mix,
    rate,
    semitones,
    cents: 1200 * (semitones / 12),
    gain,
    entries,
    reason:
      `${noteName(note)} (MIDI ${note}) is in zone ${noteName(zone.rootMidi)} [${zone.lo}..${zone.hi}], ` +
      `so the ${noteName(zone.rootMidi)} recording plays at ${rate.toFixed(4)}x ` +
      `(${semitones >= 0 ? '+' : ''}${semitones} st); ` +
      `velocity ${velocity} selects ${mix.kind}` +
      (mix.kind === 'blend'
        ? ` (soft ${(mix.soft * 100).toFixed(1)}% / hard ${(mix.hard * 100).toFixed(1)}%)`
        : ` at ${(gain * 100).toFixed(1)}% amplitude`),
  };
}

export function describeKeyMap(instrument) {
  return instrument.zones.map((z) => ({
    root: noteName(z.rootMidi),
    rootMidi: z.rootMidi,
    lo: z.lo,
    hi: z.hi,
    loName: noteName(z.lo),
    hiName: noteName(z.hi),
    boundaryRule: z.boundaryRule,
    softFile: z.samples.soft.file,
    hardFile: z.samples.hard.file,
  }));
}

// ---------------------------------------------------------------------------
// Bounded sample cache
// ---------------------------------------------------------------------------

export function sampleBytes(rec, bytesPerFrame = 4) {
  return rec.frames * bytesPerFrame;
}

export class SampleCache {
  constructor(instrument, options = {}) {
    this.instrument = instrument;
    this.budget = options.cacheBytes ?? instrument.cfg.cacheBytes;
    this.entries = new Map();
    this.tick = 0;
    this.evictions = 0;
    this.usedBytes = 0;
    this.peakBytes = 0;
    this.voiceRefs = new Map(); // key -> number of voices currently using it
    this.onEvent = options.onEvent ?? null;
  }

  _emit(type, detail) {
    if (this.onEvent) this.onEvent({ type, ...detail });
  }

  findRecord(key) {
    for (const z of this.instrument.zones) {
      for (const layer of ['soft', 'hard']) {
        if (z.samples[layer].name === key) return z.samples[layer];
      }
    }
    return null;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const e = this.entries.get(key);
    if (e) e.lastUsed = ++this.tick;
    return e ?? null;
  }

  put(key, data) {
    const rec = this.findRecord(key);
    if (!rec) throw new SamplerError('UNKNOWN_SAMPLE', `Unknown sample key ${key}`);
    const bytes = sampleBytes(rec);
    if (this.entries.has(key)) {
      const e = this.entries.get(key);
      e.data = data;
      e.lastUsed = ++this.tick;
      return e;
    }
    // Validate against the budget for new entries. Note: the resident entry
    // for `key` has already been checked at insert time.
    if (bytes > this.budget) {
      throw new SamplerError(
        'CACHE_TOO_SMALL',
        `Recording ${key} needs ${bytes} B, larger than the whole cache budget of ${this.budget} B`,
        'Raise cacheBytes or shorten the recording',
      );
    }
    this._makeRoom(bytes, key);
    const entry = { rec, data, bytes, pins: 0, lastUsed: ++this.tick };
    this.entries.set(key, entry);
    this.usedBytes += bytes;
    this.peakBytes = Math.max(this.peakBytes, this.usedBytes);
    this._emit('load', { key, bytes, used: this.usedBytes, budget: this.budget });
    return entry;
  }

  _makeRoom(bytes, forKey) {
    if (this.usedBytes + bytes <= this.budget) return;
    const candidates = [...this.entries.entries()]
      .filter(([k, e]) => k !== forKey && e.pins === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [k, e] of candidates) {
      this.entries.delete(k);
      this.usedBytes -= e.bytes;
      this.evictions++;
      this._emit('evict', { key: k, bytes: e.bytes, used: this.usedBytes, budget: this.budget });
      if (this.usedBytes + bytes <= this.budget) return;
    }
    const pinned = [...this.entries.values()].filter((e) => e.pins > 0);
    throw new SamplerError(
      'CACHE_PINNED_FULL',
      `Cannot load ${forKey}: ${this.usedBytes} B resident + ${bytes} B required exceeds the ` +
        `${this.budget} B budget, and ${pinned.length} cached recording(s) are in use by voices`,
      'Release a voice, preload fewer samples, or raise cacheBytes',
    );
  }

  // A "pin" marks an entry as referenced by a sounding voice. Pinned entries
  // are never evicted. Pins are re-entrant so two voices can share one sample.
  pin(key) {
    const e = this.entries.get(key);
    if (!e) throw new SamplerError('CACHE_MISS', `Cannot pin ${key}: not loaded`);
    e.pins++;
    this.voiceRefs.set(key, (this.voiceRefs.get(key) ?? 0) + 1);
    e.lastUsed = ++this.tick;
    this._emit('pin', { key, pins: e.pins, used: this.usedBytes, budget: this.budget });
    return e;
  }

  unpin(key) {
    const e = this.entries.get(key);
    if (!e) return;
    e.pins = Math.max(0, e.pins - 1);
    const refs = (this.voiceRefs.get(key) ?? 0) - 1;
    if (refs <= 0) this.voiceRefs.delete(key);
    else this.voiceRefs.set(key, refs);
    e.lastUsed = ++this.tick;
    this._emit('unpin', { key, pins: e.pins, used: this.usedBytes, budget: this.budget });
  }

  refs(key) {
    return this.voiceRefs.get(key) ?? 0;
  }

  snapshot() {
    return {
      budget: this.budget,
      usedBytes: this.usedBytes,
      peakBytes: this.peakBytes,
      evictions: this.evictions,
      entries: [...this.entries.entries()]
        .map(([key, e]) => ({ key, bytes: e.bytes, pins: e.pins, lastUsed: e.lastUsed }))
        .sort((a, b) => b.lastUsed - a.lastUsed),
    };
  }
}

// Bytes required to keep the whole instrument resident (all zones/layers).
export function residentBytes(instrument) {
  let total = 0;
  for (const z of instrument.zones) {
    total += sampleBytes(z.samples.soft) + sampleBytes(z.samples.hard);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Voice manager
// ---------------------------------------------------------------------------

// Voice lifecycle: held -> release -> finished. Stealing a voice when the cap
// is reached removes it from the logical count immediately but keeps its cache
// pins until a short fade tail ends, so the buffer can never be unloaded while
// still audible.
export class VoiceManager {
  constructor(instrument, cache, options = {}) {
    this.instrument = instrument;
    this.cache = cache;
    this.cfg = { ...instrument.cfg };
    for (const [k, v] of Object.entries(options)) if (v !== undefined) this.cfg[k] = v;
    validateConfig(this.cfg);
    this.voices = new Map();
    this.tails = new Map();
    this.nextId = 1;
    this.order = 0;
    this.steals = 0;
    this.rejections = 0;
    this.log = [];
  }

  activeCount() {
    return this.voices.size;
  }

  audibleCount() {
    return this.voices.size + this.tails.size;
  }

  _record(kind, voice, time, extra = {}) {
    this.log.push({
      kind,
      id: voice.id,
      note: voice.note,
      noteName: noteName(voice.note),
      velocity: voice.velocity,
      zone: voice.plan.zone.rootMidi,
      samples: voice.plan.entries.map((e) => e.sample.name),
      layers: voice.plan.entries.map((e) => e.layer),
      rate: voice.plan.rate,
      state: voice.state,
      time: +Number(time).toFixed(6),
      active: this.voices.size,
      audible: this.audibleCount(),
      ...extra,
    });
    if (this.log.length > 400) this.log.shift();
  }

  _pinPlan(plan) {
    const pinned = [];
    try {
      for (const ent of plan.entries) {
        const key = ent.sample.name;
        if (!this.cache.has(key)) {
          throw new SamplerError('CACHE_MISS', `Recording ${key} is not resident`, 'Preload it before note-on');
        }
        this.cache.pin(key);
        pinned.push(key);
      }
    } catch (err) {
      for (const key of pinned) this.cache.unpin(key);
      this.rejections++;
      throw err;
    }
    return pinned;
  }

  _chooseVictim() {
    let releasing = null;
    for (const v of this.voices.values()) {
      if (v.state === 'release' && (!releasing || v.order < releasing.order)) releasing = v;
    }
    if (releasing) return { voice: releasing, reason: 'releasing-oldest' };
    let oldest = null;
    for (const v of this.voices.values()) if (!oldest || v.order < oldest.order) oldest = v;
    return { voice: oldest, reason: 'oldest-held' };
  }

  noteOn(note, velocity, time, plan = null, tag = null) {
    const resolved = plan ?? selectSample(this.instrument, note, velocity);
    const keys = this._pinPlan(resolved);
    let victim = null;
    let stealReason = null;
    if (this.voices.size >= this.cfg.maxVoices) {
      const choice = this._chooseVictim();
      victim = choice.voice;
      stealReason = choice.reason;
      this.steals++;
      // Move the victim to a fade tail; its pins stay until the tail ends.
      this.voices.delete(victim.id);
      victim.state = 'stealing';
      victim.releaseTime = time;
      victim.releaseReason = `steal:${stealReason}`;
      this.tails.set(victim.id, {
        voice: victim,
        endTime: time + this.cfg.stealReleaseMs / 1000,
        keys: victim.keys,
      });
      this._record('steal', victim, time, { reason: stealReason, byNote: note, byId: this.nextId });
    }
    const voice = {
      id: this.nextId++,
      note,
      velocity,
      plan: resolved,
      keys,
      tag,
      state: 'held',
      startTime: time,
      releaseTime: null,
      releaseReason: null,
      order: ++this.order,
    };
    this.voices.set(voice.id, voice);
    this._record('noteOn', voice, time, victim ? { stolenId: victim.id } : {});
    return { voice, stolen: victim ? { id: victim.id, note: victim.note, reason: stealReason } : null, plan: resolved };
  }

  noteOff(note, time, tag = null) {
    let count = 0;
    for (const v of [...this.voices.values()]) {
      if (v.note !== note || v.state !== 'held') continue;
      if (tag !== null && v.tag !== tag) continue;
      v.state = 'release';
      v.releaseTime = time;
      v.releaseReason = 'noteOff';
      this._record('noteOff', v, time);
      count++;
    }
    return count;
  }

  // Housekeeping driven by the audio clock: finish released voices and expire
  // steal tails (unpinning their samples).
  tick(now) {
    for (const v of [...this.voices.values()]) {
      if (v.state !== 'release') continue;
      if (now - v.releaseTime >= this.cfg.releaseMs / 1000 - 1e-6) this._finish(v);
    }
    for (const [id, tail] of [...this.tails]) {
      if (now >= tail.endTime - 1e-6) {
        for (const key of tail.keys) this.cache.unpin(key);
        this.tails.delete(id);
        this._record('tailEnd', tail.voice, now);
      }
    }
  }

  _finish(voice) {
    if (!this.voices.has(voice.id)) return false;
    this.voices.delete(voice.id);
    for (const key of voice.keys) this.cache.unpin(key);
    this._record('finished', voice, voice.releaseTime ?? voice.startTime);
    return true;
  }

  snapshot() {
    return {
      maxVoices: this.cfg.maxVoices,
      activeCount: this.voices.size,
      tailCount: this.tails.size,
      audibleCount: this.audibleCount(),
      steals: this.steals,
      rejections: this.rejections,
      voices: [...this.voices.values()]
        .sort((a, b) => a.order - b.order)
        .map((v) => ({
          id: v.id,
          note: v.note,
          noteName: noteName(v.note),
          velocity: v.velocity,
          state: v.state,
          zoneRoot: v.plan.zone.rootMidi,
          zoneRange: [v.plan.zone.lo, v.plan.zone.hi],
          rate: v.plan.rate,
          semitones: v.plan.semitones,
          mix: v.plan.mix.kind,
          layers: v.plan.entries.map((e) => ({
            layer: e.layer,
            sample: e.sample.name,
            file: e.sample.file,
            gain: e.gain,
            weight: e.layerWeight,
            loop: e.loop ? { start: e.loop.start, end: e.loop.end } : null,
            region: e.loop
              ? `${e.loop.start}–${e.loop.end}`
              : `0–${e.sample.frames - 1} (one-shot)`,
          })),
          keys: v.keys,
          startTime: v.startTime,
          releaseReason: v.releaseReason,
        })),
    };
  }
}

// ---------------------------------------------------------------------------
// Loop and recording verification
// ---------------------------------------------------------------------------

// The recorded loop region [start, end) must wrap end-1 -> start without a
// click. The generator already bends the pre-wrap tail onto the pre-loop
// material; this check measures the seam independently and reports it.
export function analyzeLoop(rec, pcm, cfg = DEFAULTS) {
  if (!rec.loop) {
    return { checked: false, ok: true, note: 'one-shot recording; no loop to wrap' };
  }
  const { start, end } = rec.loop;
  if (!(start > 0 && end > start + 1 && end <= pcm.length)) {
    return {
      checked: true,
      ok: false,
      errorCode: 'LOOP_BOUNDS',
      error: `Loop ${start}..${end} is outside the recording's 0..${pcm.length} frames`,
      start,
      end,
    };
  }
  const first = pcm[start];
  const last = pcm[end - 1];
  const jump = Math.abs(first - last);
  let min = Infinity;
  let max = -Infinity;
  let sumSqA = 0;
  let sumSqB = 0;
  const half = start + Math.floor((end - start) / 2);
  for (let i = start; i < end; i++) {
    const v = pcm[i];
    if (v < min) min = v;
    if (v > max) max = v;
    if (i < half) sumSqA += v * v;
    else sumSqB += v * v;
  }
  const peakToPeak = max - min;
  // A click is a discontinuity much larger than the waveform's normal motion
  // at that point in the recording. Compare the wrap step with the two local
  // steps that bracket it; the loop body's global average step is a poor
  // reference because a decaying low note legitimately has a small slope
  // while the seam sits on a steep part of the cycle.
  const stepBefore = Math.abs(pcm[start] - pcm[start - 1]);
  const stepAfter = Math.abs(pcm[start + 1] - pcm[start]);
  const stepTail = Math.abs(pcm[end - 1] - pcm[end - 2]);
  const localRef = Math.max(stepBefore, stepAfter, stepTail, 1e-9);
  const stepRatio = jump / localRef;
  const rmsA = Math.sqrt(sumSqA / Math.max(1, half - start));
  const rmsB = Math.sqrt(sumSqB / Math.max(1, end - half));
  const rmsDrift = rmsA > 0 ? Math.abs(rmsB - rmsA) / rmsA : 0;
  const seamOk = stepRatio <= cfg.loopMaxStepRatio;
  const steadyOk = rmsDrift <= cfg.loopMaxRmsDrift;
  return {
    checked: true,
    ok: seamOk && steadyOk,
    start,
    end,
    frames: end - start,
    seconds: +((end - start) / (rec.sampleRate || 32000)).toFixed(4),
    seamJump: jump,
    seamPeakToPeak: peakToPeak,
    seamRatio: peakToPeak > 0 ? jump / peakToPeak : 0,
    seamStepRatio: stepRatio,
    seamLimit: cfg.loopMaxStepRatio,
    localStepReference: localRef,
    rmsDrift,
    rmsLimit: cfg.loopMaxRmsDrift,
    checks: [
      { name: 'seam step / local step', value: stepRatio, limit: cfg.loopMaxStepRatio, ok: seamOk },
      { name: 'RMS drift', value: rmsDrift, limit: cfg.loopMaxRmsDrift, ok: steadyOk },
    ],
    note: seamOk && steadyOk
      ? `wrap step ${stepRatio.toFixed(2)}x the local step; RMS drift ${(rmsDrift * 100).toFixed(1)}%`
      : `failed: wrap step ${stepRatio.toFixed(2)}x local (limit ${cfg.loopMaxStepRatio}x), ` +
        `RMS drift ${(rmsDrift * 100).toFixed(1)}% (limit ${(cfg.loopMaxRmsDrift * 100).toFixed(0)}%)`,
  };
}

// YIN pitch estimate over a steady window of rendered audio. YIN is used
// instead of raw autocorrelation because the latter happily reports a strong
// harmonic as the fundamental, which made octave-ups look like pitch errors.
export function estimatePitch(pcm, sampleRate, { from = 0.08, to = 0.35, minHz = 25, maxHz = 5000 } = {}) {
  const a = Math.floor(from * sampleRate);
  const b = Math.min(pcm.length, Math.floor(to * sampleRate));
  if (b - a < 512) return null;
  const win = pcm.subarray(a, b);
  const W = Math.min(win.length, Math.max(512, Math.floor(sampleRate * 0.05)));
  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.min(W - 2, Math.floor(sampleRate / minHz));
  const diff = new Float64Array(maxLag + 1);
  diff[0] = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < W; i++) {
      const d = win[i] - win[i + lag];
      sum += d * d;
    }
    diff[lag] = sum;
  }
  // Cumulative mean normalised difference.
  const cmnd = new Float64Array(maxLag + 1);
  let running = 0;
  cmnd[0] = 1;
  for (let lag = 1; lag <= maxLag; lag++) {
    running += diff[lag];
    cmnd[lag] = running > 0 ? (diff[lag] * lag) / running : 1;
  }
  const threshold = 0.15;
  let bestLag = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (cmnd[lag] < threshold) {
      // Walk to the bottom of this dip.
      while (lag + 1 <= maxLag && cmnd[lag + 1] < cmnd[lag]) lag++;
      bestLag = lag;
      break;
    }
  }
  if (bestLag < 0) {
    // Fall back to the global minimum (weakly periodic material).
    let minVal = Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      if (cmnd[lag] < minVal) {
        minVal = cmnd[lag];
        bestLag = lag;
      }
    }
  }
  if (bestLag < 0) return null;
  let lag = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const y0 = cmnd[bestLag - 1];
    const y1 = cmnd[bestLag];
    const y2 = cmnd[bestLag + 1];
    const denom = y0 - 2 * y1 + y2;
    if (Math.abs(denom) > 1e-12) lag += (0.5 * (y0 - y2)) / denom;
  }
  return { hz: sampleRate / lag, confidence: 1 - cmnd[bestLag], lag };
}

export function centsOff(measuredHz, expectedHz) {
  return 1200 * Math.log2(measuredHz / expectedHz);
}

// ---------------------------------------------------------------------------
// Offline renderer
// ---------------------------------------------------------------------------

// Renders a note schedule through the same selection, voice-allocation and
// loop-wrap rules as the live engine. Output is mono Float32.
export class OfflineRenderer {
  constructor(instrument, pcmByKey, options = {}) {
    this.instrument = instrument;
    this.pcmByKey = pcmByKey;
    this.sr = options.sampleRate ?? instrument.manifest.sampleRate ?? 32000;
    this.cache = new SampleCache(instrument, { cacheBytes: options.cacheBytes });
    this.vm = new VoiceManager(instrument, this.cache, { maxVoices: options.maxVoices });
    this.pcmCache = new Map();
    for (const z of instrument.zones) {
      for (const layer of ['soft', 'hard']) {
        const rec = z.samples[layer];
        const pcm = pcmByKey.get(rec.name);
        if (!pcm) throw new SamplerError('PCM_MISSING', `No PCM supplied for ${rec.name}`);
        this.cache.put(rec.name, pcm);
        this.pcmCache.set(rec.name, pcm);
      }
    }
  }

  render(events, { seconds = 4 } = {}) {
    const sr = this.sr;
    const frames = Math.ceil(seconds * sr);
    const out = new Float32Array(frames);
    const evs = [...events].sort((a, b) => a.time - b.time || (a.type === 'off' ? -1 : 1));
    let next = 0;
    const runtimes = new Map();
    const tails = new Map();
    let maxActive = 0;
    let maxAudible = 0;
    const cfg = this.vm.cfg;
    const attackSec = cfg.attackMs / 1000;
    const releaseSec = cfg.releaseMs / 1000;
    const tailSec = cfg.stealReleaseMs / 1000;

    for (let frame = 0; frame < frames; frame++) {
      const t = frame / sr;
      this.vm.tick(t);
      while (next < evs.length && evs[next].time <= t + 1e-9) {
        const ev = evs[next++];
        if (ev.type === 'on') {
          const res = this.vm.noteOn(ev.note, ev.velocity ?? 100, t, null, ev.tag ?? null);
          if (res.stolen) {
            const oldRt = runtimes.get(res.stolen.id);
            if (oldRt) {
              runtimes.delete(res.stolen.id);
              tails.set(res.stolen.id, { rt: oldRt, from: t, sec: tailSec });
            }
          }
          runtimes.set(res.voice.id, {
            voice: res.voice,
            pos: 0,
            env: 0,
            releaseFrom: null,
          });
        } else if (ev.type === 'off') {
          this.vm.noteOff(ev.note, t, ev.tag ?? null);
        }
      }
      let mixFrame = 0;
      for (const rt of [...runtimes.values()]) {
        const v = rt.voice;
        if (v.state === 'release' && rt.releaseFrom === null) rt.releaseFrom = v.releaseTime;
        if (v.state === 'release' && t - rt.releaseFrom >= releaseSec - 1e-9) {
          runtimes.delete(v.id);
          this.vm._finish(v);
          continue;
        }
        let s = 0;
        for (const ent of v.plan.entries) {
          const src = this.pcmCache.get(ent.sample.name);
          let pos = rt.pos;
          if (ent.loop && pos >= ent.loop.end) {
            pos = ent.loop.start + ((pos - ent.loop.start) % (ent.loop.end - ent.loop.start));
          }
          if (pos < src.length - 1) s += lerp(src, pos) * ent.gain;
        }
        const age = t - v.startTime;
        const atk = attackSec > 0 ? Math.min(1, age / attackSec) : 1;
        const rel = rt.releaseFrom === null ? 1 : Math.max(0, 1 - (t - rt.releaseFrom) / releaseSec);
        const env = atk * rel;
        mixFrame += s * env;
        rt.pos += v.plan.rate;
      }
      for (const [id, tail] of [...tails]) {
        const elapsed = t - tail.from;
        if (elapsed >= tail.sec) {
          tails.delete(id);
          this.vm.tails.delete(id);
          continue;
        }
        const rt = tail.rt;
        const gain = 1 - elapsed / tail.sec;
        let s = 0;
        for (const ent of rt.voice.plan.entries) {
          const src = this.pcmCache.get(ent.sample.name);
          let pos = rt.pos;
          if (ent.loop && pos >= ent.loop.end) {
            pos = ent.loop.start + ((pos - ent.loop.start) % (ent.loop.end - ent.loop.start));
          }
          if (pos < src.length - 1) s += lerp(src, pos) * ent.gain;
        }
        mixFrame += s * rt.env * gain;
        rt.pos += rt.voice.plan.rate;
      }
      maxActive = Math.max(maxActive, runtimes.size);
      maxAudible = Math.max(maxAudible, runtimes.size + tails.size);
      out[frame] = Math.tanh(mixFrame * 1.1) / Math.tanh(1.1);
    }
    return {
      pcm: out,
      sampleRate: sr,
      frames,
      maxActive,
      maxAudible,
      voiceLog: this.vm.log,
      voiceManager: this.vm,
      cache: this.cache,
      cacheSnapshot: this.cache.snapshot(),
    };
  }
}

function lerp(pcm, pos) {
  const i = Math.floor(pos);
  if (i < 0) return 0;
  if (i >= pcm.length) return 0;
  const f = pos - i;
  const a = pcm[i];
  const b = i + 1 < pcm.length ? pcm[i + 1] : 0;
  return a * (1 - f) + b * f;
}
