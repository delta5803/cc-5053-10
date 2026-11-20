// Engine tests: selection rules, boundary notes, extreme-low velocity, rapid
// repeats, pitch, loop seams, bounded cache and voice stealing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildInstrument,
  selectSample,
  layerMixFor,
  zoneFor,
  velocityGain,
  analyzeLoop,
  estimatePitch,
  centsOff,
  sampleBytes,
  residentBytes,
  SampleCache,
  VoiceManager,
  OfflineRenderer,
  SamplerError,
  midiToHz,
  noteName,
  DEFAULTS,
} from '../src/engine.js';
import { decodeWav } from '../src/wav.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLES = join(ROOT, 'assets', 'samples');
const manifest = JSON.parse(readFileSync(join(SAMPLES, 'recordings.json'), 'utf8'));
const pcm = new Map();
for (const rec of manifest.notes) {
  pcm.set(rec.name, decodeWav(readFileSync(join(SAMPLES, rec.file))).pcm);
}
const instrument = buildInstrument(manifest);
const SR = manifest.sampleRate;

function render(events, opts = {}) {
  return new OfflineRenderer(instrument, pcm, opts.instOpts ?? {}).render(events, { seconds: opts.seconds ?? 2 });
}
function captureThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

function peakOf(r) {
  let p = 0;
  for (const v of r.pcm) p = Math.max(p, Math.abs(v));
  return p;
}

test('manifest ships six roots with both velocity layers', () => {
  assert.equal(instrument.zones.length, 6);
  for (const z of instrument.zones) {
    assert.ok(z.samples.soft?.frames > 0, `${z.rootMidi} soft`);
    assert.ok(z.samples.hard?.frames > 0, `${z.rootMidi} hard`);
    assert.ok(z.hi >= z.lo);
  }
  assert.equal(residentBytes(instrument), manifest.notes.reduce((s, r) => s + sampleBytes(r), 0));
});

test('zones tile MIDI 0..127 without gaps or overlap', () => {
  let expected = 0;
  for (const z of instrument.zones) {
    assert.equal(z.lo, expected, `zone ${z.rootMidi} must start at ${expected}`);
    assert.ok(z.hi >= z.lo);
    expected = z.hi + 1;
  }
  assert.equal(expected, 128);
});

test('boundary notes resolve to the lower zone by the published midpoint rule', () => {
  // Roots are an octave apart, so the midpoint is exactly 6 semitones up.
  const cases = [
    [42, 48, -6], [47, 48, -1], [48, 48, 0], [53, 48, 5],
    [54, 60, -6], [59, 60, -1], [60, 60, 0], [65, 60, 5],
    [66, 72, -6], [77, 72, 5], [78, 84, -6], [90, 96, -6], [95, 96, -1], [96, 96, 0],
  ];
  for (const [note, root, semis] of cases) {
    const sel = selectSample(instrument, note, 100);
    assert.equal(sel.zone.rootMidi, root, `MIDI ${note} -> root ${root}`);
    assert.equal(sel.semitones, semis);
    assert.ok(Math.abs(sel.rate - Math.pow(2, semis / 12)) < 1e-12);
    // The explanation must name the actual zone.
    assert.match(sel.reason, new RegExp(`zone ${noteName(root)}`));
  }
});

test('selection is deterministic per (note, velocity) and independent of call order', () => {
  const key = (n, v) => selectSample(instrument, n, v).entries.map((e) => `${e.layer}:${e.sample.name}`).join(',');
  const before = new Map();
  for (let n = 36; n <= 96; n++) for (const v of [1, 20, 76, 88, 99, 100, 127]) before.set(`${n}/${v}`, key(n, v));
  // Shuffle the call order.
  const keys = [...before.keys()].sort(() => 0.5 - Math.random());
  for (const k of keys) {
    const [n, v] = k.split('/').map(Number);
    assert.equal(key(n, v), before.get(k), `selection drifted for ${k}`);
  }
});

