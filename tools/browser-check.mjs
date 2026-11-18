// Browser smoke/interaction check for the GUI. Requires a running server:
//   node tools/serve.mjs &
//   node tools/browser-check.mjs
// Uses local Chromium libs in this container via LD_LIBRARY_PATH.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';

const URL = process.env.GUI_URL || 'http://127.0.0.1:4173/web/index.html';
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

const report = {};
report.title = await page.title();
report.zoneRowsInitial = await page.locator('#zoneTable .zrow').count();
report.velocityRowsInitial = await page.locator('#velocityTable .vrow-l').count();
await page.screenshot({ path: '/tmp/gui-initial.png', fullPage: true });

// Start the engine via the visible button.
await page.click('#startBtn');
await page.waitForFunction(() => window.__sampler?.state?.engine?.vm, null, { timeout: 15000 });
await page.waitForTimeout(300);
report.statusAfterStart = await page.locator('#status .text').textContent();
report.audioState = await page.evaluate(() => window.__sampler.state.engine.ctx.state);
report.keysRendered = await page.locator('#keys .key').count();
report.zoneRows = await page.locator('#zoneTable .zrow').count();
report.velocityRows = await page.locator('#velocityTable .vrow-l').count();

// Play a boundary note and a low-velocity note through the real UI path.
await page.evaluate(() => window.__sampler.setVelocity(100));
await page.evaluate(() => window.__sampler.press(54, 'test'));
await page.waitForTimeout(250);
report.lastEventText = (await page.locator('#lastEvent').innerText()).slice(0, 400);
report.voiceAfterBoundary = await page.evaluate(() => window.__sampler.getSnapshot().activeCount);
report.meters = await page.evaluate(() => window.__sampler.getMeters());
await page.screenshot({ path: '/tmp/gui-playing.png', fullPage: true });

// Tap a physical key (keyboard input path) and confirm an audio timestamp exists.
await page.evaluate(() => window.__sampler.press(60, 'test'));
await page.waitForTimeout(120);
const ticks = await page.evaluate(() => window.__sampler.getEvents().filter(t => t.kind === 'noteOn'));
report.audioTimestamps = ticks.map(t => ({ note: t.noteName, rate: t.rate, samples: t.layers.map(l => l.sample), audioTime: t.audioTime, wall: t.wall, active: t.activeVoices }));

// Trigger-to-audio latency: schedule time must not be behind the audio clock,
// and wall-clock call time should be close to the reported audio time.
const latency = await page.evaluate(() => {
  const eng = window.__sampler.state.engine;
  const wall = performance.now();
  const res = eng.noteOn(72, 110, 'latency-test');
  return { wall, audioTime: res.audioTime, ctxTime: eng.ctx.currentTime, deltaS: res.audioTime - eng.ctx.currentTime, outNowS: (res.audioTime - eng.ctx.currentTime) };
});
await page.waitForTimeout(60);
await page.evaluate(() => window.__sampler.state.engine.noteOff(72));
report.latency = latency;

// Rapid repeats.
await page.evaluate(() => { for (let i = 0; i < 8; i++) { window.__sampler.press(67, 'test'); window.__sampler.release(67); } });
await page.waitForTimeout(400);
report.maxActiveSeen = await page.evaluate(() => window.__sampler.getSnapshot().activeCount);

// Loop checks through the UI.
await page.click('#loopBtn');
await page.waitForFunction(() => document.querySelectorAll('#loopTable .loop-result').length >= 12, null, { timeout: 15000 });
report.loopResults = await page.locator('#loopTable .loop-result').count();
report.loopFails = await page.locator('#loopTable .lbad').count();

// Offline report loader.
await page.click('#offlineBtn');
await page.waitForTimeout(500);
report.offlineSummary = (await page.locator('#offlineSummary').innerText()).slice(0, 400);

report.errors = errors;
report.html = await page.content();
writeFileSync('/tmp/gui-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, html: undefined }, null, 2));
await browser.close();
