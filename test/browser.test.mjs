// Browser integration test: boots the real GUI, plays notes through the same
// code path as a user, and checks rendered keys, audio scheduling, loop checks,
// offline report loading and the visible error surface.
//
// Needs a static server. The test starts one automatically on PORT (default
// 4199) unless GUI_URL is provided. Set SKIP_BROWSER=1 to skip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 4199);
const URL = process.env.GUI_URL || `http://127.0.0.1:${PORT}/web/index.html`;
const skip = process.env.SKIP_BROWSER === '1';

let server;
let browser;
let page;

before(async () => {
  if (skip) return;
  if (!process.env.GUI_URL) {
    server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: 'ignore',
    });
    await waitForServer(URL);
  }
  browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  page.on('pageerror', (e) => {
    throw new Error(`page error: ${e.message}`);
  });
  await page.goto(URL, { waitUntil: 'networkidle' });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

async function waitForServer(url) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server did not start for ${url}`);
}

test('GUI renders the rule tables before audio starts', { skip }, async () => {
  assert.match(await page.title(), /采样键盘/);
  await page.waitForFunction(() => document.querySelectorAll('#zoneTable .zrow').length === 6);
  assert.equal(await page.locator('#zoneTable .zrow').count(), 6);
  assert.equal(await page.locator('#velocityTable .vrow-l').count(), 3);
  const text = await page.locator('#zoneTable').innerText();
  assert.match(text, /MIDI 42\.\.53/);
  assert.match(text, /ceiling midpoint/);
});

test('engine starts from the visible button and builds 61 keys', { skip }, async () => {
  await page.click('#startBtn');
  await page.waitForFunction(() => window.__sampler?.state?.engine?.vm, null, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.__sampler.state.engine.ctx.state), 'running');
  assert.equal(await page.locator('#keys .key').count(), 61);
  assert.match(await page.locator('#status .text').textContent(), /运行中/);
  const meters = await page.evaluate(() => window.__sampler.getMeters());
  assert.ok(meters.cacheUsed > 0);
  assert.ok(meters.cacheUsed <= meters.cacheBudget);
});

test('clicking a key schedules audio at the current audio clock and shows the selection', { skip }, async () => {
  await page.evaluate(() => window.__sampler.setVelocity(100));
  // A real pointer click on the MIDI 54 key.
  const key = page.locator('#keys .key[data-note="54"]');
  await key.dispatchEvent('pointerdown', { pointerId: 1, bubbles: true });
  await page.waitForTimeout(120);
  const text = await page.locator('#lastEvent').innerText();
  assert.match(text, /F#3/);
  assert.match(text, /键区 C4 \[54\.\.65\]/);
  assert.match(text, /0\.7071/);
  assert.match(text, /c4-hard\.wav/);
  const tick = await page.evaluate(() => window.__sampler.getEvents().filter((t) => t.kind === 'noteOn').pop());
  const clock = await page.evaluate(() => window.__sampler.state.engine.ctx.currentTime);
  assert.ok(tick, 'a noteOn tick must be recorded');
  assert.ok(Math.abs(tick.audioTime - clock) < 1.5, `scheduled at ${tick.audioTime}, clock ${clock}`);
  assert.deepEqual(tick.layers.map((l) => l.sample), ['c4-hard']);
  assert.ok(tick.activeVoices >= 1);
  await key.dispatchEvent('pointerup', { pointerId: 1, bubbles: true });
});

test('velocity blend triggers both layers and is reflected in the result panel', { skip }, async () => {
  await page.evaluate(() => window.__sampler.setVelocity(88));
  await page.evaluate(() => window.__sampler.press(60, 'test'));
  await page.waitForTimeout(120);
  const tick = await page.evaluate(() => window.__sampler.getEvents().filter((t) => t.kind === 'noteOn').pop());
  assert.deepEqual(tick.layers.map((l) => l.layer), ['soft', 'hard']);
  assert.equal(tick.mix, 'blend');
  const text = await page.locator('#lastEvent').innerText();
  assert.match(text, /soft/);
  assert.match(text, /hard/);
  await page.evaluate(() => window.__sampler.releaseAll());
});

test('extreme low velocity still starts a real voice', { skip }, async () => {
  await page.evaluate(() => window.__sampler.setVelocity(1));
  await page.evaluate(() => window.__sampler.press(60, 'test'));
  await page.waitForTimeout(80);
  const snap = await page.evaluate(() => window.__sampler.getSnapshot());
  assert.ok(snap.activeCount >= 1);
  const tick = await page.evaluate(() => window.__sampler.getEvents().filter((t) => t.kind === 'noteOn').pop());
  assert.equal(tick.mix, 'soft');
  await page.evaluate(() => window.__sampler.releaseAll());
});

test('key view records press instances, velocity layer and the actual read head', { skip }, async () => {
  await page.evaluate(() => window.__sampler.state.engine.panic());
  await page.evaluate(() => window.__sampler.setVelocity(100));
  await page.evaluate(() => window.__sampler.press(60, 'test'));
  await page.waitForTimeout(100);
  const text = await page.locator('#keyInstances').innerText();
  assert.match(text, /实例/);
  assert.match(text, /读头/);
  assert.match(text, /C4 · v100/);
  assert.match(text, /hard/);
  assert.match(text, /c4-hard/);
  // The corresponding noteOn tick owns the same instance and head ids.
  const tick = await page.evaluate(() => window.__sampler.getEvents().filter((t) => t.kind === 'noteOn').pop());
  assert.ok(tick.voiceId > 0 && tick.head > 0);
  assert.match(text, new RegExp(`#${tick.voiceId} · 读头 ${tick.head}`));
  await page.evaluate(() => window.__sampler.releaseAll());
});