test('velocity mapping: soft / blend / hard with a deterministic band', () => {
  const lo = instrument.cfg.velocityBlendLo;
  const hi = instrument.cfg.velocityBlendHi;
  assert.equal(layerMixFor(lo - 1, instrument).kind, 'soft');
  assert.equal(layerMixFor(lo, instrument).kind, 'blend');
  assert.equal(layerMixFor(hi - 1, instrument).kind, 'blend');
  assert.equal(layerMixFor(hi, instrument).kind, 'hard');

  // Weights are complementary and both layers are present inside the band.
  for (let v = lo; v < hi; v++) {
    const m = layerMixFor(v, instrument);
    assert.ok(Math.abs(m.soft + m.hard - 1) < 1e-12);
    assert.ok(m.soft > 0 && m.hard < 1);
    const sel = selectSample(instrument, 60, v);
    assert.equal(sel.entries.length, 2, `v${v} must use two layers`);
  }
  // Monotone weights.
  let prevHard = -1;
  for (let v = lo; v < hi; v++) {
    const m = layerMixFor(v, instrument);
    assert.ok(m.hard >= prevHard);
    prevHard = m.hard;
  }
});

test('extreme low velocities are audible and distinct', () => {
  const peaks = [];
  for (const v of [1, 2, 3, 4]) {
    const sel = selectSample(instrument, 60, v);
    assert.equal(sel.mix.kind, 'soft');
    const r = render([{ type: 'on', note: 60, velocity: v, time: 0.02 }], { seconds: 0.8 });
    const p = peakOf(r);
    assert.ok(p > 1e-3, `v${v} produced silence (peak ${p})`);
    peaks.push(p);
    assert.ok(Math.abs(sel.gain - velocityGain(v, instrument.cfg)) < 1e-12);
  }
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] > peaks[i - 1], 'louder velocity must be louder');
});

test('output level rises monotonically with velocity', () => {
  const peaks = [];
  for (let v = 1; v <= 127; v++) {
    const r = render([{ type: 'on', note: 60, velocity: v, time: 0.02 }, { type: 'off', note: 60, time: 0.5 }], { seconds: 0.7 });
    peaks.push(peakOf(r));
  }
  for (let i = 1; i < peaks.length; i++) {
    assert.ok(peaks[i] >= peaks[i - 1] - 1e-3, `peak dropped at v${i + 1}: ${peaks[i - 1]} -> ${peaks[i]}`);
  }
});

test('rendered pitch matches the input note across the keyboard and both layers', () => {
  const notes = [42, 48, 54, 60, 66, 72, 78, 84, 90, 96];
  for (const n of notes) {
    for (const v of [20, 110]) {
      const r = render([{ type: 'on', note: n, velocity: v, time: 0.02 }], { seconds: 1.3 });
      const est = estimatePitch(r.pcm, SR, { from: 0.25, to: 0.65, minHz: 25, maxHz: 5000 });
      assert.ok(est, `no pitch estimate for ${n}`);
      const cents = centsOff(est.hz, midiToHz(n));
      assert.ok(Math.abs(cents) <= 12, `${noteName(n)} v${v} measured ${est.hz.toFixed(2)} Hz (${cents.toFixed(1)} c)`);
    }
  }
});

test('every recording loop passes seam and steady-state checks', () => {
  for (const rec of manifest.notes) {
    const check = analyzeLoop(rec, pcm.get(rec.name), instrument.cfg);
    assert.ok(check.checked, `${rec.name} loop missing`);
    assert.ok(check.ok, `${rec.name}: ${check.note}`);
    assert.ok(check.seamStepRatio <= check.seamLimit);
    assert.ok(check.rmsDrift <= check.rmsLimit);
  }
});

