// Performance GUI. All audible decisions come from LiveEngine (which shares
// src/engine.js with the offline report); this file only renders state.
import { LiveEngine } from '../src/live.js';
import { analyzeLoop, noteName, DEFAULTS, SampleCache } from '../src/engine.js';
import { decodeWav } from '../src/wav.js';

const $ = (id) => document.getElementById(id);

const state = {
  engine: null,
  keymap: [],
  // Pitch -> live key instance. An instance is a distinct press; its id is
  // what note-off must release, so a retrigger of the same pitch can never be
  // silenced by the previous press's key-up.
  active: new Map(),
  heldNotes: new Set(),
  legs: new Map(), // note -> release timer
  nextInstance: 1,
  pedal: false,
  velocity: 96,
  legatoMs: 70,
  latched: false,
  highlight: 60,
  manifesto: null,
  loopsChecked: false,
  offline: null,
  errorSeq: 0,
};

const UA = {
  velocity: $('velocity'),
  velOut: $('velOut'),
  legato: $('legato'),
  legatoOut: $('legatoOut'),
  latched: $('latched'),
  pedalBtn: $('pedalBtn'),
  keyInstances: $('keyInstances'),
  voiceLimit: $('voiceLimit'),
  capOut: $('capOut'),
  startBtn: $('startBtn'),
  panicBtn: $('panicBtn'),
  status: $('status'),
  keys: $('keys'),
  voiceStrip: $('voiceStrip'),
  voiceCount: $('voiceCount'),
  voiceCap: $('voiceCap'),
  lastEvent: $('lastEvent'),
  resultTag: $('resultTag'),
  voiceTable: $('voiceTable'),
  cacheBar: $('cacheBar'),
  cacheText: $('cacheText'),
  audibleText: $('audibleText'),
  stealText: $('stealText'),
  levelBar: $('levelBar'),
  levelText: $('levelText'),
  zoneTable: $('zoneTable'),
  velocityTable: $('velocityTable'),
  loopTable: $('loopTable'),
  loopBtn: $('loopBtn'),
  errors: $('errors'),
  offlineSummary: $('offlineSummary'),
  offlineBtn: $('offlineBtn'),
};

// The visual keyboard spans C2..C7 (MIDI 36..96).
const LOW = 36;
const HIGH = 96;

function isBlack(n) {
  return [1, 3, 6, 8, 10].includes(((n % 12) + 12) % 12);
}

function buildKeyboard() {
  const whites = [];
  const blacks = [];
  for (let n = LOW; n <= HIGH; n++) (isBlack(n) ? blacks : whites).push(n);
  const whiteW = 100 / whites.length;
  const whiteIndex = new Map(whites.map((n, i) => [n, i]));
  const frag = document.createDocumentFragment();
  for (const n of whites) {
    const el = document.createElement('div');
    el.className = 'key white';
    el.dataset.note = n;
    const i = whiteIndex.get(n);
    el.style.left = `${i * whiteW}%`;
    el.style.width = `calc(${whiteW}% - 2px)`;
    el.style.marginLeft = '1px';
    el.innerHTML = `<span class="lbl">${noteName(n)}</span>`;
    frag.appendChild(el);
  }
  for (const n of blacks) {
    // Black keys sit between the surrounding white keys.
    const leftWhite = n - 1;
    const i = whiteIndex.get(leftWhite);
    if (i === undefined) continue;
    const w = whiteW;
    const el = document.createElement('div');
    el.className = 'key black';
    el.dataset.note = n;
    el.style.left = `calc(${(i + 1) * w}% - ${w * 0.3}%)`;
    el.style.width = `${w * 0.6}%`;
    el.innerHTML = `<span class="lbl"></span>`;
    frag.appendChild(el);
  }
  UA.keys.appendChild(frag);
  // Zone bands on root keys.
  for (const z of state.keymap) {
    const el = UA.keys.querySelector(`[data-note="${z.rootMidi}"]`);
    if (el) {
      el.insertAdjacentHTML('afterbegin', `<span class="zoneband"></span><span class="zlabel">${z.root}</span>`);
    }
  }
}