test('pedal owns released presses; a retrigger keeps its own instance', { skip }, async () => {
  const res = await page.evaluate(async () => {
    const eng = window.__sampler.state.engine;
    eng.panic();
    window.__sampler.setVelocity(40);
    window.__sampler.press(60, 'pedal-test'); // soft instance
    await new Promise((r) => setTimeout(r, 60));
    window.__sampler.setVelocity(110);
    window.__sampler.press(60, 'pedal-test'); // retrigger -> new instance
    await new Promise((r) => setTimeout(r, 60));
    window.__sampler.setPedal(true);
    const beforeUp = eng.vm.snapshot();
    // Release the currently-held key: it should become pedal-owned, not fade.
    window.__sampler.release(60);
    await new Promise((r) => setTimeout(r, 40));
    const afterKeyUp = eng.vm.snapshot();
    window.__sampler.setPedal(false);
    await new Promise((r) => setTimeout(r, 40));
    const afterPedalUp = eng.vm.snapshot();
    return {
      pedal: window.__sampler.pedalState(),
      beforeUp: beforeUp.voices.map((v) => ({ id: v.id, state: v.state, instance: v.instance, head: v.head })),
      sustainedAfterKeyUp: afterKeyUp.sustainedCount,
      afterPedalUpStates: afterPedalUp.voices.map((v) => v.state),
    };
  });
  assert.equal(res.pedal, false);
  // Two distinct instances existed; each carries its own head id.
  const instances = res.beforeUp.map((v) => v.instance);
  assert.equal(new Set(instances).size, instances.length);
  const heads = res.beforeUp.map((v) => v.head);
  assert.equal(new Set(heads).size, heads.length);
  assert.ok(res.sustainedAfterKeyUp >= 1, 'released key must be pedal-owned');
  assert.ok(res.afterPedalUpStates.every((s) => s !== 'held' && s !== 'sustained'), 'pedal-up releases the set');
  await page.evaluate(() => window.__sampler.state.engine.panic());
});

