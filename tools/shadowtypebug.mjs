/*
 * shadowtypebug -- a repro for a shipped, menu-reachable rendering failure, and
 * the verification that the fix closes it.
 *
 * THE BUG. three recreates a shadow map after `renderer.shadowMap.type` changes
 * only inside the FIRST `WebGLShadowMap.render` that follows the change:
 * `typeChanged` is computed from `_previousType`, and `_previousType` is reset
 * at the END of that same call (three.module.js:9179 and :9416).
 * `ScenePass.#prepass` deliberately runs TWO shadow-drawing renders per frame --
 * stage one for the split per-fighter casters, then `shadowMap.needsUpdate` is
 * re-armed and stage two draws everything else. The second render therefore sees
 * `typeChanged === false` and leaves ITS maps at the previous type's sampler
 * configuration, while the materials have all been recompiled for the new one.
 *
 * The result is a `sampler2DShadow` bound to a depth texture with no comparison
 * mode (or the reverse), which is GL_INVALID_OPERATION on EVERY draw that
 * samples it:
 *
 *     GL_INVALID_OPERATION: glDrawArrays: Mismatch between texture format and
 *     sampler type (signed/unsigned/float/shadow).
 *
 * Every scene draw is dropped. What reaches the screen is the post chain over a
 * mostly-empty beauty buffer and a stale depth texture: a dark, smeared frame.
 *
 * IT IS LATENT, NOT LIVE, AND THIS TOOL IS WHAT ESTABLISHED THAT. The obvious
 * player route is Options -> Quality -> Medium -> High: Medium is `pcss: false`
 * (PCFShadowMap), High is `pcss: true` (BasicShadowMap), and High is the tier
 * with the split beauty pass. Measured, it does NOT break, and the reason is
 * incidental: every tier also changes `shadowMapSize`, and
 * `RenderPipeline#applyShadowResolution` already nulls a map whose size moved,
 * which forces the reconfiguration the type change failed to. Walking
 * high -> medium -> high -> medium -> high, mean scene luma 68.55 at boot and
 * 68.21 on every return, zero GL errors.
 *
 * What IS broken is any change of `pcss` at a FIXED map size — which is exactly
 * what a `high` tier with `pcss: false` would have been, and exactly what a
 * runtime A/B probe does. It silently turned a PCSS-vs-PCF frame-time
 * measurement into a measurement of a frame that drew almost nothing, and that
 * arm read 40% faster for three sessions before anyone looked at the picture.
 *
 * This tool is therefore a REGRESSION TEST for `#dropShadowMaps`, not a repro of
 * a shipping defect. Run it after touching anything that moves
 * `renderer.shadowMap.type`.
 *
 *   node tools/shadowtypebug.mjs --out scratchpad/typebug
 */
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('port', 5291));
const OUT = resolve(ROOT, arg('out', 'scratchpad/typebug'));
const PIN = Number(arg('pin', 150));