function paintKey(note, on, velocity) {
  const el = UA.keys.querySelector(`[data-note="${note}"]`);
  if (!el) return;
  el.classList.toggle('active', on);
  if (on) {
    const mix = velocity >= 100 ? 'hard' : velocity <= 75 ? 'soft' : 'blend';
    el.dataset.mix = mix;
    const lbl = el.querySelector('.lbl');
    if (lbl) lbl.textContent = `${noteName(note)} · v${velocity}`;
  } else {
    const lbl = el.querySelector('.lbl');
    if (lbl) lbl.textContent = noteName(note);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function showError(err) {
  const box = document.createElement('div');
  box.className = 'error';
  box.dataset.code = err.code ?? 'ERROR';
  const id = `err-${++state.errorSeq}`;
  box.id = id;
  box.innerHTML =
    `<div><span class="ec">${escapeHtml(err.code ?? 'ERROR')}</span>${escapeHtml(err.message ?? String(err))}</div>` +
    (err.hint ? `<div class="eh">${escapeHtml(err.hint)}</div>` : '');
  UA.errors.prepend(box);
  setTimeout(() => box.remove(), 9000);
  if (state.engine) state.engine.setStatus('error', `${err.code ?? 'ERROR'}: ${err.message}`);
  setStatus('error', err.code ?? 'ERROR');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setStatus(cls, text) {
  UA.status.className = `status ${cls}`;
  UA.status.querySelector('.text').textContent = text;
}

// ---------------------------------------------------------------------------
// Render: last event, voice strip, voice table, meters
// ---------------------------------------------------------------------------

function renderLastEvent(plan, voice) {
  UA.resultTag.className = 'tag ok';
  UA.resultTag.textContent = `#${voice.id} 正在发声`;
  const layers = plan.entries
    .map((e) => `<span class="pill ${e.layer}">${e.layer} ${(e.layerWeight * 100).toFixed(0)}%</span>`)
    .join('');
  const loopText = plan.entries.map((e) =>
    e.loop ? `${e.sample.name}: ${e.loop.start}–${e.loop.end}` : `${e.sample.name}: 一次性`,
  ).join(' · ');
  UA.lastEvent.innerHTML = `
    <div class="ev-head">
      <span class="note">${noteName(plan.note)}</span>
      <span class="meta">MIDI ${plan.note} · 力度 ${plan.velocity} · 键区 ${noteName(plan.zone.rootMidi)} [${plan.zone.lo}..${plan.zone.hi}]</span>
    </div>
    <div class="ev-reason">${escapeHtml(plan.reason)}</div>
    <div class="ev-rows">
      <div class="ev-row"><span class="k">层</span><span class="v">${layers}${plan.mix.kind === 'blend' ? ` 等功率/线性交叉 ${(plan.mix.soft * 100).toFixed(0)}% ↔ ${(plan.mix.hard * 100).toFixed(0)}%` : ''}</span></div>
      <div class="ev-row"><span class="k">重采样</span><span class="v">×${plan.rate.toFixed(6)} （${plan.semitones >= 0 ? '+' : ''}${plan.semitones} 半音 / ${plan.cents.toFixed(1)} 音分）</span></div>
      <div class="ev-row"><span class="k">样本</span><span class="v">${plan.entries.map((e) => e.sample.file).join(' + ')}</span></div>
      <div class="ev-row"><span class="k">循环</span><span class="v">${loopText}</span></div>
    </div>`;
}

function mixClass(mix) {
  return mix === 'blend' ? 'blend' : mix;
}

function renderVoices(snapshot, meters) {
  if (!snapshot) return;
  UA.voiceCount.textContent = String(snapshot.activeCount);
  UA.voiceCap.textContent = String(snapshot.maxVoices);
  if (meters) {
    const pct = meters.cacheBudget ? Math.min(100, (meters.cacheUsed / meters.cacheBudget) * 100) : 0;
    UA.cacheBar.style.width = `${pct}%`;
    UA.cacheText.textContent = `${fmtBytes(meters.cacheUsed)} / ${fmtBytes(meters.cacheBudget)}`;
    UA.audibleText.textContent =
      `${meters.graphVoices} 发声 / ${meters.tails} 尾音` +
      (meters.sustainedVoices ? ` · 踏板 ${meters.sustainedVoices}` : '');
    UA.stealText.textContent = `${meters.steals} / ${snapshot.rejections}`;
    const lvl = meters.level ?? 0;
    // Map RMS to a perceptual-ish 0..100% for the bar.
    const pctLevel = Math.min(100, Math.sqrt(Math.max(0, lvl)) * 220);
    UA.levelBar.style.width = `${pctLevel}%`;
    UA.levelText.textContent = lvl > 1e-5 ? `${(20 * Math.log10(lvl)).toFixed(1)} dB` : '静音';
  }
  // Strip.
  if (snapshot.voices.length === 0) {
    UA.voiceStrip.innerHTML = `<div class="empty">当前没有发声声部</div>`;
  } else {
    UA.voiceStrip.innerHTML = snapshot.voices
      .map((v) => {
        const layers = v.layers.map((l) => `${l.layer[0].toUpperCase()}${(l.weight * 100).toFixed(0)}`).join('/');
        return `<span class="chip ${mixClass(v.mix)}" title="${escapeHtml(v.layers.map((l) => l.sample).join(' + '))}">
          <span class="cn">${v.noteName}</span>
          <span class="cs">×${v.rate.toFixed(3)}</span>
          <span class="cd">v${v.velocity} ${layers}</span>
        </span>`;
      })
      .join('');
  }
  // Table.
  if (snapshot.voices.length === 0) {
    UA.voiceTable.innerHTML = `<div class="empty">声部启用后显示：音名 / 键区 / 样本 / 层 / 重采样 / 状态</div>`;
  } else {
    UA.voiceTable.innerHTML = snapshot.voices
      .map((v) => {
        const ranges = v.layers.map((l) => `${l.sample} [${l.region ?? (l.loop ? `${l.loop.start}–${l.loop.end}` : 'one-shot')}]`).join(' + ');
        const bars = v.layers
          .map((l) => `<i class="${l.layer}" style="width:${Math.max(0, Math.min(1, l.gain / Math.max(0.001, maxGain(v)))) * 100}%"></i>`)
          .join('');
        const stateLabel = v.state === 'release' ? '释放中' : v.state === 'sustained' ? '踏板持有' : 'held';
        return `<div class="vrow ${v.state}">
          <span class="vn">${v.noteName}</span>
          <span>
            <span class="vz">zone ${noteName(v.zoneRoot)} [${v.zoneRange[0]}..${v.zoneRange[1]}] · ×${v.rate.toFixed(4)} · ${v.mix}</span>
            <div class="bar-layer">${bars}</div>
            <span class="vz" style="font-size:9.5px;color:#6b7482">${escapeHtml(ranges)}</span>
          </span>
          <span class="vs">${stateLabel}<br>v${v.velocity} · 读头 ${v.head ?? v.id}</span>
        </div>`;
      })
      .join('');
  }
}

function maxGain(v) {
  return Math.max(...v.layers.map((l) => l.gain), 0.001);
}

function fmtBytes(b) {
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} kB`;
  return `${b} B`;
}

// ---------------------------------------------------------------------------
// Zone and velocity tables
// ---------------------------------------------------------------------------

function renderZones() {
  UA.zoneTable.innerHTML = state.keymap
    .map(
      (z) => `<div class="zrow">
        <span class="zr">${z.root}</span>
        <span class="zrng">MIDI ${z.lo}..${z.hi} (${z.loName}–${z.hiName})</span>
        <span class="zrng">×${Math.pow(2, (z.lo - z.rootMidi) / 12).toFixed(2)}–${Math.pow(2, (z.hi - z.rootMidi) / 12).toFixed(2)}</span>
        <span class="zrule">${escapeHtml(z.boundaryRule)}</span>
        <span class="zfiles">${z.softFile} + ${z.hardFile}</span>
      </div>`,
    )
    .join('');
}

function rateFor(z, note) {
  return Math.pow(2, (note - z.rootMidi) / 12);
}

function instrumentBlend() {
  // Keep the displayed bands in sync with the engine's configured blend band.
  const vm = state.engine?.vm;
  return vm ? { lo: vm.cfg.velocityBlendLo, hi: vm.cfg.velocityBlendHi } : { lo: DEFAULTS.velocityBlendLo, hi: DEFAULTS.velocityBlendHi };
}

function renderVelocityTable() {
  const b = instrumentBlend();
  const bands = [
    { kind: '柔和层 soft', from: 1, to: b.lo - 1, color: 'var(--soft)' },
    { kind: '交叉淡化 blend（两层同时发声）', from: b.lo, to: b.hi - 1, color: 'linear-gradient(90deg,var(--soft),var(--hard))' },
    { kind: '明亮层 hard', from: b.hi, to: 127, color: 'var(--hard)' },
  ];
  UA.velocityTable.innerHTML = bands
    .map((bd) => {
      const w = ((bd.to - bd.from + 1) / 127) * 100;
      return `<div class="vrow-l">
        <span class="vv">${bd.from}–${bd.to}</span>
        <span class="vbar"><i style="width:${w}%;background:${bd.color}"></i></span>
        <span class="vkind">${bd.kind}</span>
      </div>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// Loop checks (uses the same analyzer as the offline report)
// ---------------------------------------------------------------------------

async function runLoopChecks() {
  try {
    const res = await fetch('/assets/samples/recordings.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    const rows = [];
    for (const rec of manifest.notes) {
      const buf = await (await fetch(`/assets/samples/${rec.file}`)).arrayBuffer();
      const wav = decodeWav(buf);
      rows.push({ rec, check: analyzeLoop(rec, wav.pcm) });
    }
    state.loopsChecked = true;
    UA.loopTable.innerHTML = rows
      .map(({ rec, check }) => {
        if (!check.checked) {
          return `<div class="loop-result"><div class="lname"><b>${rec.name}</b><span class="lok">无循环</span></div>
            <div class="lnote">一次性录音，循环时不适用</div></div>`;
        }
        return `<div class="loop-result">
          <div class="lname"><b>${rec.name}</b><span class="${check.ok ? 'lok' : 'lbad'}">${check.ok ? '通过' : '未通过'}</span></div>
          <div class="lnote">${check.start}–${check.end} (${check.frames} 帧) · 接缝 ${check.seamStepRatio.toFixed(2)}× 局部步长（限 ${check.seamLimit}×）</div>
          <div class="lnote">RMS 漂移 ${(check.rmsDrift * 100).toFixed(1)}% （限 ${(check.rmsLimit * 100).toFixed(0)}%）</div>
        </div>`;
      })
      .join('');
  } catch (err) {
    UA.loopTable.innerHTML = '';
    showError({ code: 'LOOP_CHECK', message: err.message, hint: '检查 samples 目录是否可访问' });
  }
}

// ---------------------------------------------------------------------------
// Offline report loader
// ---------------------------------------------------------------------------

async function loadOfflineReport() {
  try {
    const res = await fetch('/docs/offline/report.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rep = await res.json();
    state.offline = rep;
    const stats = [
      { l: '总判定', v: rep.pass ? 'PASS' : 'FAIL', d: rep.failures?.join(', ') || '全部通过', cls: rep.pass ? 'pass' : 'fail' },
      { l: '音高最大误差', v: `${rep.pitch.worstCents} 音分`, d: '容差 12' },
      { l: '循环检查', v: rep.loops.allOk ? '全部通过' : '有失败', d: `${rep.loops.recordings.length} 段录音` },
      { l: '声部测试', v: rep.voices.allOk ? '通过' : '失败', d: `${rep.voices.cases.length} 用例` },
      { l: '缓存测试', v: rep.cache.allOk ? '通过' : '失败', d: `${fmtBytes(rep.cache.residentBytes)} 驻留` },
      { l: '确定性', v: rep.determinism.sameInputSameSamples ? '同输入同结果' : '不稳定', d: `${rep.determinism.distinctInputs} 组合` },
    ];
    UA.offlineSummary.innerHTML = `<div class="grid">${stats
      .map((s) => `<div class="stat ${s.cls ?? ''}"><div class="sl">${s.l}</div><div class="sv">${escapeHtml(s.v)}</div><div class="sd">${escapeHtml(String(s.d))}</div></div>`)
      .join('')}</div>`;
  } catch (err) {
    UA.offlineSummary.innerHTML = `<div class="empty">未找到离线报告（${escapeHtml(err.message)}）。请先运行 <code>npm run offline</code>。</div>`;
  }
}

// ---------------------------------------------------------------------------
// Performance wiring
// ---------------------------------------------------------------------------

async function start() {
  UA.startBtn.disabled = true;
  try {
    setStatus('ready', '加载录音…');
    const engine = new LiveEngine({
      onEvent: (e) => {
        if (e.type === 'voices') renderVoices(e.snapshot, e.meters);
      },
      onError: showError,
    });
    const { keymap, summary } = await engine.init();
    state.engine = engine;
    state.keymap = keymap;
    buildKeyboard();
    renderZones();
    renderVelocityTable();
    // Refresh the hint copy from the engine's actual band.
    const band = `${instrumentBlend().lo}–${instrumentBlend().hi - 1}`;
    const hint = document.querySelector('#velocity ~ .hint');
    if (hint) hint.textContent = `1–${instrumentBlend().lo - 1} 柔和层 · ${band} 交叉淡化 · ${instrumentBlend().hi}–127 明亮层`;
    renderVoices(engine.vm.snapshot(), engine._meters());
    renderKeyInstances();
    UA.voiceCap.textContent = String(summary.maxVoices);
    await engine.resume();
    setStatus('running', `运行中 · ${summary.sampleRate} Hz · ${summary.zones} 键区`);
    document.getElementById('subtitle').textContent =
      `${summary.zones} 个音区 × 2 个力度层，${summary.recordings} 段自制录音 · 缓存 ${fmtBytes(summary.residentBytes)} / ${fmtBytes(summary.cacheBudget)}`;
    UA.startBtn.textContent = '引擎已启动';
    // Sweep loop for the voice meters and tail cleanup.
    const tick = () => {
      if (!state.engine) return;
      state.engine.sweep();
      renderKeyInstances();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    UA.startBtn.disabled = false;
    showError(err);
  }
}

function currentVelocity() {
  return Number(UA.velocity.value);
}

function press(note, source) {
  const engine = state.engine;
  if (!engine) {
    showError({ code: 'NOT_READY', message: '引擎尚未启动', hint: '先点击“启动引擎”' });
    return;
  }
  const v = currentVelocity();
  // A repeat of a pitch is a new key instance. Release the previous instance
  // explicitly first so its key-up cannot later fire against the new one; the
  // sustain pedal, if down, keeps the old instance sounding under its own id.
  if (state.heldNotes.has(note)) release(note);
  const instance = state.nextInstance++;
  state.heldNotes.add(note);
  state.active.set(note, instance);
  try {
    const res = engine.noteOn(note, v, source);
    state.active.set(note, {
      instance,
      voiceId: res.voice.id,
      head: res.voice.head,
      note,
      velocity: v,
      mix: res.plan.mix.kind,
      layers: res.plan.entries.map((e) => e.sample.name),
      state: 'held',
    });
    if (engine.ctx?.state === 'running') setStatus('running', `运行中 · ${engine.ctx.sampleRate} Hz`);
    renderLastEvent(res.plan, res.voice);
    paintKey(note, true, v);
    state.highlight = note;
    // Legato: hold the previous note's release back by legatoMs so the voices
    // overlap audibly instead of chopping.
    if (state.legatoMs > 0) {
      const prev = [...state.legs.keys()];
      for (const n of prev) {
        clearTimeout(state.legs.get(n));
        state.legs.delete(n);
      }
    }
    renderVoices(engine.vm.snapshot(), engine._meters());
    renderKeyInstances();
  } catch (err) {
    showError(err);
    state.heldNotes.delete(note);
    state.active.delete(note);
  }
}

function release(note) {
  if (!state.engine) return;
  state.heldNotes.delete(note);
  paintKey(note, false, 0);
  const engine = state.engine;
  const inst = state.active.get(note);
  const voiceId = typeof inst === 'object' ? inst.voiceId : null;
  const fire = () => {
    engine.noteOff(note, voiceId);
    state.legs.delete(note);
    // If this exact instance is no longer the pitch's current press, leave the
    // record alone: the newer instance owns the key now.
    if (state.active.get(note) === inst) state.active.delete(note);
    renderVoices(engine.vm.snapshot(), engine._meters());
    renderKeyInstances();
  };
  if (state.legatoMs > 0 && state.heldNotes.size > 0) {
    // Another key is still held: delay this release to create overlap.
    const t = setTimeout(fire, state.legatoMs);
    state.legs.set(note, t);
  } else {
    fire();
  }
  renderVoices(engine.vm.snapshot(), engine._meters());
  renderKeyInstances();
}

function releaseAll() {
  for (const n of [...state.heldNotes]) release(n);
  for (const t of state.legs.values()) clearTimeout(t);
  state.legs.clear();
}

// The pedal owns the sounds of keys already let go. It never owns a key that
// is still physically down; that key releases on its own key-up.
function setPedal(down) {
  const engine = state.engine;
  if (!engine) {
    showError({ code: 'NOT_READY', message: '引擎尚未启动', hint: '先点击“启动引擎”' });
    return;
  }
  if (down === state.pedal) return;
  state.pedal = down;
  if (down) engine.pedalDown();
  else engine.pedalUp();
  UA.pedalBtn.classList.toggle('engaged', down);
  UA.pedalBtn.setAttribute('aria-pressed', String(down));
  UA.pedalBtn.querySelector('.pedal-state').textContent = down ? '踩下' : '抬起';
  renderVoices(engine.vm.snapshot(), engine._meters());
  renderKeyInstances();
}

function togglePedal() {
  setPedal(!state.pedal);
}

// Show the correspondence between each press instance, the velocity layers it
// selected, the voice(s) it owns, and the sample read heads actually reading
// those buffers. Sustained rows are owned by the pedal, not by the key.
function renderKeyInstances() {
  const engine = state.engine;
  if (!engine) return;
  const snap = engine.vm.snapshot();
  const byVoice = new Map();
  for (const v of snap.voices) byVoice.set(v.id, v);
  const rows = [];
  for (const rec of state.active.values()) {
    if (typeof rec !== 'object') continue;
    const v = byVoice.get(rec.voiceId);
    const stateText = !v ? '已结束' : v.state === 'sustained' ? '踏板持有' : v.state === 'release' ? '释放中' : '按住';
    const pedalOwned = v ? v.state === 'sustained' : false;
    rows.push({
      instance: rec.instance,
      note: rec.note,
      velocity: rec.velocity,
      samples: rec.layers,
      mix: rec.mix,
      voiceId: rec.voiceId,
      head: rec.head,
      state: stateText,
      pedalOwned,
    });
  }
  // Pedal-held instances whose key was already released are no longer in
  // state.active; surface them from the snapshot so ownership is complete.
  const seen = new Set(rows.map((r) => r.voiceId));
  for (const v of snap.voices) {
    if (seen.has(v.id) || v.state !== 'sustained') continue;
    rows.push({
      instance: v.instance,
      note: v.note,
      velocity: v.velocity,
      samples: v.layers.map((l) => l.sample),
      mix: v.mix,
      voiceId: v.id,
      head: v.head,
      state: '踏板持有',
      pedalOwned: true,
    });
  }
  rows.sort((a, b) => a.instance - b.instance);
  if (rows.length === 0) {
    UA.keyInstances.innerHTML =
      `<div class="empty">按下实例 · 力度层 · 实际读头：演奏后显示每个按键实例拥有的声部与采样读头。</div>`;
    return;
  }
  UA.keyInstances.innerHTML = `
    <div class="ki-head">
      <span>实例</span><span>音/力度</span><span>力度层 → 采样</span><span>声部 · 读头</span><span>状态</span>
    </div>` +
    rows
      .map(
        (r) => `<div class="ki-row ${r.state === '按住' ? 'held' : r.pedalOwned ? 'sustained' : ''}">
          <span class="ki-i">#${r.instance}</span>
          <span class="ki-n">${noteName(r.note)} · v${r.velocity}</span>
          <span class="ki-l"><b class="${r.mix}">${r.mix}</b> ${escapeHtml(r.samples.join(' + '))}</span>
          <span class="ki-v">#${r.voiceId} · 读头 ${r.head}</span>
          <span class="ki-s">${r.state}</span>
        </div>`,
      )
      .join('');
}

function wireKeyboard() {
  UA.keys.addEventListener('pointerdown', (e) => {
    const key = e.target.closest('.key');
    if (!key) return;
    e.preventDefault();
    if (!state.engine) return start().then(() => press(Number(key.dataset.note), 'pointer'));
    press(Number(key.dataset.note), 'pointer');
    key.setPointerCapture?.(e.pointerId);
  });
  const up = (e) => {
    const key = e.target.closest?.('.key');
    if (!key) return;
    release(Number(key.dataset.note));
  };
  UA.keys.addEventListener('pointerup', up);
  UA.keys.addEventListener('pointercancel', up);
  UA.keys.addEventListener('pointerleave', up);
  UA.keys.addEventListener('contextmenu', (e) => e.preventDefault());
}

const KEYMAP_COMPUTER = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71, k: 72,
};

function wireComputerKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select')) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!state.engine) return start().then(() => press(state.highlight, 'key'));
      press(state.highlight, 'key');
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const next = Math.max(1, Math.min(127, currentVelocity() + (e.code === 'ArrowUp' ? step : -step)));
      UA.velocity.value = String(next);
      UA.velOut.textContent = String(next);
      return;
    }
    // Hold Shift to sustain (sostenuto-style pedal): key-ups while it is down
    // move their voices into the pedal-owned set instead of fading.
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      e.preventDefault();
      setPedal(true);
      return;
    }
    const note = KEYMAP_COMPUTER[e.key.toLowerCase()];
    if (note !== undefined && !e.repeat) {
      e.preventDefault();
      if (!state.engine) return start().then(() => press(note, 'key'));
      press(note, 'key');
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      setPedal(false);
      return;
    }
    const note = KEYMAP_COMPUTER[e.key.toLowerCase()];
    if (note !== undefined) release(note);
  });
}