test('retrigger of one pitch produces two independent attacks in the engine', { skip }, async () => {
  const res = await page.evaluate(async () => {
    const eng = window.__sampler.state.engine;
    eng.panic();
    const a = eng.noteOn(60, 40, 'retrigger'); // soft
    await new Promise((r) => setTimeout(r, 80));
    const b = eng.noteOn(60, 110, 'retrigger'); // hard, same pitch
    await new Promise((r) => setTimeout(r, 40));
    // Releasing the first instance must not touch the second.
    eng.noteOff(60, a.voice.id);
    await new Promise((r) => setTimeout(r, 40));
    const snap = eng.vm.snapshot();
    return {
      aId: a.voice.id,
      bId: b.voice.id,
      aHead: a.voice.head,
      bHead: b.voice.head,
      bStillHeld: snap.voices.some((v) => v.id === b.voice.id && v.state === 'held'),
      aState: snap.voices.find((v) => v.id === a.voice.id)?.state ?? 'gone',
    };
  });
  assert.notEqual(res.aId, res.bId);
  assert.notEqual(res.aHead, res.bHead);
  assert.equal(res.aState, 'release');
  assert.equal(res.bStillHeld, true, 'the second attack must survive the first release');
  await page.evaluate(() => window.__sampler.state.engine.panic());
});

test('rapid repeats of one note create distinct voices', { skip }, async () => {
  const result = await page.evaluate(async () => {
    const eng = window.__sampler.state.engine;
    window.__sampler.setVelocity(100);
    for (let i = 0; i < 6; i++) {
      eng.noteOn(67, 100, 'rapid');
      await new Promise((r) => setTimeout(r, 40));
    }
    return eng.vm.snapshot();
  });
  assert.ok(result.activeCount >= 4, `expected overlapping voices, got ${result.activeCount}`);
  assert.ok(result.activeCount <= result.maxVoices);
  const ids = result.voices.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  await page.evaluate(() => window.__sampler.state.engine.panic());
});

test('voice cap is enforced when requested beyond the limit', { skip }, async () => {
  const res = await page.evaluate(async () => {
    const eng = window.__sampler.state.engine;
    eng.setMaxVoices(4);
    for (let i = 0; i < 9; i++) {
      eng.noteOn(48 + i, 100, 'cap-test');
      await new Promise((r) => setTimeout(r, 12));
    }
    const snap = eng.vm.snapshot();
    return { active: snap.activeCount, max: snap.maxVoices, steals: snap.steals };
  });
  assert.equal(res.max, 4);
  assert.ok(res.active <= 4, `active ${res.active} exceeded cap`);
  assert.ok(res.steals >= 5, `expected steals, got ${res.steals}`);
  await page.evaluate(() => window.__sampler.state.engine.panic());
  await page.evaluate(() => window.__sampler.state.engine.setMaxVoices(24));
});

test('loop check button reports all 12 recordings as passing', { skip }, async () => {
  await page.click('#loopBtn');
  await page.waitForFunction(() => document.querySelectorAll('#loopTable .loop-result').length >= 12, null, { timeout: 20000 });
  assert.equal(await page.locator('#loopTable .loop-result').count(), 12);
  assert.equal(await page.locator('#loopTable .lbad').count(), 0);
  const text = await page.locator('#loopTable').innerText();
  assert.match(text, /接缝/);
});

test('offline report loads and shows a PASS verdict', { skip }, async () => {
  await page.click('#offlineBtn');
  await page.waitForFunction(() => document.querySelectorAll('#offlineSummary .stat').length >= 6, null, { timeout: 10000 });
  const text = await page.locator('#offlineSummary').innerText();
  assert.match(text, /PASS/);
  assert.match(text, /音高最大误差/);
});

test('engine errors are surfaced in the UI with a code and hint', { skip }, async () => {
  const code = await page.evaluate(() => window.__sampler.provokeCacheError());
  assert.equal(code, 'CACHE_TOO_SMALL');
  const text = await page.locator('#errors').innerText();
  assert.match(text, /CACHE_TOO_SMALL/);
  assert.match(text, /cache budget/);
  assert.match(text, /Raise cacheBytes/);
  // The visible status flips to error, then the next note restores running.
  assert.match(await page.locator('#status .text').textContent(), /CACHE_TOO_SMALL|ERROR/);
  await page.evaluate(() => window.__sampler.state.engine.setStatus('running', 'ok'));
});