test('a long held note does not click at loop boundaries', () => {
  const r = render([{ type: 'on', note: 60, velocity: 90, time: 0.05 }], { seconds: 5 });
  const from = Math.floor(0.5 * SR);
  const to = Math.floor(4.5 * SR);
  const steps = [];
  for (let i = from + 1; i < to; i++) steps.push(Math.abs(r.pcm[i] - r.pcm[i - 1]));
  const sorted = [...steps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const threshold = Math.max(median * 40, 1e-6);
  let clicks = 0;
  for (const d of steps) if (d > threshold) clicks++;
  assert.equal(clicks, 0, `${clicks} isolated jumps above 40x median step`);
  // The sustain must actually keep sounding, not decay to silence.
  const tailPeak = Math.max(...r.pcm.slice(Math.floor(4 * SR), Math.floor(4.9 * SR)).map(Math.abs));
  assert.ok(tailPeak > 0.01, `sustain died out (tail peak ${tailPeak})`);
});

test('rapid repeats of the same note allocate one voice per attack and stay under cap', () => {
  const events = [];
  for (let i = 0; i < 16; i++) {
    events.push({ type: 'on', note: 67, velocity: 100, time: 0.02 + i * 0.05 });
    events.push({ type: 'off', note: 67, time: 0.02 + i * 0.05 + 0.035 });
  }
  const r = new OfflineRenderer(instrument, pcm, { maxVoices: 12 }).render(events, { seconds: 2.5 });
  const ons = r.voiceLog.filter((l) => l.kind === 'noteOn');
  assert.equal(ons.length, 16);
  assert.ok(r.maxActive <= 12, `active ${r.maxActive} exceeded cap 12`);
  assert.ok(r.maxActive >= 3, `expected overlapping repeats, got max ${r.maxActive}`);
  // Every attack used exactly the C5 zone sample for velocity 100 (hard).
  for (const on of ons) assert.deepEqual(on.samples, ['c5-hard']);
});

test('same-note repeats are independent voices sharing one cached sample', () => {
  const r = render([
    { type: 'on', note: 67, velocity: 100, time: 0.02 },
    { type: 'on', note: 67, velocity: 100, time: 0.10 },
    { type: 'on', note: 67, velocity: 100, time: 0.18 },
  ], { seconds: 1.5 });
  const ons = r.voiceLog.filter((l) => l.kind === 'noteOn');
  assert.equal(ons.length, 3);
  assert.equal(new Set(ons.map((o) => o.id)).size, 3);
  assert.equal(r.maxActive, 3);
  // Three voices, one pinned recording: pin count must reflect all users.
  assert.equal(r.cache.entries.get('c5-hard').pins, 3);
});

// ---------------------------------------------------------------------------
// Sustain pedal, key instances and read-head ownership
// ---------------------------------------------------------------------------

test('note-off follows the key instance, not the pitch: an old release never kills a retrigger', () => {
  // Two presses of one pitch, each with its own instance tag. The first press
  // is released while the second is still down: the old release must end only
  // its own instance.
  const r = render([
    { type: 'on', note: 60, velocity: 40, time: 0.02, tag: 1 },
    { type: 'on', note: 60, velocity: 110, time: 0.12, tag: 2 },
    { type: 'off', note: 60, time: 0.20, tag: 1 },
  ], { seconds: 1.2 });
  const ons = r.voiceLog.filter((l) => l.kind === 'noteOn');
  assert.equal(ons.length, 2);
  const [first, second] = ons;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.instance, second.instance);
  // Only the first instance was released; the second stays held.
  const offs = r.voiceLog.filter((l) => l.kind === 'noteOff');
  assert.equal(offs.length, 1);
  assert.equal(offs[0].id, first.id);
  assert.ok(r.voiceManager.voices.has(second.id), 'retriggered voice must remain held');
  assert.equal(r.voiceManager.voices.get(second.id).state, 'held');
});

test('pedal owns already-released instances as a set and survives until pedal-up', () => {
  const vm = new VoiceManager(instrument, new SampleCache(instrument, { cacheBytes: residentBytes(instrument) }));
  for (const rec of manifest.notes) vm.cache.put(rec.name, pcm.get(rec.name));
  const first = vm.noteOn(60, 40, 0).voice;
  vm.pedalDown(0.01);
  assert.equal(vm.noteOffVoice(first, 0.05), true);
  assert.equal(first.state, 'sustained', 'released key under pedal is pedal-owned');
  assert.equal(vm.sustainedCount(), 1);
  // A second press on the same pitch is a different instance and remains held.
  const second = vm.noteOn(60, 110, 0.1).voice;
  assert.equal(second.state, 'held');
  assert.notEqual(second.instance, first.instance);
  // Pedal-up releases the pedal-owned set, not the held key.
  vm.pedalUp(0.2);
  assert.equal(first.state, 'release');
  assert.equal(second.state, 'held');
});

test('a key still held at pedal-up is not pedal-owned and stays sounding', () => {
  const vm = new VoiceManager(instrument, new SampleCache(instrument, { cacheBytes: residentBytes(instrument) }));
  for (const rec of manifest.notes) vm.cache.put(rec.name, pcm.get(rec.name));
  const held = vm.noteOn(60, 110, 0).voice;
  vm.pedalDown(0.01);
  const released = vm.noteOn(64, 40, 0.02).voice;
  vm.noteOffVoice(released, 0.05);
  assert.equal(released.state, 'sustained');
  vm.pedalUp(0.1);
  assert.equal(released.state, 'release');
  assert.equal(held.state, 'held', 'a physically-held key must survive pedal-up');
});

