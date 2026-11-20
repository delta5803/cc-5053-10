// Live performance engine: Web Audio graph per voice, driven by the shared
// selection / voice rules in engine.js. One AudioBufferSourceNode (loop points,
// playbackRate = zone resampling) -> per-layer GainNode for velocity mix ->
// envelope GainNode (attack/release) -> master.
import {
  SampleCache,
  VoiceManager,
  buildInstrument,
  selectSample,
  describeKeyMap,
  noteName,
  midiToHz,
  sampleBytes,
  SamplerError,
} from './engine.js';
import { decodeWav } from './wav.js';

export class LiveEngine {
  constructor({ onError = null, onEvent = null } = {}) {
    this.onError = onError;
    this.onEvent = onEvent;
    this.ctx = null;
    this.instrument = null;
    this.cache = null;
    this.vm = null;
    this.buffers = new Map();
    this.graphs = new Map();
    this.master = null;
    this.limiter = null;
    this.nextVoiceId = 1;
    this.ticks = [];
    this.status = { state: 'idle', message: 'Not started' };
    this.peak = 0;
    this.peakAt = 0;
  }

  async init({ manifestUrl = '/assets/samples/recordings.json', baseUrl = '/assets/samples/', options = {} } = {}) {
    this.setStatus('loading', 'Fetching recordings');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new SamplerError('NO_WEBAUDIO', 'This browser has no Web Audio support');
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.9;
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.master.connect(this.limiter).connect(this.analyser).connect(this.ctx.destination);
    this._levelBuf = new Float32Array(this.analyser.fftSize);

    const manifest = await fetchJson(manifestUrl);
    this.instrument = buildInstrument(manifest, options);
    this.cache = new SampleCache(this.instrument, { onEvent: (e) => this._cacheEvent(e) });
    this.vm = new VoiceManager(this.instrument, this.cache);
    await this._preload(baseUrl);

    this.setStatus('ready', `Ready at ${this.ctx.sampleRate} Hz`);
    return { keymap: describeKeyMap(this.instrument), summary: this.summary() };
  }

  setStatus(state, message) {
    this.status = { state, message, at: Date.now() };
    this.onEvent?.({ type: 'status', state, message });
  }

  _cacheEvent(e) {
    if (this.onEvent) this.onEvent({ type: 'cache', ...e });
  }

  async _preload(baseUrl) {
    for (const z of this.instrument.zones) {
      for (const layer of ['soft', 'hard']) {
        const rec = z.samples[layer];
        const res = await fetch(baseUrl + rec.file);
        if (!res.ok) {
          throw new SamplerError('SAMPLE_FETCH', `Could not fetch ${rec.file} (HTTP ${res.status})`, 'Check the samples directory is served');
        }
        const buf = await res.arrayBuffer();
        const wav = decodeWav(buf);
        if (wav.sampleRate !== rec.sampleRate || wav.frames !== rec.frames) {
          throw new SamplerError(
            'SAMPLE_MISMATCH',
            `${rec.file} decoded to ${wav.frames} frames @ ${wav.sampleRate} Hz but the manifest says ` +
              `${rec.frames} @ ${rec.sampleRate} Hz`,
            'Regenerate the recordings manifest',
          );
        }
        // Store the decoded PCM in the bounded cache (4 bytes/frame). The
        // browser AudioBuffer is created lazily only for buffers a voice uses.
        this.cache.put(rec.name, wav.pcm);
        this.buffers.set(rec.name, this._toAudioBuffer(wav));
      }
    }
    const resident = this.cache.usedBytes;
    if (resident > this.cache.budget) {
      throw new SamplerError('CACHE_BUDGET', 'Preload exceeded cache budget');
    }
  }

  _toAudioBuffer(wav) {
    const buf = this.ctx.createBuffer(1, wav.frames, wav.sampleRate);
    buf.copyToChannel(wav.pcm, 0);
    return buf;
  }

  async resume() {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.setStatus('running', `Audio clock ${this.ctx.currentTime.toFixed(2)} s, ${this.ctx.state}`);
  }

  summary() {
    const resident = [...this.buffers.values()].reduce((s, b) => s + b.length * 4, 0);
    return {
      sampleRate: this.ctx?.sampleRate ?? null,
      sourceSampleRate: this.instrument.manifest.sampleRate,
      zones: this.instrument.zones.length,
      recordings: this.instrument.manifest.notes.length,
      residentBytes: resident,
      cacheBudget: this.cache.budget,
      maxVoices: this.vm.cfg.maxVoices,
      latencyHint: this.ctx?.baseLatency ?? null,
      keymap: describeKeyMap(this.instrument),
    };
  }

