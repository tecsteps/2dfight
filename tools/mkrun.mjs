/*
 * mkrun.mjs -- generate the run cycle's leg angles from the chx data.
 *
 * The insight from the original is that movement lives in the animation.
 * The corollary, which is easy to miss, is that the animation therefore has
 * to be *built against* the movement: a rotoscoped frame never slips because
 * the artist traced a foot that really was planted.
 *
 * So rather than hand-authoring leg angles and hoping, we pin the stance
 * foot to a fixed world position and solve two-link IK for the hip and knee.
 * Slip becomes zero by construction. The swing leg is authored by hand --
 * it isn't touching anything, so it only has to look right.
 *
 * Usage: node tools/mkrun.mjs        (prints a pose table for poses.js)
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ctx = vm.createContext({ console, Math, Object, Array, Uint8Array, Uint16Array, Uint32Array, Int16Array });
for (const f of ['src/engine/gfx.js', 'src/engine/raster.js', 'src/game/rig.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx);
}
const L = ctx.POP.Rig.L;
const PS = ctx.POP.Rig.POSE_SCALE;   // poses author hipY in the old, taller space
const R2D = 180 / Math.PI, D2R = Math.PI / 180;

/* Two-link IK. Returns [hipAngle, kneeAngle] placing the ankle at (ax, ay).
 * Of the two elbow-up/elbow-down solutions we take the one that puts the
 * knee forward, because that is the way a leg bends. */
function ik(hx, hy, ax, ay, l1, l2) {
  const dx = ax - hx, dy = ay - hy;
  let d = Math.sqrt(dx * dx + dy * dy);
  const dmin = Math.abs(l1 - l2) + 0.02, dmax = l1 + l2 - 0.02;
  d = Math.max(dmin, Math.min(dmax, d));
  const base = Math.atan2(-dy, dx) * R2D;
  const a1 = Math.acos((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)) * R2D;
  let best = null;
  for (const s of [1, -1]) {
    const hipA = base + s * a1;
    const kx = hx + Math.cos(hipA * D2R) * l1;
    const ky = hy - Math.sin(hipA * D2R) * l1;
    const kneeA = Math.atan2(-(ay - ky), ax - kx) * R2D;
    if (!best || kx > best.kx) best = { hipA, kneeA, kx };
  }
  return [best.hipA, best.kneeA];
}

const norm = a => { while (a > 200) a -= 360; while (a < -160) a += 360; return a; };
const r1 = v => Math.round(v * 10) / 10;

/* ---- the cycle -----------------------------------------------------
 * chx as it appears in seq.js. The value on index i is applied *with*
 * frame i, so the body position at frame i is the running sum up to i.
 */
const CHX = [6, 1, 3, 5, 6, 2, 4, 5];
const N = CHX.length;

const bodyX = [];
{ let a = 0; for (let i = 0; i < N; i++) { a += CHX[i]; bodyX.push(a); } }

// hip height and torso lean per frame -- the bounce, authored
const HIP_Y = [26, 24.5, 25, 27, 26, 24.5, 25, 27];
const TORSO = [-72, -70, -70, -73, -72, -70, -70, -73];
const HEAD = [-78, -78, -80, -80, -78, -78, -80, -80];

/* Stance: frames 0-3 on the near foot, 4-7 on the far foot. The foot plants
 * a little ahead of the hip and leaves a little behind it; in between it
 * simply does not move, which is the whole point. */
const STANCE_LEAD = 6.2;          // how far ahead of the hip it lands
const ANKLE_Y = 1.8;              // ankle height when the foot is on the floor
const FOOT_ANG = [14, 2, -14, -40];   // heel strike, flat, rolling, toe off

/* Swing: the leg that is in the air. Knee lifts hard, foot tucks, then the
 * shin swings out to meet the ground. Authored, since nothing constrains it. */