test('pedal retrigger: soft then hard on one pitch, each attack and tail audible, refs return cleanly', () => {
  const softSel = selectSample(instrument, 60, 40);
  const hardSel = selectSample(instrument, 60, 110);
  assert.notEqual(softSel.entries[0].sample.name, hardSel.entries[0].sample.name);
  const r = render([
    { type: 'pedal', down: true, time: 0.02 },
    { type: 'on', note: 60, velocity: 40, time: 0.05, tag: 'soft' },
    { type: 'on', note: 60, velocity: 110, time: 0.28, tag: 'hard' },
    { type: 'off', note: 60, time: 0.34, tag: 'soft' },
    { type: 'pedal', down: false, time: 0.55 },
    { type: 'off', note: 60, time: 0.80, tag: 'hard' },
  ], { seconds: 1.6 });
  const ons = r.voiceLog.filter((l) => l.kind === 'noteOn');
  const softOn = ons.find((l) => l.tag === 'soft');
  const hardOn = ons.find((l) => l.tag === 'hard');
  // Both attacks exist and use different recordings and read heads.
  assert.ok(softOn && hardOn);
  assert.notEqual(softOn.id, hardOn.id);
  assert.notEqual(softOn.head, hardOn.head);
  // The soft instance goes to the pedal at key-up, the hard instance does not.
  assert.ok(r.voiceLog.some((l) => l.kind === 'pedalHold' && l.id === softOn.id));
  assert.ok(!r.voiceLog.some((l) => l.kind === 'noteOff' && l.id === hardOn.id && l.time < 0.79));
  assert.ok(r.voiceLog.some((l) => l.kind === 'pedalUpRelease' && l.id === softOn.id));
  // Measure each attack and each release tail independently in the mix.
  const peak = (t, d) => {
    let p = 0;
    const a = Math.floor(t * SR);
    const b = Math.min(r.pcm.length, Math.floor((t + d) * SR));
    for (let i = a; i < b; i++) p = Math.max(p, Math.abs(r.pcm[i]));
    return p;
  };
  assert.ok(peak(0.06, 0.06) > 0.01, 'soft attack must be audible');
  assert.ok(peak(0.29, 0.06) > 0.01, 'hard attack must be audible');
  assert.ok(peak(0.57, 0.16) > 0.005, 'soft pedal tail must be audible after pedal-up');
  assert.ok(peak(0.82, 0.16) > 0.005, 'hard release tail must be audible');
  // Read heads: the soft head releases at pedal-up, not at its key-up.
  const softHead = r.heads.find((h) => h.head === softOn.head);
  const hardHead = r.heads.find((h) => h.head === hardOn.head);
  assert.ok(Math.abs(softHead.releaseAt - 0.55) < 1e-6, `soft head released at ${softHead.releaseAt}`);
  assert.ok(softHead.end >= hardHead.start, 'soft pedal tail overlaps the hard attack');
  // No recording was freed while a read head still used it.
  const audit = (key) => {
    const zero = r.pinTrace.find((e) => e.key === key && e.pins === 0);
    assert.ok(zero, `${key} must be unpinned`);
    const busy = r.heads.some(
      (h) => h.layer.split('+').includes(key) && h.start < zero.time - 1e-9 && h.end > zero.time + 1e-9,
    );
    assert.equal(busy, false, `${key} freed at ${zero.time} while a head still read it`);
  };
  audit(softSel.entries[0].sample.name);
  audit(hardSel.entries[0].sample.name);
  assert.equal(r.cache.refs(softSel.entries[0].sample.name), 0);
  assert.equal(r.cache.refs(hardSel.entries[0].sample.name), 0);
});

