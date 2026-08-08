/*
 * combgate -- adjudicate the COMBINED render-pipeline state against the hard
 * constraint p95 <= 16.67 ms at 1920x1080, tier 'high', adaptive resolution OFF,
 * on a live CPU-vs-CPU fight.
 *
 * This tool exists to REFUTE, not to confirm. It re-measures from scratch and
 * takes no prior number on trust.
 *
 * Two modes:
 *
 *   --mode verdict   Long continuous run at the shipped config. Blocks are
 *                    back-to-back so the series can be read for contention
 *                    drift; loadavg is recorded per block. Reports raw, 2-frame
 *                    pair and 12-frame slide percentiles, pooled and per block.
 *
 *   --mode abba      ABBA quads (A B B A) of short blocks inside ONE session,
 *                    because the noise here is CONTENTION and it moves between
 *                    sessions and even between the halves of a quad. Every
 *                    block asserts the armed pass list. Paired per-quad deltas,
 *                    bootstrap CI over quads.
 *
 * Instrument: the rAF interval, with the frame-rate limiter off. NOT frameMs
 * (a 48-frame rolling mean) and NOT the timer query (2.2x wall clock here).
 *
 *   node tools/combgate.mjs --mode verdict --minutes 8
 *   node tools/combgate.mjs --mode abba --arms midground,ao,scale070,null
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const PAGE = resolve(HERE, 'combgate-page.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5244));
const MODE = arg('mode', 'verdict');
const MINUTES = Number(arg('minutes', 8));
const BLOCK = Number(arg('block', 2600));
const DISCARD = Number(arg('discard', 350));
const QUADS = Number(arg('quads', 5));
const ARMS = arg('arms', 'null,midground,ao,scale070').split(',').filter(Boolean);
const OUT = arg('out', resolve(REPO, 'scratchpad/combgate-' + MODE + '.json'));

/* ------------------------------------------------------------ statistics */

const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return NaN;
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const stat = (a) => (a.length ? {
  n: a.length,
  p50: +q(a, 0.5).toFixed(2),
  p25: +q(a, 0.25).toFixed(2),
  p75: +q(a, 0.75).toFixed(2),
  p95: +q(a, 0.95).toFixed(2),
  p99: +q(a, 0.99).toFixed(2),
  mean: +(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2),
  over: +(100 * a.filter((v) => v > 16.67).length / a.length).toFixed(1),
} : null);
/** k-frame box average, the shape the brief reports. */
const box = (a, k) => {
  if (a.length < k) return [];
  const out = [];
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= k) s -= a[i - k];
    if (i >= k - 1) out.push(s / k);
  }
  return out;
};
const cols = (dts) => ({ raw: stat(dts), pair: stat(box(dts, 2)), slide12: stat(box(dts, 12)) });

const log = (...a) => console.log('[combgate]', ...a);

/* --------------------------------------------------------------- harness */

const server = await createServer({
  root: REPO,
  server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } },
  logLevel: 'error',
});
await server.listen();

