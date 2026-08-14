/*
 * footslip.mjs -- measure (and fix) foot skating in the run cycle.
 *
 * Rotoscoped animation doesn't slip: the artist traced a real person, so the
 * distance the body moved between two frames is exactly the distance the
 * planted foot travelled backwards relative to the hip. Our poses were
 * authored by hand and the chx values came from the original table, so the
 * two were never reconciled -- which reads on screen as skating.
 *
 * This walks the run cycle, works out which foot is carrying weight on each
 * frame, and reports how far it slides in world space. With --fix it solves
 * for the hip angle that would hold the planted foot still, and prints a
 * corrected pose table to paste back into poses.js.
 *
 * Usage: node tools/footslip.mjs [--fix]
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const load = (ctx, f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);

const ctx = vm.createContext({ console, Math, Object, Array, Uint8Array, Uint16Array, Uint32Array, Int16Array, performance: { now: () => 0 } });
load(ctx, 'src/engine/gfx.js');
load(ctx, 'src/engine/raster.js');
load(ctx, 'src/game/rig.js');
load(ctx, 'src/game/poses.js');
const POP = ctx.POP;

const L = POP.Rig.L;
const D2R = Math.PI / 180;

// the run cycle's per-frame chx, as it stands in seq.js
const CHX = [6, 1, 3, 5, 6, 2, 4, 5];

function chain(hipX, hipY, hipA, kneeA, footA) {
  const kx = hipX + Math.cos(hipA * D2R) * L.uLeg;
  const ky = hipY - Math.sin(hipA * D2R) * L.uLeg;
  const ax = kx + Math.cos(kneeA * D2R) * L.lLeg;
  const ay = ky - Math.sin(kneeA * D2R) * L.lLeg;
  const tx = ax + Math.cos(footA * D2R) * L.foot;
  const ty = ay - Math.sin(footA * D2R) * L.foot;
  // the contact patch is between the ankle and the toe, weighted forward
  return { ax, ay, tx, ty, cx: ax * 0.45 + tx * 0.55, cy: Math.min(ay, ty) };
}

function legs(p) {
  return {
    far: chain(p[0] - 0.6, p[1], p[8], p[9], p[10]),
    near: chain(p[0] + 0.6, p[1], p[11], p[12], p[13])
  };
}

const RUN = POP.CLIPS.runcyc.frames;

function report(frames, label) {
  console.log('\n=== ' + label + ' ===');
  let world = 0;
  const rows = [];
  for (let i = 0; i < frames.length; i++) {
    const l = legs(frames[i]);
    // whichever foot is lower is the one carrying weight
    const planted = l.near.cy <= l.far.cy ? 'near' : 'far';
    const c = l[planted];
    rows.push({ i, planted, cx: c.cx, cy: c.cy, world: world + c.cx, chx: CHX[i] });
    world += CHX[i];
  }
  let worst = 0;
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i], b = rows[(i + 1) % rows.length];
    let slip = null;
    if (a.planted === b.planted) {
      const bw = (i + 1 < rows.length) ? b.world : b.world + world;
      slip = bw - a.world;
      if (Math.abs(slip) > Math.abs(worst)) worst = slip;
    }
    console.log(
      `f${a.i}  plant=${a.planted}  footY=${a.cy.toFixed(1).padStart(5)}  ` +
      `worldX=${a.world.toFixed(1).padStart(6)}  chx=${a.chx}  ` +
      (slip === null ? 'swap' : `slip=${slip > 0 ? '+' : ''}${slip.toFixed(2)}`)
    );
  }
  console.log(`cycle travel = ${world}px   worst per-frame slip = ${worst.toFixed(2)}px`);
  return rows;
}

report(RUN, 'current run cycle');

if (process.argv.includes('--fix')) {
  /* Solve, per frame, for the hip angle that puts the planted foot where it
   * needs to be. Everything else about the pose is left alone -- we are
   * correcting the one degree of freedom that controls ground contact. */
  const out = RUN.map(p => p.slice());
  const contact = [];
  for (let i = 0; i < out.length; i++) {
    const l = legs(out[i]);
    contact.push(l.near.cy <= l.far.cy ? 'near' : 'far');
  }

  // group consecutive frames with the same planted foot into stance phases,
  // wrapping around the loop
  const n = out.length;
  const visited = new Array(n).fill(false);
  for (let s = 0; s < n; s++) {
    if (visited[s]) continue;
    if (contact[(s - 1 + n) % n] === contact[s]) continue;  // not a phase start
    const phase = [];
    let k = s;
    while (!visited[k] && contact[k] === contact[s]) {
      visited[k] = true; phase.push(k); k = (k + 1) % n;
    }
    if (phase.length < 2) continue;

    const foot = contact[s];
    const hipIdx = foot === 'near' ? 11 : 8;
    const kneeIdx = foot === 'near' ? 12 : 9;
    const footIdx = foot === 'near' ? 13 : 10;

    // anchor on the first frame of the stance; every later frame must place
    // the same contact point at the same world x
    const anchor = legs(out[phase[0]])[foot].cx;
    let travelled = 0;
    for (let j = 1; j < phase.length; j++) {
      travelled += CHX[phase[j - 1]];
      const want = anchor - travelled;
      const p = out[phase[j]];
      // bisect on the hip angle; the foot's x is monotonic in it over the
      // range a running leg actually occupies
      let lo = 40, hi = 150, best = p[hipIdx];
      for (let it = 0; it < 40; it++) {
        const mid = (lo + hi) / 2;
        const cxm = chain(p[0] + (foot === 'near' ? 0.6 : -0.6), p[1], mid, p[kneeIdx], p[footIdx]).cx;
        if (cxm > want) lo = mid; else hi = mid;
        best = mid;
      }
      p[hipIdx] = Math.round(best * 10) / 10;
      // the knee follows the hip so the leg keeps its shape
      p[kneeIdx] = Math.round((p[kneeIdx] + (best - RUN[phase[j]][hipIdx])) * 10) / 10;
    }
  }

  report(out, 'corrected run cycle');

  console.log('\n--- paste into src/game/poses.js ---');
  const fmt = p => '    pz(' + p.slice(0, 14).map(v => String(Math.round(v * 10) / 10)).join(', ') + ')';
  console.log('  var RUN = [\n' + out.map(fmt).join(',\n') + '\n  ];');
}