test('one free voice: stealing a pedal tail frees the old head only after its fade', () => {
  const oldKey = selectSample(instrument, 60, 40).entries[0].sample.name;
  const newKey = selectSample(instrument, 60, 110).entries[0].sample.name;
  const r = new OfflineRenderer(instrument, pcm, { maxVoices: 1 }).render([
    { type: 'pedal', down: true, time: 0.02 },
    { type: 'on', note: 60, velocity: 40, time: 0.05, tag: 'old' },
    { type: 'off', note: 60, time: 0.20, tag: 'old' },
    { type: 'on', note: 60, velocity: 110, time: 0.30, tag: 'new' },
    { type: 'pedal', down: false, time: 0.60 },
    { type: 'off', note: 60, time: 0.75, tag: 'new' },
  ], { seconds: 1.4 });
  assert.equal(r.maxActive, 1);
  assert.ok(r.voiceManager.steals >= 1);
  const newOn = r.voiceLog.find((l) => l.kind === 'noteOn' && l.tag === 'new');
  const oldHead = r.heads.find((h) => h.velocity === 40);
  const newHead = r.heads.find((h) => h.head === newOn.head);
  // The new attack is alive at its onset; the old head fades within the steal
  // tail and does not keep a voice forever.
  assert.ok(newHead.start <= 0.31 && newHead.end > 0.31);
  assert.ok(oldHead.stolenAt !== null, 'old pedal tail must be interrupted');
  const fade = oldHead.end - oldHead.stolenAt;
  assert.ok(fade <= instrument.cfg.stealReleaseMs / 1000 + 0.01, `old tail faded in ${fade}s`);
  // The old recording is released exactly when its head ends, and the new one
  // stays pinned until its own release tail ends.
  const zeroOld = r.pinTrace.filter((e) => e.key === oldKey && e.pins === 0).pop();
  assert.ok(zeroOld);
  assert.ok(Math.abs(zeroOld.time - oldHead.end) < 0.02, `old unpinned at ${zeroOld.time}, head ended ${oldHead.end}`);
  assert.equal(r.cache.refs(oldKey), 0, 'old sample refcount must return to zero');
  assert.equal(r.cache.refs(newKey), 0, 'new sample refcount must return to zero after its release');
});

test('one free voice: a pedal tail that finished first needs no steal and frees both recordings once', () => {
  const releaseSec = instrument.cfg.releaseMs / 1000;
  const tPedalUp = 0.30;
  const tNew = tPedalUp + releaseSec + 0.07;
  const r = new OfflineRenderer(instrument, pcm, { maxVoices: 1 }).render([
    { type: 'pedal', down: true, time: 0.02 },
    { type: 'on', note: 60, velocity: 40, time: 0.05, tag: 'old' },
    { type: 'off', note: 60, time: 0.20, tag: 'old' },
    { type: 'pedal', down: false, time: tPedalUp },
    { type: 'on', note: 60, velocity: 110, time: tNew, tag: 'new' },
    { type: 'off', note: 60, time: tNew + 0.25, tag: 'new' },
  ], { seconds: 1.6 });
  assert.equal(r.voiceManager.steals, 0);
  assert.equal(r.maxActive, 1);
  const ons = r.voiceLog.filter((l) => l.kind === 'noteOn');
  assert.equal(ons.length, 2);
  const oldHead = r.heads.find((h) => h.velocity === 40);
  const newHead = r.heads.find((h) => h.velocity === 110);
  assert.ok(oldHead.end <= newHead.start + 1e-6, 'old head must end before the new one starts');
  for (const key of [
    selectSample(instrument, 60, 40).entries[0].sample.name,
    selectSample(instrument, 60, 110).entries[0].sample.name,
  ]) {
    assert.equal(r.cache.refs(key), 0, `${key} refs must return to zero`);
    const zero = r.pinTrace.find((e) => e.key === key && e.pins === 0);
    const busy = r.heads.some(
      (h) => h.layer.split('+').includes(key) && h.start < zero.time - 1e-9 && h.end > zero.time + 1e-9,
    );
    assert.equal(busy, false, `${key} freed while still read`);
  }
});


test('voice steal holds the cap and prefers releasing voices', () => {
  const cap = 8;
  const events = [];
  for (let i = 0; i < cap + 6; i++) events.push({ type: 'on', note: 40 + i * 3, velocity: 100, time: 0.02 + i * 0.01 });
  for (let i = 0; i < 4; i++) events.push({ type: 'off', note: 40 + i * 3, time: 0.2 + i * 0.01 });
  for (let i = 0; i < 6; i++) events.push({ type: 'on', note: 100 - i, velocity: 100, time: 0.3 + i * 0.01 });
  const r = new OfflineRenderer(instrument, pcm, { maxVoices: cap }).render(events, { seconds: 2 });
  assert.equal(r.maxActive, cap, `active peaked at ${r.maxActive}, cap ${cap}`);
  assert.ok(r.voiceManager.steals >= 6, `expected steals, got ${r.voiceManager.steals}`);
  const stealLogs = r.voiceLog.filter((l) => l.kind === 'steal');
  assert.ok(stealLogs.length >= 6);
  // Stolen voices keep a fade tail, so audible count may exceed the cap by design.
  assert.ok(r.maxAudible >= cap);
});