const server = await createServer({ root: ROOT, server: { port: PORT, host: '127.0.0.1', hmr: false, watch: { ignored: ['**/*'] } }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--force-device-scale-factor=1'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
let glErrors = 0;
page.on('pageerror', (e) => console.warn('[page-error]', e.message.split('\n')[0]));
page.on('console', (m) => { if (/GL_INVALID|Mismatch between texture format/.test(m.text())) glErrors++; });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
await page.waitForFunction('!!window.KB && !!window.KB.renderer && !!window.KB.fighters', null, { timeout: 90000 });
await page.evaluate(`(() => { const KB = window.KB; KB.startMatch(0,1); KB.setPhase('fight'); if (KB.menus && KB.menus.show) KB.menus.show(null); KB.clock.getDelta = () => 1/60; })()`);
await page.waitForFunction(`window.KB.tick >= ${PIN}`, null, { timeout: 90000 });
await page.evaluate(`(() => {
  const KB = window.KB, cam = KB.camera;
  KB.paused = true; KB.clock.getDelta = () => 0;
  const pos = cam.position.clone(), quat = cam.quaternion.clone();
  KB.fightCamera.render = () => { cam.position.copy(pos); cam.quaternion.copy(quat); cam.updateMatrixWorld(true); };
  KB.fightCamera.simulate = () => {};
  KB.renderer.effects.adaptiveResolution = false;
  if (KB.renderer.setGrade) KB.renderer.setGrade({ grain: 0, chroma: 0 });
})()`);

/**
 * THE METRIC IS MEAN LUMA OF THE SCENE, not an eyeball. A frame whose draws are
 * all dropped is far darker than the same frame drawn, so a single number
 * separates them and can be asserted.
 */
const LUMA = `(() => {
  // The readback MUST happen in the same synchronous task as a render: without
  // preserveDrawingBuffer the buffer is cleared between tasks, and reading it
  // from a later evaluate returns a black frame for every arm alike -- which is
  // exactly what the first version of this probe did, and it reported every
  // configuration as luma 0 and passed itself.
  const KB = window.KB, r = KB.renderer;
  if (KB.stage && typeof KB.stage.update === 'function') KB.stage.update(0, KB.tick);
  r.render(KB.scene, KB.camera, 1 / 60);
  const c = window.KB.renderer.canvas;
  const t = document.createElement('canvas');
  t.width = 480; t.height = 270;
  const x = t.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  x.drawImage(c, 0, 0, 480, 270);
  const d = x.getImageData(0, 0, 480, 270).data;
  let s = 0;
  for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return +(s / (d.length / 4)).toFixed(3);
})()`;

const STATE = `(() => {
  const rp = window.KB.renderer;
  const l = [];
  rp.scene.traverse((o) => { if (o.isLight && o.shadow && o.castShadow) l.push((o.isDirectionalLight ? 'dir' : 'spot') + ':' + (o.shadow.map ? 'map' : 'NULL') + ':cmp' + (o.shadow.map && o.shadow.map.depthTexture ? String(o.shadow.map.depthTexture.compareFunction) : '?')); });
  return { quality: rp.quality, type: rp.renderer.shadowMap.type, pcss: !!rp._pcssActive, lights: l.sort().join(' ') };
})()`;

mkdirSync(OUT, { recursive: true });
const steps = [
  ['0-boot-high', null],
  ['1-medium', `window.KB.setQuality('medium')`],
  ['2-back-to-high', `window.KB.setQuality('high')`],
  ['3-medium-again', `window.KB.setQuality('medium')`],
  ['4-high-again', `window.KB.setQuality('high')`],
];
const rows = [];
for (const [name, js] of steps) {
  if (js) await page.evaluate(js);
  await page.waitForTimeout(3500);
  glErrors = 0;
  await page.waitForTimeout(1500);
  const luma = await page.evaluate(LUMA);
  const st = await page.evaluate(STATE);
  rows.push({ name, luma, glErrors, ...st });
  console.log(`${name.padEnd(16)} luma ${String(luma).padStart(7)}  glErrors/1.5s ${String(glErrors).padStart(4)}  ${JSON.stringify(st)}`);
  writeFileSync(resolve(OUT, name + '.png'), await page.screenshot({ type: 'png' }));
}

const boot = rows[0].luma;
const back = rows.find((r) => r.name === '2-back-to-high').luma;
console.log(`\nboot-high luma ${boot}   medium->high luma ${back}   ratio ${(back / boot).toFixed(3)}`);
console.log(back / boot < 0.85 || rows.some((r) => r.glErrors > 0)
  ? 'BROKEN: the return trip to high does not reproduce the boot frame'
  : 'OK: medium -> high reproduces the boot frame and no GL errors were raised');
writeFileSync(resolve(OUT, 'result.json'), JSON.stringify(rows, null, 2));
await browser.close();
await server.close();
