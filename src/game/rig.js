/*
 * rig.js -- the articulated figure the sprites are baked from.
 *
 * Mechner filmed his brother running around in white clothes and traced the
 * frames. We can't film anybody and we can't copy his drawings, so the
 * substitute is to rebuild what the rotoscope was actually capturing: real
 * human proportions, and real weight.
 *
 * The first version of this file drew tapered capsules on a stick figure,
 * and it read as a jointed doll -- no shoulders, no chest, no calves, no
 * shoes. A human silhouette is not a set of tubes. It has a deltoid over
 * the shoulder joint, a ribcage wider than the waist, a quadriceps that
 * bulges above the knee and a calf that bulges below it, and a foot that is
 * a wedge, not a cylinder. Those are what the eye reads at this size, so
 * they are what the rig draws.
 *
 * Angle convention: degrees, screen-style (y down), so 90 = straight down,
 * -90 = straight up, 0 = forward (the direction the sprite faces), 180 =
 * behind. Every angle is absolute, not relative to its parent -- authoring
 * a pose means describing the silhouette you want, not doing forward
 * kinematics in your head.
 *
 * Pose layout (14 numbers, plus an optional x-squash):
 *   [ hipX, hipY, torso, head,
 *     farShoulder, farElbow, nearShoulder, nearElbow,
 *     farHip, farKnee, farFoot, nearHip, nearKnee, nearFoot ]
 * hipY is height above the floor line, hipX is offset from the body axis.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var R = P.Raster, C = P.C;
  var SS = R.SS;
  var RES = P.RES;             // device pixels per logical pixel
  var Z = RES * SS;            // total oversample while drawing

  // bake canvas in logical units; reference point is the feet on the floor
  var BW = 88, BH = 96, REF_X = 44, REF_Y = 76;

  P.Bake = { W: BW, H: BH, REF_X: REF_X, REF_Y: REF_Y, RES: RES };

  /* Proportions, measured off the original's own sprite atlas rather than
   * guessed. The standing frame there (kid-15) is 12x41 pixels, in a storey
   * 63 tall -- so the character occupies about two thirds of the room's
   * height, not the five sixths an earlier version of this rig assumed.
   *
   * The other thing the atlas shows is that he is not built like a fashion
   * illustration: the head is large, the torso long, the legs comparatively
   * short. About five and a half heads tall, not seven. Getting that wrong
   * is most of what made the figure read as a doll.
   */
  var L = {
    torso: 13.5,        // hip centre to shoulder line
    neck: 2.2,
    headW: 3.1, headH: 3.6,
    shoulderW: 3.0,     // deltoid radius
    uArm: 7.6, lArm: 6.6,
    uLeg: 10.5, lLeg: 9.5, foot: 5.6,
    sword: 21
  };

  /* Poses author hipX/hipY in the old, taller coordinate space. Rather than
   * rewrite sixty pose rows, scale the root here -- every angle stays valid,
   * and the whole figure shrinks to the atlas's proportions on one knob. */
  var POSE_SCALE = 0.755;

  var D2R = Math.PI / 180;

  function adv(x, y, ang, len) {
    var a = ang * D2R;
    return [x + Math.cos(a) * len, y - Math.sin(a) * len];
  }
  function dir(ang) { var a = ang * D2R; return [Math.cos(a), -Math.sin(a)]; }
  function add(p, d, k) { return [p[0] + d[0] * k, p[1] + d[1] * k]; }
  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

  // pose space (x right, y up from floor) -> supersampled canvas space
  function cx(x) { return (REF_X + x) * Z; }
  function cy(y) { return (REF_Y - y) * Z; }

  /* Part ids, ordered back-to-front. The outline pass darkens whichever
   * side of a boundary has the lower id, so a near limb always cuts a clean
   * dark edge into whatever it overlaps. */
  var PART = { FAR_LEG: 1, FAR_ARM: 2, TORSO: 3, HEAD: 4, NEAR_LEG: 5, NEAR_ARM: 6, SWORD: 7 };

  function cap(cv, a, b, r0, r1, col) {
    R.capsule(cv, cx(a[0]), cy(a[1]), cx(b[0]), cy(b[1]), r0 * Z, r1 * Z, col);
  }
  function dot(cv, a, r, col) { R.disc(cv, cx(a[0]), cy(a[1]), r * Z, col); }

  function poly(cv, pts, col) {
    var f = [];
    for (var i = 0; i < pts.length; i++) { f.push(cx(pts[i][0]), cy(pts[i][1])); }
    R.fillPoly(cv, f, col);
  }

  /* A limb with a shaped profile: radii are sampled evenly from a to b, so
   * [4.7, 4.4, 3.4] gives a thigh that is full at the top and narrows into
   * the knee, and [3.3, 3.6, 2.0] gives a calf that swells then tapers to
   * the ankle. This is the single biggest difference between "leg" and
   * "tube" at fifty pixels tall. */
  function limb(cv, a, b, radii, col) {
    var n = radii.length;
    for (var i = 0; i < n - 1; i++) {
      cap(cv, mix(a, b, i / (n - 1)), mix(a, b, (i + 1) / (n - 1)), radii[i], radii[i + 1], col);
    }
  }

  // rotated oval, as a polygon -- the raster only does axis-aligned ellipses
  function oval(cv, c, rx, ry, ang, col) {
    var d = dir(ang), n = [-d[1], d[0]];
    var pts = [];
    for (var i = 0; i < 18; i++) {
      var t = i / 18 * Math.PI * 2;
      var u = Math.cos(t) * ry, v = Math.sin(t) * rx;
      pts.push([c[0] + d[0] * u + n[0] * v, c[1] + d[1] * u + n[1] * v]);
    }
    poly(cv, pts, col);
  }

  /* Wardrobes. Same rig, different bytes -- the guard is the prince in a
   * blue coat, which is roughly what the original did too. */
  P.SKINS = {
    prince: {
      clothD: C.CLOTH_D, clothM: C.CLOTH_M, clothL: C.CLOTH_L, clothH: C.CLOTH_H,
      skinD: C.SKIN_D, skinM: C.SKIN_M, skinL: C.SKIN_L,
      hair: C.HAIR_D, hair2: C.HAIR_M,
      sashD: C.CLOTH_M, sashM: C.CLOTH_L,
      bootD: C.SKIN_M, bootM: C.SKIN_L,
      helmet: 0
    },
    guard: {
      clothD: C.BLUE_D, clothM: C.BLUE_M, clothL: C.BLUE_L, clothH: C.BLUE_L,
      skinD: C.SKIN_D, skinM: C.SKIN_D, skinL: C.SKIN_M,
      hair: C.HAIR_D, hair2: C.HAIR_M,
      sashD: C.RED_D, sashM: C.RED_M,
      bootD: C.BRICK_S, bootM: C.BRICK_D,
      helmet: C.STEEL_M
    },
    skeleton: {
      clothD: C.BRICK_S, clothM: C.BRICK_D, clothL: C.BRICK_MD, clothH: C.CREAM,
      skinD: C.BRICK_D, skinM: C.STONE_H, skinL: C.CREAM,
      hair: C.OUTLINE, hair2: C.BRICK_S,
      sashD: C.BRICK_S, sashM: C.BRICK_D,
      bootD: C.BRICK_S, bootM: C.BRICK_D,
      helmet: 0
    }
  };

  /* Every joint position for a pose, computed once and shared by the
   * renderer and by anything else that needs to know where a hand is. */
  function rigPoints(p) {
    var hip = [p[0] * POSE_SCALE, p[1] * POSE_SCALE];
    var torsoA = p[2], headA = p[3];
    var neck = adv(hip[0], hip[1], torsoA, L.torso);
    // shoulders sit just below the top of the spine
    var sh = adv(neck[0], neck[1], torsoA, -1.4);
    var headBase = adv(neck[0], neck[1], headA, L.neck);
    var headC = adv(headBase[0], headBase[1], headA, L.headH * 0.82);

    function arm(sa, ea) {
      var elbow = adv(sh[0], sh[1], sa, L.uArm);
      var wrist = adv(elbow[0], elbow[1], ea, L.lArm);
      return { elbow: elbow, wrist: wrist };
    }
    function leg(hx, ha, ka, fa) {
      var h = [hx, hip[1]];
      var knee = adv(h[0], h[1], ha, L.uLeg);
      var ankle = adv(knee[0], knee[1], ka, L.lLeg);
      return { hip: h, knee: knee, ankle: ankle, footA: fa };
    }

    return {
      hip: hip, torsoA: torsoA, headA: headA,
      neck: neck, sh: sh, headBase: headBase, headC: headC,
      farArm: arm(p[4], p[5]), nearArm: arm(p[6], p[7]),
      farLeg: leg(hip[0] - 1.1, p[8], p[9], p[10]),
      nearLeg: leg(hip[0] + 1.1, p[11], p[12], p[13])
    };
  }

  /* A shoe: heel, sole, toe box. Drawn as a wedge because that is what a
   * foot's silhouette is, and a capsule toe was reading as a club. */
  function drawShoe(cv, ankle, footA, col, dark) {
    var f = dir(footA), u = [-f[1], f[0]];   // f is along the foot, u is up
    var heel = add(add(ankle, f, -2.7), u, -0.6);
    poly(cv, [
      add(heel, u, 1.9),
      add(add(ankle, f, 1.4), u, 1.7),
      add(add(ankle, f, L.foot * 0.62), u, 0.7),
      add(add(ankle, f, L.foot + 0.6), u, -1.1),
      add(add(ankle, f, L.foot + 0.2), u, -2.2),
      add(add(ankle, f, -2.4), u, -2.2),
      heel
    ], col);
    // sole
    poly(cv, [
      add(add(ankle, f, L.foot + 0.4), u, -1.5),
      add(add(ankle, f, L.foot + 0.2), u, -2.3),
      add(add(ankle, f, -2.5), u, -2.3),
      add(add(ankle, f, -2.6), u, -1.5)
    ], dark);
  }

  function drawLeg(cv, lg, sk, far) {
    cv.partId = far ? PART.FAR_LEG : PART.NEAR_LEG;
    var cloth = far ? sk.clothD : sk.clothM;
    var clothHi = far ? sk.clothM : sk.clothL;
    var boot = far ? sk.bootD : sk.bootM;
    var bootD = far ? C.SHADOW : sk.bootD;
    // thigh: full at the glute, narrowing into the knee
    limb(cv, lg.hip, lg.knee, [3.8, 3.5, 2.7], cloth);
    // shank: trouser to mid-calf with the calf swell, then the boot
    var mid = mix(lg.knee, lg.ankle, 0.52);
    limb(cv, lg.knee, mid, [2.6, 2.9], clothHi);
    limb(cv, mid, lg.ankle, [2.4, 1.7], boot);
    drawShoe(cv, lg.ankle, lg.footA, boot, bootD);
  }

  function drawArm(cv, sh, a, sk, far) {
    cv.partId = far ? PART.FAR_ARM : PART.NEAR_ARM;
    var sleeve = far ? sk.clothD : sk.clothL;
    var skin = far ? sk.skinD : sk.skinL;
    // deltoid: the cap over the shoulder joint. Without it the arm looks
    // like it was pushed into a socket.
    dot(cv, sh, L.shoulderW, sleeve);
    var sleeveEnd = mix(sh, a.elbow, 0.55);
    limb(cv, sh, sleeveEnd, [2.7, 2.6], sleeve);
    limb(cv, sleeveEnd, a.elbow, [2.2, 1.8], skin);
    limb(cv, a.elbow, a.wrist, [1.9, 2.0, 1.4], skin);   // forearm swell
    // hand, oriented along the forearm
    var fa = Math.atan2(-(a.wrist[1] - a.elbow[1]), a.wrist[0] - a.elbow[0]) / D2R;
    oval(cv, add(a.wrist, dir(fa), 1.2), 1.25, 1.7, fa, skin);
  }

  function drawSword(cv, wrist, ang, sk) {
    cv.partId = PART.SWORD;
    var tip = adv(wrist[0], wrist[1], ang, L.sword);
    var base = adv(wrist[0], wrist[1], ang, -3);
    var g1 = adv(wrist[0], wrist[1], ang + 90, 3.2);
    var g2 = adv(wrist[0], wrist[1], ang - 90, 3.2);
    cap(cv, base, wrist, 1.6, 1.6, C.STEEL_D);
    cap(cv, g1, g2, 1.2, 1.2, C.GOLD);
    cap(cv, wrist, tip, 1.9, 0.9, C.STEEL_L);
  }

  function drawTorso(cv, r, sk) {
    cv.partId = PART.TORSO;
    var axis = dir(r.torsoA);                 // hip -> shoulders
    var fwd = dir(r.torsoA + 90);             // the way the figure faces
    function pt(u, perp) {
      return add(add(r.hip, axis, u * L.torso), fwd, perp);
    }
    /* Side-view silhouette: deep at the hips, pinched at the waist, full
     * through the chest, narrowing again at the shoulders. */
    poly(cv, [
      pt(-0.06, 3.2), pt(0.26, 2.6), pt(0.58, 3.7), pt(0.84, 3.9), pt(1.02, 2.7),
      pt(1.04, -2.8), pt(0.86, -3.7), pt(0.56, -3.6), pt(0.26, -2.8), pt(-0.06, -3.5)
    ], sk.clothM);
    // lit front plane of the chest
    poly(cv, [
      pt(0.30, 2.5), pt(0.58, 3.6), pt(0.84, 3.8), pt(1.0, 2.6),
      pt(0.98, 0.5), pt(0.60, 0.8), pt(0.32, 0.3)
    ], sk.clothL);
    // pelvis
    dot(cv, r.hip, 3.6, sk.clothM);
    // the sash. The kid's own palette has none -- the original dresses him
    // in plain cream head to foot -- so for him this is drawn in cloth
    // tones and simply reads as a belted waist.
    var w0 = pt(0.10, 0), w1 = pt(0.30, 0);
    cap(cv, w0, w1, 3.5, 3.6, sk.sashM);
    cap(cv, w0, w1, 2.6, 2.7, sk.sashD);
    // a tail of sash hanging at the back
    var t0 = add(pt(0.16, -3.0), axis, 0);
    var t1 = add(t0, dir(r.torsoA - 170), 4.4);
    cap(cv, t0, t1, 1.4, 0.9, sk.sashM);
  }

  function drawHead(cv, r, sk) {
    cv.partId = PART.HEAD;
    var headA = r.headA;
    var fwd = dir(headA + 90);
    // neck
    cap(cv, r.neck, r.headBase, 1.7, 1.6, sk.skinM);
    // cranium plus jaw: an oval with a wedge hung off the front-bottom
    oval(cv, r.headC, L.headW, L.headH, headA, sk.skinL);
    var jaw = add(add(r.headC, dir(headA), -1.4), fwd, 1.0);
    oval(cv, jaw, 2.5, 2.9, headA, sk.skinL);
    // brow and nose
    var nose = add(add(r.headC, fwd, L.headW * 0.86), dir(headA), 0.2);
    dot(cv, nose, 1.05, sk.skinL);

    if (sk.helmet) {
      oval(cv, add(r.headC, dir(headA), 0.9), L.headW * 1.02, L.headH * 0.78, headA, sk.helmet);
      dot(cv, add(r.headC, dir(headA - 90), 2.4), 2.4, C.STEEL_D);
      // nasal bar
      cap(cv, add(r.headC, fwd, L.headW * 0.75),
        add(add(r.headC, fwd, L.headW * 0.72), dir(headA), -2.4), 0.7, 0.6, C.STEEL_D);
    } else {
      // hair: a cap over the skull that runs down the back of the neck,
      // which is what gives the head a readable shape in silhouette
      oval(cv, add(r.headC, dir(headA), 0.55), L.headW * 1.00, L.headH * 0.84, headA, sk.hair);
      var nape = add(add(r.headC, dir(headA - 90), 2.2), dir(headA), -1.3);
      oval(cv, nape, 1.8, 2.3, headA, sk.hair);
      dot(cv, add(nape, dir(headA), -1.2), 1.4, sk.hair2);
      // face: reclaim the front of the skull from the hair
      poly(cv, [
        add(add(r.headC, fwd, 0.2), dir(headA), 2.6),
        add(add(r.headC, fwd, L.headW * 0.95), dir(headA), 0.9),
        add(add(r.headC, fwd, L.headW * 0.95), dir(headA), -1.8),
        add(add(r.headC, fwd, 1.4), dir(headA), -4.0),
        add(add(r.headC, fwd, -0.4), dir(headA), -2.0)
      ], sk.skinL);
      // fringe over the brow
      cap(cv, add(add(r.headC, fwd, 0.4), dir(headA), 3.2),
        add(add(r.headC, fwd, 3.0), dir(headA), 2.3), 1.5, 1.0, sk.hair);
    }
    // eye
    var eye = add(add(r.headC, fwd, L.headW * 0.60), dir(headA), 0.55);
    dot(cv, eye, 0.72, C.OUTLINE);
  }

  /* Draw a full pose. Painter's order: far limbs, body, near limbs. */
  function drawPose(cv, p, sk, opts) {
    opts = opts || {};
    var r = rigPoints(p);
    drawLeg(cv, r.farLeg, sk, true);
    drawArm(cv, r.sh, r.farArm, sk, true);
    if (opts.swordFar) drawSword(cv, r.farArm.wrist, opts.swordFar, sk);
    drawTorso(cv, r, sk);
    drawHead(cv, r, sk);
    drawLeg(cv, r.nearLeg, sk, false);
    drawArm(cv, r.sh, r.nearArm, sk, false);
    if (opts.sword) drawSword(cv, r.nearArm.wrist, opts.sword, sk);
  }

  /* Horizontal squash of a finished bitmap, nearest-neighbour, about the
   * reference column. Used for the turn: rather than draw three-quarter
   * views we compress the side view edge-on, which is exactly the sort of
   * bitmap trick the era ran on. */
  function squashX(spr, f) {
    var nw = Math.max(1, Math.round(spr.w * f));
    var out = new Uint8Array(nw * spr.h);
    for (var y = 0; y < spr.h; y++) {
      for (var x = 0; x < nw; x++) {
        var sx = Math.min(spr.w - 1, Math.floor((x + 0.5) / f));
        out[y * nw + x] = spr.data[y * spr.w + sx];
      }
    }
    return { w: nw, h: spr.h, ox: Math.round(spr.ox * f), oy: spr.oy, data: out };
  }

  var _cv = null;
  function canvas() {
    if (!_cv) _cv = new P.RasterCanvas(BW * Z, BH * Z);
    _cv.clear();
    return _cv;
  }
  function finish(cv, pose) {
    var lo = R.downsample(cv, BW * RES, BH * RES);
    var px = R.outline(lo.color, BW * RES, BH * RES, C.CLOTH_D, lo.part, null);
    var spr = R.crop(px, BW * RES, BH * RES, REF_X * RES, REF_Y * RES);
    var xs = pose[14];
    if (xs !== undefined && xs < 0.999) spr = squashX(spr, xs);
    return spr;
  }

  function bakePose(pose, sk, opts) {
    var cv = canvas();
    drawPose(cv, pose, sk, opts);
    return finish(cv, pose);
  }

  /* Bake just the blade, so an unarmed prince and an armed one share one set
   * of body frames -- the original's frame table carried `image` and `sword`
   * as separate fields for the same reason. */
  function bakeSword(pose, angle) {
    var cv = canvas();
    drawSword(cv, rigPoints(pose).nearArm.wrist, angle, P.SKINS.prince);
    return finish(cv, pose);
  }

  P.Rig = {
    L: L,
    POSE_SCALE: POSE_SCALE,
    drawPose: drawPose,
    bakePose: bakePose,
    bakeSword: bakeSword,
    rigPoints: rigPoints,
    nearWrist: function (p) { return rigPoints(p).nearArm.wrist; },
    squashX: squashX,
    adv: adv
  };
})(POP);