const SWING = [
  //  hip, knee, foot
  [112, 128, -26],   // just left the ground, heel coming up
  [116, 150, -34],   // knee folded, heel near the seat
  [100, 148, -30],   // knee driving forward
  [ 80, 120, -12]    // shin unfolding, reaching for the plant
];

function frame(i) {
  const stanceIsNear = i < 4;
  const k = i % 4;
  const hipY = HIP_Y[i];
  const hipOffNear = 0.6, hipOffFar = -0.6;

  // world x the stance foot is pinned to, in this frame's local space
  const phaseStart = stanceIsNear ? 0 : 4;
  const plantedWorld = bodyX[phaseStart] + STANCE_LEAD;
  const relX = plantedWorld - bodyX[i];

  const hx = stanceIsNear ? hipOffNear : hipOffFar;
  const [sHip, sKnee] = ik(hx, hipY * PS, relX, ANKLE_Y, L.uLeg, L.lLeg);
  const stance = [r1(norm(sHip)), r1(norm(sKnee)), FOOT_ANG[k]];
  const swing = SWING[k];

  const near = stanceIsNear ? stance : swing;
  const far = stanceIsNear ? swing : stance;

  // arms oppose the legs; the near arm swings with the far leg
  const ARM_F = [[80, -25], [88, -8], [98, 25], [108, 70]];
  const ARM_B = [[112, 125], [106, 118], [98, 100], [88, 40]];
  const farArm = stanceIsNear ? ARM_F[k] : ARM_B[k];
  const nearArm = stanceIsNear ? ARM_B[k] : ARM_F[k];

  return [0, hipY, TORSO[i], HEAD[i],
    farArm[0], farArm[1], nearArm[0], nearArm[1],
    far[0], far[1], far[2], near[0], near[1], near[2]];
}

const OUT = [];
for (let i = 0; i < N; i++) OUT.push(frame(i));

/* verify: walk the stance foot through world space and confirm it holds */
function ankle(hx, hy, hipA, kneeA) {
  const kx = hx + Math.cos(hipA * D2R) * L.uLeg;
  const ky = hy - Math.sin(hipA * D2R) * L.uLeg;
  return [kx + Math.cos(kneeA * D2R) * L.lLeg, ky - Math.sin(kneeA * D2R) * L.lLeg];
}
console.log('stance foot world x (should hold constant within each phase):');
let worst = 0;
for (let i = 0; i < N; i++) {
  const p = OUT[i], nearStance = i < 4;
  const hx = nearStance ? 0.6 : -0.6;
  const [hipA, kneeA] = nearStance ? [p[11], p[12]] : [p[8], p[9]];
  const [ax, ay] = ankle(hx, p[1] * PS, hipA, kneeA);
  const w = ax + bodyX[i];
  if (i % 4 !== 0) {
    const prev = OUT[i - 1], phx = (i - 1) < 4 ? 0.6 : -0.6;
    const [pha, pka] = (i - 1) < 4 ? [prev[11], prev[12]] : [prev[8], prev[9]];
    const [pax] = ankle(phx, prev[1] * PS, pha, pka);
    const slip = w - (pax + bodyX[i - 1]);
    if (Math.abs(slip) > Math.abs(worst)) worst = slip;
    console.log(`  f${i} plant=${nearStance ? 'near' : 'far'} worldX=${w.toFixed(2)} ankleY=${ay.toFixed(2)} slip=${slip >= 0 ? '+' : ''}${slip.toFixed(3)}`);
  } else {
    console.log(`  f${i} plant=${nearStance ? 'near' : 'far'} worldX=${w.toFixed(2)} ankleY=${ay.toFixed(2)} (new stance)`);
  }
}
console.log(`worst in-stance slip = ${worst.toFixed(3)}px   cycle travel = ${bodyX[N - 1]}px`);

console.log('\n--- paste into src/game/poses.js ---');
console.log('  var RUN = [\n' + OUT.map(p => '    pz(' + p.map(r1).join(', ') + ')').join(',\n') + '\n  ];');