test('cache rejects a budget smaller than one recording with a clear code', () => {
  const cache = new SampleCache(instrument, { cacheBytes: 512 });
  const err = captureThrow(() => cache.put('c2-soft', pcm.get('c2-soft')));
  assert.ok(err instanceof SamplerError, `expected SamplerError, got ${err}`);
  assert.equal(err.code, 'CACHE_TOO_SMALL');
  assert.match(err.message, /larger than the whole cache budget/);
});

test('cache evicts LRU unpinned entries and stays within budget', () => {
  const budget = sampleBytes(manifest.notes[0]) + Math.floor(sampleBytes(manifest.notes[1]) * 1.5);
  const cache = new SampleCache(instrument, { cacheBytes: budget });
  for (const rec of manifest.notes) cache.put(rec.name, pcm.get(rec.name));
  assert.ok(cache.evictions > 0, 'expected eviction');
  assert.ok(cache.usedBytes <= budget);
  assert.ok(cache.peakBytes <= budget);
});

test('cache never evicts a sample a voice is using', () => {
  const bySize = [...manifest.notes].sort((a, b) => sampleBytes(b) - sampleBytes(a));
  const pair = [bySize[0], bySize[1]];
  const third = manifest.notes.find((r) => !pair.includes(r));
  const cache = new SampleCache(instrument, { cacheBytes: sampleBytes(pair[0]) + sampleBytes(pair[1]) });
  cache.put(pair[0].name, pcm.get(pair[0].name));
  cache.put(pair[1].name, pcm.get(pair[1].name));
  cache.pin(pair[0].name);
  cache.pin(pair[1].name);
  const err = captureThrow(() => cache.put(third.name, pcm.get(third.name)));
  assert.ok(err instanceof SamplerError);
  assert.equal(err.code, 'CACHE_PINNED_FULL');
  assert.ok(cache.has(pair[0].name) && cache.has(pair[1].name), 'pinned samples must remain resident');
  cache.unpin(pair[0].name);
  // With one pin released, that unpinned recording may be evicted to make
  // room, but the still-pinned pair[1] must survive.
  cache.put(third.name, pcm.get(third.name));
  assert.ok(cache.has(third.name));
  assert.ok(cache.has(pair[1].name), 'still-pinned sample must survive');
  assert.equal(cache.has(pair[0].name), false, 'unpinned LRU entry is evictable');
});

test('voice lifecycle pins then unpins cache entries', () => {
  const cache = new SampleCache(instrument, { cacheBytes: residentBytes(instrument) });
  for (const rec of manifest.notes) cache.put(rec.name, pcm.get(rec.name));
  const vm = new VoiceManager(instrument, cache);
  const res = vm.noteOn(60, 100, 0);
  const key = res.plan.entries[0].sample.name;
  assert.equal(cache.entries.get(key).pins, 1);
  vm.noteOff(60, 0.3);
  vm.tick(1.0);
  assert.equal(cache.entries.get(key).pins, 0);
  assert.equal(vm.activeCount(), 0);
});

test('voice rejected for missing cache leaves no half-initialised voice', () => {
  const cache = new SampleCache(instrument, { cacheBytes: residentBytes(instrument) });
  const vm = new VoiceManager(instrument, cache);
  const err = captureThrow(() => vm.noteOn(60, 100, 0));
  assert.equal(err.code, 'CACHE_MISS');
  assert.equal(vm.activeCount(), 0);
  assert.equal(vm.rejections, 1);
});

test('invalid velocity and midi raise typed errors', () => {
  assert.equal(captureThrow(() => selectSample(instrument, 60, 0)).code, 'VELOCITY_RANGE');
  assert.equal(captureThrow(() => selectSample(instrument, 128, 60)).code, 'MIDI_RANGE');
  assert.equal(captureThrow(() => buildInstrument(manifest, { velocityBlendLo: 90, velocityBlendHi: 90 })).code, 'VELOCITY_BLEND_BAND');
  assert.equal(captureThrow(() => buildInstrument(manifest, { maxVoices: 0 })).code, 'VOICE_LIMIT_RANGE');
});
