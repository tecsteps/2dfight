/*
 * rig.js -- the articulated figure the sprites are baked from.
 *
 * Mechner filmed his brother on VHS and traced the frames. We can't film
 * anybody, so the substitute is a jointed figure driven by absolute limb
 * angles, posed by hand to match the motion the rotoscope produced. Same
 * end product: a stack of finished bitmaps. The runtime never sees this.
 *
 * Angle convention: degrees, screen-style (y down), so 90 = straight down,
 * -90 = straight up, 0 = forward (the direction the sprite faces), 180 =
 * behind. Every angle is absolute, not relative to its parent -- authoring
 * a pose then means describing the silhouette you want, not doing forward
 * kinematics in your head.
 *
 * Pose layout (14 numbers):
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

  // limb lengths, 1x pixels
  var L = {
    torso: 14.8, neck: 2.6, headR: 4.0,
    uArm: 8.6, lArm: 7.6, hand: 2.2,
    uLeg: 13.5, lLeg: 12.5, foot: 6,
    sword: 25
  };

  var D2R = Math.PI / 180;

  function adv(x, y, ang, len) {
    var a = ang * D2R;
    return [x + Math.cos(a) * len, y - Math.sin(a) * len];
  }

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

  /* Wardrobes. Same rig, different bytes -- the guard is the prince in a
   * blue coat and a helmet, which is also roughly what the original did. */
  P.SKINS = {
    prince: {
      clothD: C.CLOTH_D, clothM: C.CLOTH_M, clothL: C.CLOTH_L, clothH: C.CLOTH_H,
      skinD: C.SKIN_D, skinM: C.SKIN_M, skinL: C.SKIN_L,
      hair: C.HAIR_D, hair2: C.HAIR_M,
      sashD: C.RED_D, sashM: C.RED_M,
      bootD: C.BRICK_S, bootM: C.BRICK_D,
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

  /* Draw one leg chain. `far` picks the darker shade set so the two legs
   * separate visually without any depth buffer. */
  function drawLeg(cv, hip, angs, sk, far) {
    cv.partId = far ? PART.FAR_LEG : PART.NEAR_LEG;
    var cloth = far ? sk.clothD : sk.clothM;
    var clothHi = far ? sk.clothM : sk.clothL;
    var boot = far ? sk.bootD : sk.bootM;
    var knee = adv(hip[0], hip[1], angs[0], L.uLeg);
    var ankle = adv(knee[0], knee[1], angs[1], L.lLeg);
    // baggy trouser on the thigh, tapering at the knee
    cap(cv, hip, knee, 3.9, 3.1, cloth);
    // shin: trouser to mid-calf, then boot
    var mid = [knee[0] + (ankle[0] - knee[0]) * 0.55, knee[1] + (ankle[1] - knee[1]) * 0.55];
    cap(cv, knee, mid, 3.1, 2.5, clothHi);
    cap(cv, mid, ankle, 2.4, 2.0, boot);
    var toe = adv(ankle[0], ankle[1], angs[2], L.foot);
    cap(cv, ankle, toe, 2.2, 1.5, boot);
  }

  function drawArm(cv, sh, angs, sk, far) {
    cv.partId = far ? PART.FAR_ARM : PART.NEAR_ARM;
    var sleeve = far ? sk.clothD : sk.clothL;
    var skin = far ? sk.skinM : sk.skinL;
    var elbow = adv(sh[0], sh[1], angs[0], L.uArm);
    var wrist = adv(elbow[0], elbow[1], angs[1], L.lArm);
    // short sleeve down to mid-upper-arm, bare forearm below
    var sleeveEnd = [sh[0] + (elbow[0] - sh[0]) * 0.58, sh[1] + (elbow[1] - sh[1]) * 0.58];
    cap(cv, sh, sleeveEnd, 3.0, 2.3, sleeve);
    cap(cv, sleeveEnd, elbow, 1.9, 1.6, skin);
    cap(cv, elbow, wrist, 1.6, 1.35, skin);
    dot(cv, wrist, 1.5, skin);
    return wrist;
  }

  function drawSword(cv, wrist, ang, sk) {
    cv.partId = PART.SWORD;
    var tip = adv(wrist[0], wrist[1], ang, L.sword);
    var base = adv(wrist[0], wrist[1], ang, -3);
    // crossguard
    var g1 = adv(wrist[0], wrist[1], ang + 90, 3.2);
    var g2 = adv(wrist[0], wrist[1], ang - 90, 3.2);
    cap(cv, base, wrist, 1.6, 1.6, C.STEEL_D);
    cap(cv, g1, g2, 1.2, 1.2, C.GOLD);
    cap(cv, wrist, tip, 1.9, 0.9, C.STEEL_L);
  }

  /* Draw a full pose. Painter's order: far limbs, body, near limbs. */
  function drawPose(cv, p, sk, opts) {
    opts = opts || {};
    var hipX = p[0], hipY = p[1];
    var hip = [hipX, hipY];
    var torsoA = p[2], headA = p[3];

    var neck = adv(hipX, hipY, torsoA, L.torso);
    var headBase = adv(neck[0], neck[1], headA, L.neck);
    var headC = adv(headBase[0], headBase[1], headA, L.headR * 0.9);

    // shoulders sit slightly below the neck joint along the torso axis
    var sh = [neck[0] - Math.cos(torsoA * D2R) * 1.2, neck[1] + Math.sin(torsoA * D2R) * 1.2];
    // hips splay a touch so the two legs don't start from one point
    var hipF = [hipX - 0.6, hipY], hipN = [hipX + 0.6, hipY];

    drawLeg(cv, hipF, [p[8], p[9], p[10]], sk, true);
    var farWrist = drawArm(cv, sh, [p[4], p[5]], sk, true);
    if (opts.swordFar) drawSword(cv, farWrist, opts.swordFar, sk);

    // torso: wide at the chest, narrow at the waist
    cv.partId = PART.TORSO;
    var chest = [hipX + (neck[0] - hipX) * 0.60, hipY + (neck[1] - hipY) * 0.60];
    cap(cv, hip, chest, 3.9, 4.5, sk.clothM);
    cap(cv, chest, neck, 4.3, 2.3, sk.clothL);
    // sash at the waist
    var w1 = [hipX + (chest[0] - hipX) * 0.04, hipY + (chest[1] - hipY) * 0.04];
    var w2 = [hipX + (chest[0] - hipX) * 0.32, hipY + (chest[1] - hipY) * 0.32];
    cap(cv, w1, w2, 4.2, 4.3, sk.sashM);
    cap(cv, w1, w2, 3.0, 3.1, sk.sashD);

    // neck + head
    cv.partId = PART.HEAD;
    cap(cv, neck, headBase, 1.9, 1.9, sk.skinM);
    R.disc(cv, cx(headC[0]), cy(headC[1]), L.headR * Z, sk.skinL);
    // brow/nose bump on the forward side
    var nose = adv(headC[0], headC[1], headA + 90, L.headR * 0.82);
    R.disc(cv, cx(nose[0]), cy(nose[1]), 1.0 * Z, sk.skinL);
    // hair cap over the back and top of the skull
    if (sk.helmet) {
      var hTop = adv(headC[0], headC[1], headA, L.headR * 0.55);
      R.disc(cv, cx(hTop[0]), cy(hTop[1]), L.headR * 0.95 * Z, sk.helmet);
      var hBack = adv(headC[0], headC[1], headA - 90, L.headR * 0.75);
      R.disc(cv, cx(hBack[0]), cy(hBack[1]), L.headR * 0.8 * Z, C.STEEL_D);
    } else {
      var top = adv(headC[0], headC[1], headA, L.headR * 0.26);
      R.disc(cv, cx(top[0]), cy(top[1]), L.headR * 0.86 * Z, sk.hair);
      var back = adv(headC[0], headC[1], headA - 90, L.headR * 0.50);
      R.disc(cv, cx(back[0]), cy(back[1]), L.headR * 0.76 * Z, sk.hair2);
      // face has to survive the hair discs -- redraw the forward cheek
      var face = adv(headC[0], headC[1], headA + 90, L.headR * 0.50);
      R.disc(cv, cx(face[0]), cy(face[1]), L.headR * 0.64 * Z, sk.skinL);
    }
    // eye
    var eye = adv(headC[0], headC[1], headA + 74, L.headR * 0.58);
    R.disc(cv, cx(eye[0]), cy(eye[1]), 0.75 * Z, C.OUTLINE);

    drawLeg(cv, hipN, [p[11], p[12], p[13]], sk, false);
    var nearWrist = drawArm(cv, sh, [p[6], p[7]], sk, false);
    if (opts.sword) drawSword(cv, nearWrist, opts.sword, sk);
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
    // keep the reference column in the same place after the squash
    var newOx = Math.round(spr.ox * f);
    return { w: nw, h: spr.h, ox: newOx, oy: spr.oy, data: out };
  }

  /* Bake one pose into a finished, cropped, outlined indexed sprite. */
  var _cv = null;
  function bakePose(pose, sk, opts) {
    if (!_cv) _cv = new P.RasterCanvas(BW * Z, BH * Z);
    _cv.clear();
    drawPose(_cv, pose, sk, opts);
    var lo = R.downsample(_cv, BW * RES, BH * RES);
    var px = R.outline(lo.color, BW * RES, BH * RES, C.OUTLINE, lo.part);
    var spr = R.crop(px, BW * RES, BH * RES, REF_X * RES, REF_Y * RES);
    var xs = pose[14];
    if (xs !== undefined && xs < 0.999) spr = squashX(spr, xs);
    return spr;
  }

  /* Where the near hand ends up for a given pose -- needed because the
   * sword is a separate bitmap, exactly as it was in the original frame
   * table (which carried an `image` and a `sword` field per frame). */
  function nearWrist(p) {
    var neck = adv(p[0], p[1], p[2], L.torso);
    var sh = [neck[0] - Math.cos(p[2] * D2R) * 1.5, neck[1] + Math.sin(p[2] * D2R) * 1.5];
    var elbow = adv(sh[0], sh[1], p[6], L.uArm);
    return adv(elbow[0], elbow[1], p[7], L.lArm);
  }

  /* Bake just the blade, so an unarmed prince and an armed one share one
   * set of body frames. */
  function bakeSword(pose, angle) {
    if (!_cv) _cv = new P.RasterCanvas(BW * Z, BH * Z);
    _cv.clear();
    var w = nearWrist(pose);
    drawSword(_cv, w, angle, P.SKINS.prince);
    var lo = R.downsample(_cv, BW * RES, BH * RES);
    var px = R.outline(lo.color, BW * RES, BH * RES, C.OUTLINE, lo.part);
    var spr = R.crop(px, BW * RES, BH * RES, REF_X * RES, REF_Y * RES);
    var xs = pose[14];
    if (xs !== undefined && xs < 0.999) spr = squashX(spr, xs);
    return spr;
  }

  P.Rig = {
    L: L,
    drawPose: drawPose,
    bakePose: bakePose,
    bakeSword: bakeSword,
    nearWrist: nearWrist,
    squashX: squashX,
    adv: adv
  };
})(POP);