  // ---- performance ----------------------------------------------------------

  noteOn(note, velocity, source = 'ui') {
    if (!this.ctx) throw new SamplerError('NOT_READY', 'Engine not initialised');
    const plan = selectSample(this.instrument, note, velocity);
    const now = this.ctx.currentTime;
    const t0 = Math.max(now, (this._lastT ?? now) + 0.001);
    this._lastT = t0;
    // Pin resources first through the shared voice manager, so accounting and
    // error handling match the offline path exactly.
    const res = this.vm.noteOn(note, velocity, t0, plan);
    if (res.stolen) {
      const g = this.graphs.get(res.stolen.id);
      if (g) this._startStealTail(g, t0);
    }
    const voice = res.voice;
    const cfg = this.vm.cfg;
    const out = this.ctx.createGain();
    out.gain.value = 0;
    out.connect(this.master);
    const layerNodes = [];
    const sources = [];
    for (const ent of plan.entries) {
      const buffer = this.buffers.get(ent.sample.name);
      if (!buffer) {
        // The buffer should always be preloaded; if not, fail loudly rather
        // than playing the wrong recording.
        this.vm._finish(voice);
        throw new SamplerError('BUFFER_MISSING', `AudioBuffer for ${ent.sample.name} was not preloaded`);
      }
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.setValueAtTime(ent.rate, t0);
      src.loop = !!ent.loop;
      if (ent.loop) {
        src.loopStart = ent.loop.start / buffer.sampleRate;
        src.loopEnd = ent.loop.end / buffer.sampleRate;
      }
      const lg = this.ctx.createGain();
      lg.gain.setValueAtTime(ent.gain, t0);
      src.connect(lg).connect(out);
      sources.push(src);
      layerNodes.push({ node: lg, entry: ent });
    }
    // Attack ramp, then a small sustain trim so the tail is not static.
    const attack = Math.max(0.001, cfg.attackMs / 1000);
    out.gain.setValueAtTime(0, t0);
    out.gain.linearRampToValueAtTime(1, t0 + attack);

    const graph = {
      id: voice.id,
      instance: voice.instance,
      head: voice.headId,
      note,
      velocity,
      plan,
      t0,
      out,
      sources,
      layerNodes,
      state: 'held',
      pedalHeld: false,
      startWall: performance.now(),
      source,
      ended: false,
    };
    for (const src of sources) src.start(t0);
    // One-shot sources end on their own; releasing the voice must also handle
    // the looping ones (they are stopped in noteOff).
    this.graphs.set(voice.id, graph);
    this._pushTick({
      kind: 'noteOn',
      note,
      noteName: noteName(note),
      velocity,
      zone: plan.zone.rootMidi,
      rate: plan.rate,
      layers: plan.entries.map((e) => ({ layer: e.layer, sample: e.sample.name, gain: +e.gain.toFixed(4) })),
      mix: plan.mix.kind,
      voiceId: voice.id,
      instance: voice.instance,
      head: voice.headId,
      audioTime: +t0.toFixed(4),
      wall: performance.now(),
      activeVoices: this.vm.activeCount(),
      source,
    });
    this.onEvent?.({ type: 'voiceStart', voice: this._voiceView(voice) });
    return { plan, voice: this._voiceView(voice), audioTime: t0 };
  }