function wireControls() {
  UA.startBtn.addEventListener('click', start);
  UA.panicBtn.addEventListener('click', () => {
    if (!state.engine) return;
    state.engine.panic();
    for (const n of state.heldNotes) paintKey(n, false, 0);
    state.heldNotes.clear();
    state.active.clear();
    for (const t of state.legs.values()) clearTimeout(t);
    state.legs.clear();
    if (state.pedal) setPedal(false);
    setStatus('running', '已全部静音');
    renderVoices(state.engine.vm.snapshot(), state.engine._meters());
    renderKeyInstances();
  });
  UA.pedalBtn.addEventListener('click', togglePedal);
  UA.velocity.addEventListener('input', () => {
    UA.velOut.textContent = UA.velocity.value;
  });
  UA.legato.addEventListener('input', () => {
    state.legatoMs = Number(UA.legato.value);
    UA.legatoOut.textContent = UA.legato.value;
  });
  state.legatoMs = Number(UA.legato.value);
  UA.latched.addEventListener('change', () => {
    state.latched = UA.latched.checked;
  });
  UA.voiceLimit.addEventListener('input', () => {
    const n = Number(UA.voiceLimit.value);
    UA.capOut.textContent = String(n);
    if (state.engine) {
      try {
        state.engine.setMaxVoices(n);
        renderVoices(state.engine.vm.snapshot(), state.engine._meters());
      } catch (err) {
        showError(err);
      }
    }
  });
  UA.loopBtn.addEventListener('click', runLoopChecks);
  UA.offlineBtn.addEventListener('click', loadOfflineReport);
}