const browser = await chromium.launch({
  args: [
    '--use-angle=metal',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-zero-copy',
    '--disable-frame-rate-limit',
    '--force-device-scale-factor=1',
  ],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const pageErrors = [];
page.on('pageerror', (e) => { pageErrors.push(e.message.split('\n')[0]); console.warn('[page-error]', e.message.split('\n')[0]); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 60000 });
await page.waitForTimeout(4000);
await page.evaluate(readFileSync(PAGE, 'utf8'));

const setupState = await page.evaluate('window.__kbComb.setup(8)');
const gpu = await page.evaluate(`(() => {
  const gl = window.KB.renderer.renderer.getContext();
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
})()`);

// Settle: shader compiles, arena warm, AI actually engaged. Re-assert the scale
// AFTER settling too: the adaptive controller gets a second bite during warmup.
await page.waitForTimeout(12000);
await page.evaluate('window.__kbComb.setScale(0.85)');
await page.waitForTimeout(800);
const ready = await page.evaluate('window.__kbComb.state()');
log('gpu', gpu);
log('config', JSON.stringify({
  tier: ready.tier, scale: ready.scale, buffer: ready.buffer, drawingBuffer: ready.drawingBuffer,
  canvasCss: ready.canvasCss, dpr: ready.dpr, adaptive: ready.adaptive, armed: ready.armed,
  midground: ready.midground,
}));

/* -- SETUP ASSERTIONS. The brief is explicit that a control on the measurement
 *    is not enough, the SETUP needs one. If the rig is not at 1080p / high /
 *    0.85 / adaptive-off, nothing downstream means anything, so refuse. */
const fail = [];
// The CSS canvas is the 1080p display surface; the drawing buffer is the 0.85
// render target that gets upscaled into it. Both must be right.
if (ready.canvasCss !== '1920x1080') fail.push('canvasCss=' + ready.canvasCss);
if (ready.drawingBuffer !== '1632x918') fail.push('drawingBuffer=' + ready.drawingBuffer);
if (ready.tier !== 'high') fail.push('tier=' + ready.tier);
if (Math.abs(ready.scale - 0.85) > 1e-6) fail.push('scale=' + ready.scale);
if (ready.adaptive !== false) fail.push('adaptive=' + ready.adaptive);
if (ready.buffer !== '1632x918') fail.push('buffer=' + ready.buffer);
if (ready.dpr !== 1) fail.push('dpr=' + ready.dpr);
if (ready.phase !== 'fight') fail.push('phase=' + ready.phase);
if (fail.length) { log('SETUP ASSERTION FAILED:', fail.join(' ')); await browser.close(); await server.close(); process.exit(2); }
log('setup assertions PASS');

const results = [];
const rawDts = [];
const t0 = Date.now();

async function block(label, ms = BLOCK) {
  const load0 = os.loadavg()[0];
  const r = await page.evaluate(`window.__kbComb.sample(${ms}, ${DISCARD})`);
  const load1 = os.loadavg()[0];
  const c = cols(r.dts);
  const row = {
    label, t: +((Date.now() - t0) / 1000).toFixed(1),
    wall: +r.wall.toFixed(0), frames: r.dts.length,
    throughput: +(r.wall / Math.max(1, r.dts.length)).toFixed(3),
    ...c,
    load: [+load0.toFixed(2), +load1.toFixed(2)],
    armed: r.state.armed.join('+'),
    scale: r.state.scale, buffer: r.state.buffer,
    shadowEnabled: r.state.shadowEnabled, shadowType: r.state.shadowType,
    drawCalls: r.state.drawCalls, tris: r.state.triangles,
    hp: r.state.hp, mg: r.state.midground,
  };
  results.push(row);
  rawDts.push({ label, load: row.load[1], dts: r.dts.map((v) => +v.toFixed(3)) });
  log(`${label.padEnd(22)} t=${String(row.t).padStart(6)}s n=${String(row.frames).padStart(4)} `
    + `| pair p50 ${c.pair.p50.toFixed(2)} IQR[${c.pair.p25.toFixed(2)},${c.pair.p75.toFixed(2)}] `
    + `p95 ${c.pair.p95.toFixed(2)} over ${String(c.pair.over).padStart(5)}% `
    + `| raw p95 ${c.raw.p95.toFixed(2)} | load ${row.load[1].toFixed(2)} | dc ${row.drawCalls}`);
  return row;
}

/* ------------------------------------------------------------- mode: verdict */

if (MODE === 'verdict') {
  const nBlocks = Math.max(1, Math.round((MINUTES * 60 * 1000) / (BLOCK + DISCARD)));
  log(`verdict: ${nBlocks} blocks x ${BLOCK}ms sampled (+${DISCARD}ms discard) ~= ${MINUTES} min`);
  for (let i = 0; i < nBlocks; i++) await block(`v.${String(i).padStart(3, '0')}`);

  // Pooled over every frame of every block: this is the headline number, and
  // it is computed from the raw intervals, not by averaging block percentiles.
  const pooled = rawDts.flatMap((b) => b.dts);
  const c = cols(pooled);
  log('');
  log(`POOLED n=${pooled.length} frames over ${results.length} blocks`);
  for (const k of ['raw', 'pair', 'slide12']) {
    log(`  ${k.padEnd(8)} p50 ${c[k].p50.toFixed(2)}  IQR[${c[k].p25.toFixed(2)}, ${c[k].p75.toFixed(2)}]  `
      + `p95 ${c[k].p95.toFixed(2)}  over16.67 ${c[k].over}%`);
  }
  const loads = results.map((r) => r.load[1]);
  log(`  loadavg  min ${Math.min(...loads).toFixed(2)} med ${q(loads, 0.5).toFixed(2)} max ${Math.max(...loads).toFixed(2)}`);
  log(`  VERDICT  p95(pair)=${c.pair.p95.toFixed(2)} vs 16.67 -> ${c.pair.p95 <= 16.67 ? 'MET' : 'MISSED by ' + (c.pair.p95 - 16.67).toFixed(2) + ' ms'}`);
  // The quietest block is the most generous reading the data can support.
  const byLoad = [...results].sort((a, b) => a.load[1] - b.load[1]);
  const quiet = byLoad.slice(0, Math.max(1, Math.round(results.length * 0.2)));
  const qp = quiet.map((r) => r.pair.p95);
  log(`  quietest 20% of blocks (load<=${quiet[quiet.length - 1].load[1].toFixed(2)}): pair p95 median ${q(qp, 0.5).toFixed(2)}, best block ${Math.min(...qp).toFixed(2)}`);
  writeFileSync(OUT + '.pooled.json', JSON.stringify({ pooled: c, blocks: results }, null, 2));
}

/* ---------------------------------------------------------------- mode: tail */

if (MODE === 'tail') {
  const nB = Math.max(1, Math.round((MINUTES * 60 * 1000) / (BLOCK + DISCARD)));
  log(`tail: ${nB} blocks x ${BLOCK}ms, per-frame program/drawcall/heap trace`);
  const all = [];
  for (let i = 0; i < nB; i++) {
    const load0 = os.loadavg()[0];
    const r = await page.evaluate(`window.__kbComb.tail(${BLOCK}, ${DISCARD})`);
    for (const row of r.rows) all.push(row);
    const dts = r.rows.map((x) => x.dt);
    const c = cols(dts);
    log(`  t.${String(i).padStart(3, '0')} n=${dts.length} pair p50 ${c.pair.p50} p95 ${c.pair.p95} `
      + `| programs ${r.rows[0].pr}->${r.rows[r.rows.length - 1].pr} fv ${r.rows[r.rows.length - 1].fv} `
      + `| load ${load0.toFixed(2)}`);
  }

  // ---- attribution of the tail by coincidence -----------------------------
  const dts = all.map((r) => r.dt);
  const pair = box(dts, 2);
  const thr = 16.67;
  const lateIdx = [];
  for (let i = 0; i < dts.length; i++) if (dts[i] > thr) lateIdx.push(i);

  // A program compile on frame i shows as programs[i] > programs[i-1].
  let compileFrames = 0, compileLate = 0;
  for (let i = 1; i < all.length; i++) {
    if (all[i].pr > all[i - 1].pr) { compileFrames++; if (dts[i] > thr) compileLate++; }
  }
  // Heap shrink = a GC completed on or just before this frame.
  let gcFrames = 0, gcLate = 0;
  for (let i = 1; i < all.length; i++) {
    if (all[i].heap > 0 && all[i].heap < all[i - 1].heap) { gcFrames++; if (dts[i] > thr) gcLate++; }
  }
  const lateRate = 100 * lateIdx.length / dts.length;
  const c = cols(dts);
  log('');
  log(`TAIL ANALYSIS  n=${dts.length} frames`);
  log(`  raw p50 ${c.raw.p50}  p95 ${c.raw.p95}  |  pair p50 ${c.pair.p50}  p95 ${c.pair.p95}  |  slide12 p95 ${c.slide12.p95}`);
  log(`  late frames (>16.67 raw): ${lateIdx.length} (${lateRate.toFixed(1)}%)`);
  log(`  frames with a NEW SHADER PROGRAM: ${compileFrames} (${(100 * compileFrames / dts.length).toFixed(2)}%), `
    + `of which late: ${compileLate} (${compileFrames ? (100 * compileLate / compileFrames).toFixed(0) : 0}% vs ${lateRate.toFixed(0)}% base rate)`);
  log(`  frames where JS heap SHRANK (GC): ${gcFrames} (${(100 * gcFrames / dts.length).toFixed(2)}%), `
    + `of which late: ${gcLate} (${gcFrames ? (100 * gcLate / gcFrames).toFixed(0) : 0}% vs ${lateRate.toFixed(0)}% base rate)`);
  log(`  programs: ${all[0].pr} -> ${all[all.length - 1].pr} (delta ${all[all.length - 1].pr - all[0].pr}), `
    + `flashVariants ${all[0].fv} -> ${all[all.length - 1].fv}`);
  // How much of the tail would vanish if every compile/GC frame were free?
  const clean = dts.filter((v, i) => !(i > 0 && (all[i].pr > all[i - 1].pr
    || (all[i].heap > 0 && all[i].heap < all[i - 1].heap))));
  log(`  EXCLUDING every compile+GC frame: n=${clean.length} pair p95 ${cols(clean).pair.p95} `
    + `(was ${c.pair.p95}) -- if this barely moves, the tail is NOT compiles or GC`);
  // Draw-call spikes: is the tail the FX system drawing more?
  const dcs = all.map((r) => r.dc);
  const dcMed = q(dcs, 0.5);
  const hi = dts.filter((v, i) => all[i].dc > dcMed * 1.15);
  const lo = dts.filter((v, i) => all[i].dc <= dcMed * 1.15);
  log(`  drawCalls median ${dcMed}: frames >15% over -> n=${hi.length} p50 ${stat(hi)?.p50} p95 ${stat(hi)?.p95}`);
  log(`                              frames at/below -> n=${lo.length} p50 ${stat(lo)?.p50} p95 ${stat(lo)?.p95}`);
  writeFileSync(OUT + '.tail.json', JSON.stringify({ n: dts.length, cols: c, compileFrames, compileLate, gcFrames, gcLate }, null, 2));
}

/* ---------------------------------------------------------------- mode: abba */

const ARM_SETUP = {
  null:      'window.__kbComb.allOn()',
  ao:        `window.__kbComb.allOn(); window.__kbComb.setEffect('ao', false)`,
  bloom:     `window.__kbComb.allOn(); window.__kbComb.setEffect('bloom', false)`,
  dof:       `window.__kbComb.allOn(); window.__kbComb.setEffect('dof', false)`,
  motionBlur:`window.__kbComb.allOn(); window.__kbComb.setEffect('motionBlur', false)`,
  smaa:      `window.__kbComb.allOn(); window.__kbComb.setEffect('smaa', false)`,
  grade:     `window.__kbComb.allOn(); window.__kbComb.setEffect('grade', false)`,
  midground: 'window.__kbComb.setMidground(false)',
  shadows:   'window.__kbComb.setShadows(false)',
  overlay:   'window.__kbComb.setOverlay(false)',
  freeze:    'window.__kbComb.setFreeze(true)',
  scale070:  'window.__kbComb.setScale(0.70)',
};
const ARM_RESET = {
  null:      'window.__kbComb.allOn()',
  midground: 'window.__kbComb.setMidground(true)',
  shadows:   'window.__kbComb.setShadows(true)',
  scale070:  'window.__kbComb.setScale(0.85)',
};
const reset = async () => {
  await page.evaluate('window.__kbComb.allOn()');
  await page.evaluate('window.__kbComb.setMidground(true)');
  await page.evaluate('window.__kbComb.setShadows(true)');
  await page.evaluate('window.__kbComb.setOverlay(true)');
  await page.evaluate('window.__kbComb.setFreeze(false)');
  await page.evaluate('window.__kbComb.setScale(0.85)');
  await page.waitForTimeout(500);
};

/**
 * FRAME-CORRUPTION GUARD. This round already produced one confident 40% "saving"
 * that was a frame drawing almost nothing after a GL error. Mean luma of an
 * actual screenshot is the cheapest thing that catches it, so every arm reports
 * the luma it was measured at and the driver flags any arm that moved it hard.
 */
const frameStat = async () => page.evaluate(`(() => {
  const rp = window.KB.renderer;
  const gl = rp.renderer.getContext();
  const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
  // Read a coarse grid straight off the default framebuffer. preserveDrawingBuffer
  // is off, so this must run inside the same task as a draw -- force one.
  rp.render(rp._lastScene || window.KB.scene, rp.camera, 1 / 60);
  const px = new Uint8Array(4 * w * h);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, n = 0, nz = 0;
  for (let i = 0; i < px.length; i += 4 * 97) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    sum += l; n++; if (l > 8) nz++;
  }
  return { luma: +(sum / Math.max(1, n)).toFixed(2), nonBlack: +(100 * nz / Math.max(1, n)).toFixed(1),
    glError: gl.getError() };
})()`);

const boot = (a, b) => {
  // Paired bootstrap over quads.
  const d = a.map((v, i) => v - b[i]);
  const n = d.length;
  const m = d.reduce((s, v) => s + v, 0) / n;
  const s = [];
  for (let k = 0; k < 4000; k++) {
    let acc = 0;
    for (let i = 0; i < n; i++) acc += d[(Math.random() * n) | 0];
    s.push(acc / n);
  }
  s.sort((x, y) => x - y);
  return { mean: +m.toFixed(3), lo: +s[Math.floor(0.025 * s.length)].toFixed(3), hi: +s[Math.floor(0.975 * s.length)].toFixed(3), n };
};

if (MODE === 'abba') {
  const arms = {};
  const frames = {};
  for (const armName of ARMS) {
    if (!ARM_SETUP[armName]) { log('unknown arm', armName); continue; }
    const quads = [];
    for (let k = 0; k < QUADS; k++) {
      // A B B A inside one quad, ~1.3s blocks, so contention drift is common-mode.
      await reset();
      const fA = k === 0 ? await frameStat() : null;
      const A1 = await block(`${armName}.q${k}.A1`, BLOCK);
      await page.evaluate(ARM_SETUP[armName]); await page.waitForTimeout(400);
      const fB = k === 0 ? await frameStat() : null;
      const B1 = await block(`${armName}.q${k}.B1`, BLOCK);
      const B2 = await block(`${armName}.q${k}.B2`, BLOCK);
      await reset();
      const A2 = await block(`${armName}.q${k}.A2`, BLOCK);
      if (fA && fB) {
        const drop = (fA.luma - fB.luma) / Math.max(1e-6, fA.luma);
        log(`  frame ${armName}: luma A ${fA.luma} -> B ${fB.luma} (${(100 * drop).toFixed(1)}% ), `
          + `nonBlack ${fA.nonBlack}% -> ${fB.nonBlack}%, glError A${fA.glError} B${fB.glError}`
          + (Math.abs(drop) > 0.35 || fB.nonBlack < fA.nonBlack * 0.6 || fB.glError !== 0
            ? '   <-- SUSPECT: this arm may be timing a corrupted frame' : ''));
        frames[armName] = { A: fA, B: fB };
      }

      // ARM ASSERTION: the arm must actually have changed the armed list or the
      // scene, and the A blocks must be back at the shipped config. An arm that
      // silently did nothing is void, not zero.
      const took = armName === 'null'
        ? (B1.armed === A1.armed)
        : (armName === 'midground' ? (B1.mg.visible === false && A1.mg.visible === true)
          : armName === 'freeze' ? (B1.hp[0] === B2.hp[0] && B1.hp[1] === B2.hp[1])
          : armName === 'shadows' ? (B1.shadowEnabled === false && A1.shadowEnabled === true)
            : armName === 'scale070' ? (B1.scale === 0.7 && A1.scale === 0.85)
              : (B1.armed !== A1.armed));
      const dP50 = (B1.pair.p50 + B2.pair.p50) / 2 - (A1.pair.p50 + A2.pair.p50) / 2;
      const dP95 = (B1.pair.p95 + B2.pair.p95) / 2 - (A1.pair.p95 + A2.pair.p95) / 2;
      quads.push({ k, took, dP50: +dP50.toFixed(3), dP95: +dP95.toFixed(3),
        armedA: A1.armed, armedB: B1.armed, load: B1.load[1] });
      log(`  quad ${armName}.q${k} took=${took} dP50 ${dP50.toFixed(2)} dP95 ${dP95.toFixed(2)}`);
    }
    const good = quads.filter((x) => x.took);
    arms[armName] = {
      quads, void: quads.length - good.length,
      dP50: good.length ? boot(good.map((x) => x.dP50), good.map(() => 0)) : null,
      dP95: good.length ? boot(good.map((x) => x.dP95), good.map(() => 0)) : null,
    };
    const a = arms[armName];
    log(`ARM ${armName.padEnd(12)} void=${a.void} dP50 ${a.dP50.mean} [${a.dP50.lo}, ${a.dP50.hi}] `
      + `dP95 ${a.dP95.mean} [${a.dP95.lo}, ${a.dP95.hi}]`);
  }
  log('');
  log('ARM SUMMARY (pair statistic, ABBA quads, paired bootstrap CI)');
  log('  arm            void   dP50 [95% CI]                dP95 [95% CI]');
  for (const [k, a] of Object.entries(arms)) {
    if (!a.dP50) continue;
    log(`  ${k.padEnd(13)}  ${String(a.void).padStart(2)}   `
      + `${a.dP50.mean.toFixed(2).padStart(7)} [${a.dP50.lo.toFixed(2).padStart(7)},${a.dP50.hi.toFixed(2).padStart(7)}]   `
      + `${a.dP95.mean.toFixed(2).padStart(7)} [${a.dP95.lo.toFixed(2).padStart(7)},${a.dP95.hi.toFixed(2).padStart(7)}]`);
  }
  writeFileSync(OUT + '.arms.json', JSON.stringify({ arms, frames }, null, 2));
}

/* --------------------------------------------------------------- reporting */

const pooledDts = null; // per-block only; pooling across blocks is done in analysis
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  mode: MODE, gpu, setupState: ready, pageErrors,
  host: { cpus: os.cpus().length, loadStart: os.loadavg() },
  block: BLOCK, discard: DISCARD, results,
}, null, 2));
log('wrote', OUT);

await browser.close();
await server.close();