  // Release one key *instance*, never "every voice on this pitch". If the same
  // pitch was retriggered while this key was down, the newer instance keeps
  // sounding. `voiceId` comes from noteOn; a bare pitch falls back to the
  // newest still-held instance of that pitch (test hooks and the UI's release
  // path both know the note they pressed).
  noteOff(note, voiceId = null) {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    let target = null;
    if (voiceId !== null) {
      // An explicit instance id is authoritative: if it has already finished,
      // nothing is released. Falling back to another voice of the same pitch
      // would let a stale key-up silence a newer press.
      target = this.vm.voices.get(voiceId) ?? null;
      if (!target || target.note !== note) return 0;
    } else {
      for (const v of this.vm.voices.values()) {
        if (v.note !== note || !v.keyDown) continue;
        if (!target || v.order > target.order) target = v;
      }
    }
    if (!target) return 0;
    this.vm.noteOffVoice(target, now, 'noteOff');
    const g = this.graphs.get(target.id);
    if (g) {
      if (target.state === 'sustained') {
        // Pedal owns this sound now: keep the graph running. The note's key is
        // up, but the buffer keeps reading until pedal-up (or a steal).
        g.state = 'sustained';
        g.pedalHeld = true;
      } else {
        this._releaseGraph(g, now);
      }
    }
    this._pushTick({
      kind: 'noteOff',
      voiceId: target.id,
      instance: target.instance,
      head: target.headId,
      note,
      noteName: noteName(note),
      audioTime: +now.toFixed(4),
      wall: performance.now(),
      pedal: this.vm.pedal,
      activeVoices: this.vm.activeCount(),
    });
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot() });
    return 1;
  }

  pedalDown() {
    if (!this.ctx) return 0;
    this.vm.pedalDown(this.ctx.currentTime);
    this._pushTick({ kind: 'pedalDown', note: 0, noteName: '—', audioTime: +this.ctx.currentTime.toFixed(4), wall: performance.now(), activeVoices: this.vm.activeCount() });
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot() });
    return this.vm.sustainedCount();
  }

  // Pedal-up releases every pedal-owned instance. A key still physically down
  // is not pedal-owned, so it survives pedal-up and releases on its own key-up.
  pedalUp() {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    const count = this.vm.pedalUp(now);
    for (const g of this.graphs.values()) {
      if (!g.pedalHeld || g.state !== 'sustained') continue;
      g.pedalHeld = false;
      this._releaseGraph(g, now);
    }
    this._pushTick({ kind: 'pedalUp', note: 0, noteName: '—', audioTime: +now.toFixed(4), wall: performance.now(), released: count, activeVoices: this.vm.activeCount() });
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot() });
    return count;
  }

  _releaseGraph(g, now) {
    const cfg = this.vm.cfg;
    const rel = Math.max(0.005, cfg.releaseMs / 1000);
    g.state = 'release';
    g.out.gain.cancelScheduledValues(now);
    // Honour the current gain so a fast release does not click upward.
    const current = g.out.gain.value;
    g.out.gain.setValueAtTime(current, now);
    g.out.gain.linearRampToValueAtTime(0, now + rel);
    for (const src of g.sources) {
      try { src.stop(now + rel + 0.01); } catch { /* already stopped */ }
    }
    g.stopAt = now + rel + 0.02;
    this._pushTick({
      kind: 'noteOff',
      voiceId: g.id,
      instance: g.instance,
      head: g.head,
      note: g.note,
      noteName: noteName(g.note),
      audioTime: +now.toFixed(4),
      wall: performance.now(),
      activeVoices: this.vm.activeCount(),
    });
  }

  _startStealTail(g, now) {
    if (g.state === 'stealing') return;
    const sec = Math.max(0.003, this.vm.cfg.stealReleaseMs / 1000);
    g.state = 'stealing';
    g.pedalHeld = false;
    try { g.out.gain.cancelScheduledValues(now); } catch { /* noop */ }
    const current = Math.max(0.0001, g.out.gain.value);
    g.out.gain.setValueAtTime(current, now);
    g.out.gain.linearRampToValueAtTime(0, now + sec);
    for (const src of g.sources) {
      try { src.stop(now + sec + 0.01); } catch { /* already stopped */ }
    }
    g.stopAt = now + sec + 0.02;
    this._pushTick({
      kind: 'steal',
      voiceId: g.id,
      instance: g.instance,
      head: g.head,
      note: g.note,
      noteName: noteName(g.note),
      audioTime: +now.toFixed(4),
      wall: performance.now(),
      activeVoices: this.vm.activeCount(),
    });
  }

  _voiceView(v) {
    return {
      id: v.id,
      instance: v.instance,
      head: v.headId,
      note: v.note,
      noteName: noteName(v.note),
      velocity: v.velocity,
      zone: v.plan.zone.rootMidi,
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
        loop: e.loop,
      })),
      state: v.state,
      keyDown: v.keyDown,
      pedalHeld: v.state === 'sustained',
      startTime: v.startTime,
    };
  }

  _pushTick(t) {
    this.ticks.push(t);
    if (this.ticks.length > 120) this.ticks.shift();
    this.onEvent?.({ type: 'tick', tick: t });
  }

  // Called on animation frames: sweep finished graphs, trim the logical voice
  // table, refresh the meter.
  sweep() {
    if (!this.ctx) return null;
    const now = this.ctx.currentTime;
    this.vm.tick(now);
    // Retire graphs the voice manager has already finished (released voices and
    // expired steal tails) so their sample read heads are handed back exactly
    // once, at the same moment the cache pin is dropped.
    for (const [id, g] of [...this.graphs]) {
      if (g.stopAt !== undefined && now >= g.stopAt) {
        g.out.disconnect();
        for (const lg of g.layerNodes) lg.node.disconnect();
        this.graphs.delete(id);
        continue;
      }
      if (!this.vm.voices.has(id) && !this.vm.tails.has(id)) {
        try { g.out.gain.cancelScheduledValues(now); g.out.gain.setValueAtTime(0, now); } catch { /* noop */ }
        for (const src of g.sources) { try { src.stop(now); } catch { /* already stopped */ } }
        g.out.disconnect();
        for (const lg of g.layerNodes) lg.node.disconnect();
        this.graphs.delete(id);
      }
    }
    const snap = this.vm.snapshot();
    const meters = this._meters();
    this.onEvent?.({ type: 'voices', snapshot: snap, meters });
    return { snapshot: snap, meters };
  }

  _meters() {
    let voices = 0;
    let held = 0;
    let sustained = 0;
    for (const g of this.graphs.values()) {
      if (g.state === 'held' || g.state === 'release' || g.state === 'stealing' || g.state === 'sustained') voices++;
      if (g.state === 'held') held++;
      if (g.state === 'sustained') sustained++;
    }
    return {
      graphVoices: voices,
      logicalVoices: this.vm.activeCount(),
      heldVoices: held,
      sustainedVoices: sustained,
      pedal: this.vm.pedal,
      tails: this.vm.tails.size,
      cacheUsed: this.cache.usedBytes,
      cacheBudget: this.cache.budget,
      cacheEntries: this.cache.entries.size,
      evictions: this.cache.evictions,
      steals: this.vm.steals,
      contextState: this.ctx.state,
      audioTime: this.ctx.currentTime,
      level: this._readLevel(),
      peakLevel: this.peakLevel ?? 0,
    };
  }

  _readLevel() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this._levelBuf);
    let sum = 0;
    for (const v of this._levelBuf) sum += v * v;
    const rms = Math.sqrt(sum / this._levelBuf.length);
    this.peakLevel = Math.max(this.peakLevel ?? 0, rms);
    return rms;
  }

  setMaxVoices(n) {
    if (!this.vm) return;
    if (!(n >= 1 && n <= 32)) throw new SamplerError('VOICE_LIMIT_RANGE', 'Voice cap must be 1..32');
    this.vm.cfg.maxVoices = n;
    // If the new cap is below the sounding count, retire the oldest voices
    // with a short fade so the limit takes effect immediately and audibly.
    const now = this.ctx ? this.ctx.currentTime : 0;
    while (this.vm.voices.size > n) {
      let oldest = null;
      for (const v of this.vm.voices.values()) if (!oldest || v.order < oldest.order) oldest = v;
      if (!oldest) break;
      this.vm._finish(oldest);
      const g = this.graphs.get(oldest.id);
      if (g) this._startStealTail(g, now);
    }
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot(), meters: this._meters() });
  }

  setCacheBudget(bytes) {
    if (!this.cache) return;
    if (!(bytes > 0)) throw new SamplerError('CACHE_LIMIT_RANGE', 'Cache budget must be positive');
    this.cache.budget = bytes;
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot(), meters: this._meters() });
  }

  panic() {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const g of this.graphs.values()) {
      try { g.out.gain.cancelScheduledValues(now); g.out.gain.setValueAtTime(0, now); } catch { /* noop */ }
      for (const src of g.sources) { try { src.stop(now); } catch { /* noop */ } }
      g.stopAt = now;
    }
    for (const v of [...this.vm.voices.values()]) this.vm._finish(v, now);
    for (const [id, tail] of [...this.vm.tails]) {
      for (const key of tail.keys) this.cache.unpin(key);
      this.vm.tails.delete(id);
    }
    this.vm.pedal = false;
    this.vm.steals = 0;
    this.vm.rejections = 0;
    this.ticks = [];
    this.onEvent?.({ type: 'voices', snapshot: this.vm.snapshot(), meters: this._meters() });
    this._pushTick({ kind: 'panic', note: 0, noteName: '—', audioTime: +now.toFixed(4), wall: performance.now(), activeVoices: 0 });
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new SamplerError('MANIFEST_FETCH', `Could not fetch ${url} (HTTP ${res.status})`, 'Serve the project root, e.g. `npm start`');
  }
  return res.json();
}

export { noteName, midiToHz, sampleBytes };