// Boot: render the static rule tables immediately so the page teaches the
// engine even before audio starts.
wireControls();
wireKeyboard();
wireComputerKeyboard();
renderVelocityTable();
fetch('/assets/samples/recordings.json')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((m) => {
    state.manifesto = m;
    // Build the key map preview from the same rules as the engine.
    import('../src/engine.js').then(({ buildInstrument, describeKeyMap }) => {
      state.keymap = describeKeyMap(buildInstrument(m));
      renderZones();
    });
  })
  .catch(() => {});

// Test hooks: expose a tiny read-only surface for automated verification.
window.__sampler = {
  state,
  getSnapshot: () => (state.engine ? state.engine.vm.snapshot() : null),
  getMeters: () => (state.engine ? state.engine._meters() : null),
  press,
  release,
  releaseAll,
  setPedal,
  pedalDown: () => setPedal(true),
  pedalUp: () => setPedal(false),
  pedalState: () => state.pedal,
  runLoopChecks,
  loadOfflineReport,
  setVelocity: (v) => {
    UA.velocity.value = String(v);
    UA.velOut.textContent = String(v);
  },
  getEvents: () => (state.engine ? state.engine.ticks : []),
  keymap: () => state.keymap,
  // Test/diagnostic: provoke a genuine cache failure by loading a real
  // recording into a cache whose budget is too small, then surface it through
  // the same UI handler used for performance failures.
  provokeCacheError: () => {
    const eng = state.engine;
    const rec = eng.instrument.zones[0].samples.soft;
    const tiny = new SampleCache(eng.instrument, { cacheBytes: 1024 });
    try {
      tiny.put(rec.name, new Float32Array(rec.frames));
    } catch (err) {
      showError(err);
      return err.code;
    }
    return null;
  },
};
