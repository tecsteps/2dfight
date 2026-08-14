/*
 * draw.js -- render a solved fighter as lit volumes.
 *
 * Every body part is a capsule or an ellipsoid handed to the shader, which
 * recovers a surface normal per pixel and lights it. Nothing here is a
 * picture; it is a description of a solid, and the picture is the result.
 *
 * Depth is explicit rather than implied by paint order: the far arm is
 * simply further away, so when it crosses the chest the shader sorts it
 * correctly and the contact reads as an overlap rather than a seam.
 */
var FX = FX || {};
(function (F) {
  'use strict';

  var L = F.FighterL;

  // depth slices, smaller = nearer the viewer
  var Z = { farLeg: 34, farArm: 28, hipD: 22, torso: 20, belt: 17, neck: 16,
    head: 12, hair: 10, nearLeg: 6, nearArm: 1 };

  function shade(c, k) {
    return [Math.min(255, c[0] * k), Math.min(255, c[1] * k), Math.min(255, c[2] * k)];
  }

  function mkSkin(o) {
    /* The face materials are derived from the skin rather than authored, so
     * a new character only has to name one colour and still gets a socket
     * that is the right hue of dark and a lip that is the right hue of red.
     * They are built once: allocating them per frame inside drawHead was
     * three objects per head per frame for no reason. */
    var sk = o.skin;
    var dark = shade(sk, 0.70), deep = shade(sk, 0.52);
    var lit = shade(sk, 1.10);
    // barely shifted from skin. At a strong chroma shift this read as
    // lipstick on both fighters and muddled the character read entirely.
    var lip = [Math.min(255, sk[0] * 0.95), sk[1] * 0.83, sk[2] * 0.80];
    return {
      skin: F.mat(sk[0], sk[1], sk[2], 0.16, 16, 0.52, 1.0),
      // sockets, the underside of the jaw, the shadow beside the nose
      skinDark: F.mat(dark[0], dark[1], dark[2], 0.16, 24, 0.4, 1.0),
      skinDeep: F.mat(deep[0], deep[1], deep[2], 0.10, 18, 0.3, 0.9),
      // the planes that catch light: nose bridge, cheekbone, brow
      skinLit: F.mat(lit[0], lit[1], lit[2], 0.20, 20, 0.6, 1.0),
      lip: F.mat(lip[0], lip[1], lip[2], 0.34, 26, 0.4, 0.8),
      sclera: F.mat(232, 228, 232, 0.30, 26, 0.25),
      iris: F.mat(46, 38, 52, 0.80, 64, 0.3),
      // cloth has sheen at the edge, not a highlight in the middle
      gi: F.mat(o.gi[0], o.gi[1], o.gi[2], 0.015, 3, 0.62),
      gi2: F.mat(o.gi2[0], o.gi2[1], o.gi2[2], 0.015, 3, 0.54),
      trim: F.mat(o.trim[0], o.trim[1], o.trim[2], 0.16, 20, 0.5),
      /* Hair used to be spec 0.34 / gloss 34, which at this resolution put a
       * single hard highlight on the crown and made it read as moulded
       * vinyl. Real hair scatters: broad and weak. */
      hair: F.mat(o.hair[0], o.hair[1], o.hair[2], 0.10, 12, 0.62),
      hairLit: F.mat(Math.min(255, o.hair[0] * 1.55 + 14), Math.min(255, o.hair[1] * 1.5 + 12),
        Math.min(255, o.hair[2] * 1.45 + 16), 0.14, 14, 0.7),
      metal: F.mat(210, 218, 232, 0.75, 60, 1.0),
      /* Far-side copies of the garment and skin, pulled 22% toward the
       * ambient. Dimming a far limb with ambient occlusion alone kept its
       * chroma, so on a white gi the two legs fused into one shape from hip
       * to ankle and the far arm vanished into the chest during every
       * strike. Distance desaturates; it does not only darken. */
      giFar: F.mat(o.gi[0] * 0.62 + 14, o.gi[1] * 0.62 + 15, o.gi[2] * 0.62 + 20, 0.02, 4, 0.26),
      gi2Far: F.mat(o.gi2[0] * 0.62 + 14, o.gi2[1] * 0.62 + 15, o.gi2[2] * 0.62 + 20, 0.02, 4, 0.22),
      skinFar: F.mat(sk[0] * 0.62 + 14, sk[1] * 0.62 + 15, sk[2] * 0.62 + 20, 0.14, 22, 0.34, 0.9),
      trimFar: F.mat(o.trim[0] * 0.62 + 14, o.trim[1] * 0.62 + 15, o.trim[2] * 0.62 + 20, 0.10, 16, 0.34),
      name: o.name, tint: o.tint || [255, 210, 120],
      hairStyle: o.hairStyle,
      // per-character face proportions, so the two heads are not one head
      brow: o.brow || 1, jaw: o.jaw || 1, nose: o.nose || 1,
      /* ...and per-character build. A two-character roster's first job is
       * silhouette differentiation, and colour alone does not do it. */
      build: o.build || { chest: 1, waist: 1, hip: 1, shoulder: 1, limb: 1 }
    };
  }
  F.mkSkin = mkSkin;

  F.SKINS = {
    /* KAI: white gi, red belt, short topknot. The gi is authored well below
     * white -- at 238 the key light drove nearly the whole garment past
     * clipping and every fold vanished. */
    kai: mkSkin({
      name: 'KAI',
      skin: [232, 176, 138], gi: [206, 202, 196], gi2: [158, 154, 152],
      trim: [206, 46, 62], hair: [34, 30, 40], tint: [255, 220, 150],
      hairStyle: { n: 3, seg: 2.6, r0: 3.3, taper: 0.86, back: 0.62, up: 3.2, grav: 520 },
      brow: 1.15, jaw: 1.10, nose: 1.0,
      // KAI: compact and planted -- deeper chest, thicker limbs
      build: { chest: 1.10, waist: 1.06, hip: 1.04, shoulder: 1.08, limb: 1.06 }
    }),
    /* RYO: blue gi, gold belt, a long braid that swings. Narrower jaw and a
     * lighter brow so the two silhouettes are not the same face. */
    ryo: mkSkin({
      name: 'RYO',
      skin: [206, 150, 112], gi: [58, 92, 168], gi2: [40, 66, 124],
      trim: [242, 196, 72], hair: [58, 40, 30], tint: [150, 200, 255],
      hairStyle: { n: 4, seg: 3.2, r0: 3.4, taper: 0.84, back: 0.86, up: 0.4, grav: 700 },
      brow: 0.86, jaw: 0.92, nose: 1.12,
      // RYO: lean and rangy -- narrower through the body, longer in the limb
      build: { chest: 0.92, waist: 0.94, hip: 0.96, shoulder: 0.94, limb: 0.94 }
    })
  };

  function lerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function ang(a, b) { return Math.atan2(b[1] - a[1], b[0] - a[0]); }

  /* Bounding box for the depth-clear and shader clip. Generous: hair and a
   * fully extended kick both leave the body's own footprint. */
  F.fighterBounds = function (f) {
    var p = f.pose();
    var xs = [p.hip[0], p.headC[0]], ys = [p.hip[1], p.headC[1]];
    for (var i = 0; i < 2; i++) {
      xs.push(p.arms[i].wrist[0], p.arms[i].elbow[0]);
      ys.push(p.arms[i].wrist[1], p.arms[i].elbow[1]);
      xs.push(p.legs[i].ankle[0], p.legs[i].knee[0]);
      ys.push(p.legs[i].ankle[1], p.legs[i].knee[1]);
    }
    for (var h = 0; h < f.hair.length; h++) { xs.push(f.hair[h].x); ys.push(f.hair[h].y); }
    return {
      x0: Math.min.apply(null, xs) - 26, x1: Math.max.apply(null, xs) + 26,
      y0: Math.min.apply(null, ys) - 26, y1: Math.max.apply(null, ys) + 30
    };
  };

  /* The contact shadow. Cheap, and it is most of what glues a character to
   * the floor -- without it a fighter looks pasted on. */
  F.drawShadowAt = function (surf, f, groundY, S, ox, oy) {
    S = S || 1; ox = ox || 0; oy = oy || 0;
    var lift = Math.max(0, groundY - f.y);
    var k = Math.max(0.34, 1 - lift / 150);
    var gy = (groundY + 2) * S + oy;
    /* One pool under the hips, and a tighter one under each foot weighted by
     * how close that foot is to the floor. Pinning the whole shadow to f.x
     * meant a sweep or a low kick put the extended leg over bare ground and
     * the fighter read as floating. */
    var p = f.pose();
    surf.shadowEllipse((p.hip[0] + 2) * S + ox, gy, 30 * k * S, 8 * k * S, 0.38 * k);
    for (var i = 0; i < 2; i++) {
      var a = p.legs[i].ankle;
      var near = Math.max(0, 1 - Math.max(0, groundY - a[1]) / 46);
      if (near <= 0.02) continue;
      surf.shadowEllipse(a[0] * S + ox, gy, (7 + 6 * near) * k * S,
        (2.6 + 1.6 * near) * k * S, 0.50 * k * near);
    }
  };

  F.drawShadow = function (surf, f, groundY, S) {
    S = S || 1;
    var lift = Math.max(0, groundY - f.y);
    var k = Math.max(0.34, 1 - lift / 150);
    // broad soft pool, then a tight dark core under the weight -- the core
    // is what actually glues a figure to the floor
    surf.shadowEllipse((f.x + 4) * S, (groundY + 2) * S, 34 * k * S, 9 * k * S, 0.44 * k);
    surf.shadowEllipse((f.x + 4) * S, (groundY + 2) * S, 15 * k * S, 4.2 * k * S, 0.58 * k);
  };

  F.drawFighter = function (sh, f, poseOverride, ghost) {
    var p = poseOverride || f.pose();
    var sk = f.skin;
    var fw = p.fw;
    sh.ghost = ghost || 0;

    sh.tint = f.flash;
    sh.tintR = sk.tint[0]; sh.tintG = sk.tint[1]; sh.tintB = sk.tint[2];

    sh.clearOcc();
    sh.addOcc(p.chest[0], p.chest[1], L.chestD * 1.7, Z.torso, 0.55);
    sh.addOcc(p.waist[0], p.waist[1], L.waistD * 1.7, Z.torso, 0.5);
    sh.addOcc(p.hip[0], p.hip[1], L.hipD * 1.7, Z.torso, 0.5);
    sh.addOcc(p.headC[0], p.headC[1], L.headRX * 1.5, Z.head, 0.5);
    sh.addOcc(p.shoulders[1][0], p.shoulders[1][1], L.shoulderR * 1.4, Z.torso - 2, 0.45);
    sh.addOcc(p.arms[1].wrist[0], p.arms[1].wrist[1], 9, Z.nearArm, 0.4);

    /* Which shoulder is toward the viewer follows the twist. It used to be
     * hardcoded as arm 1, while the twist swings forty degrees during every
     * strike -- so on a hook or a roundhouse the arm that should have come
     * forward was drawn twenty-seven depth units *behind* the torso and
     * disappeared into it. The near and far depths interpolate rather than
     * snapping, or the arms would pop mid-swing. */
    var tw = Math.sin((p.twist || 0) * Math.PI / 180);
    var swap = 0.5 + 0.5 * Math.max(-1, Math.min(1, tw * 2.2));   // 0..1
    var zArm1 = Z.nearArm + (Z.farArm - Z.nearArm) * swap;
    var zArm0 = Z.farArm + (Z.nearArm - Z.farArm) * swap;
    var far = swap > 0.5 ? 1 : 0, near = 1 - far;
    var zFarArm = far ? zArm1 : zArm0, zNearArm = far ? zArm0 : zArm1;

    // the far limbs cast into the near ones as well as receiving
    sh.addOcc(p.arms[near].elbow[0], p.arms[near].elbow[1], 11, Z.torso - 4, 0.45);
    sh.addOcc(p.legs[1].knee[0], p.legs[1].knee[1], 13, Z.torso, 0.40);

    drawHem(sh, p, f, sk, fw, 1);             // the panel behind both legs
    drawLeg(sh, sk, p.legs[0], 1, Z.farLeg, 0.66, fw);
    drawArm(sh, sk, p.arms[far], 1, zFarArm, 0.68, fw);

    drawTorso(sh, p, f, sk, fw);
    drawHead(sh, p, f, sk, fw);

    drawLeg(sh, sk, p.legs[1], 0, Z.nearLeg, 1.0, fw);
    drawHem(sh, p, f, sk, fw, 0);             // and the panel in front of them
    drawArm(sh, sk, p.arms[near], 0, zNearArm, 1.0, fw);
    sh.ghost = 0;
  };

  /* A gi panel hanging off the belt.
   *
   * Drawn as a flat slab rather than a tube, because cloth has a face and an
   * edge and a capsule has neither. The quad is built from the belt down to
   * the simulated hem point, splayed at the bottom, so the panel widens as
   * it falls and flares when the body moves under it. */
  function drawHem(sh, p, f, sk, fw, back) {
    var e = f.hem[back ? 1 : 0];
    var dir = back ? -fw : fw;
    var b = lerp(p.hip, p.waist, 0.30);
    var la = p.leanA * Math.PI / 180;
    // across the body at the belt
    var ax2 = Math.cos(la + Math.PI / 2), ay2 = Math.sin(la + Math.PI / 2);
    var t0 = [b[0] - ax2 * L.hipD * 0.30 + dir * 1.0, b[1] - ay2 * L.hipD * 0.30];
    var t1 = [b[0] + ax2 * L.hipD * 0.30 + dir * L.hipD * 1.05,
      b[1] + ay2 * L.hipD * 0.30];
    // hem edge, splayed toward the direction of travel
    var hxv = e.x - b[0], hyv = e.y - b[1];
    var hl = Math.sqrt(hxv * hxv + hyv * hyv) || 1;
    var pxv = -hyv / hl, pyv = hxv / hl;              // across the panel
    /* Narrow the panel as it swings away from vertical. Swung out sideways
     * during a sweep, a full-width panel presented its whole face edge-on
     * and rendered as a hard-edged black parallelogram behind the leg. */
    var upr = Math.max(0, hyv / hl);                  // 1 hanging, 0 horizontal
    var wsp = 4.8 * (0.30 + 0.70 * upr);
    var h0 = [e.x - pxv * wsp - dir * 0.6, e.y - pyv * wsp];
    var h1 = [e.x + pxv * wsp + dir * 2.6, e.y + pyv * wsp];
    var z = back ? Z.farLeg + 5 : Z.nearLeg - 3.4;
    var quad = dir > 0 ? [t0, t1, h1, h0] : [t1, t0, h0, h1];
    sh.polySlab(quad, z, back ? sk.gi2 : sk.gi, 2.6, back ? 0.72 : 0.96);
    /* A weighted edge along the hem. A bevelled slab alone reads as a flat
     * shape cut out of card; the thing that says "cloth" is a defined,
     * slightly darker border where the fabric turns over. */
    sh.capsule(h0[0], h0[1], h1[0], h1[1], 1.5, 1.7, z - 0.9,
      back ? sk.gi2 : sk.gi2, back ? 0.7 : 0.94);
  }

  /* Pick the near or far material set. */
  function matsOf(sk, far) {
    return far
      ? { gi: sk.giFar, gi2: sk.gi2Far, skin: sk.skinFar, trim: sk.trimFar,
          skinLit: sk.skinFar, skinDark: sk.skinFar }
      : sk;
  }

  function drawLeg(sh, sk0, lg, far, z, ao, fw) {
    var sk = matsOf(sk0, far), B = sk0.build.limb;
    /* Segment radii are continuous across every joint now, and consecutive
     * segments overlap rather than butt together. Restarting a segment at a
     * different radius, one depth step in front of the last, left a hard
     * crescent of light at every knee and elbow. */
    /* The leg's profile is deliberately non-monotonic.
     *
     * It used to taper straight from 8.2 at the hip to 3.2 at the ankle, so
     * an extended kick was one smooth cone with no knee anywhere in the
     * outline -- the shape carried no information about where the joint was
     * or which way it bent. A real leg swells at the thigh, pinches at the
     * knee, swells again at the calf a third of the way down the shin, then
     * runs thin to the ankle. That silhouette is what makes a kick read. */
    var thM = lerp(lg.hip, lg.knee, 0.45);
    sh.capsule(lg.hip[0], lg.hip[1], thM[0], thM[1], 8.2 * B, 7.6 * B, z, sk.gi, ao);
    sh.capsule(thM[0], thM[1], lg.knee[0], lg.knee[1], 7.6 * B, 5.0 * B, z, sk.gi, ao);
    // trouser cuff just below the knee
    var cuff = lerp(lg.knee, lg.ankle, 0.30);
    sh.capsule(lg.knee[0], lg.knee[1], cuff[0], cuff[1], 5.0 * B, 5.6 * B, z, sk.gi, ao);
    // calf: widest a third of the way down, starting inside the cuff
    var calf = lerp(lg.knee, lg.ankle, 0.44);
    sh.capsule(lg.knee[0], lg.knee[1], calf[0], calf[1], 4.6, 5.9, z, sk.skin, ao);
    sh.capsule(calf[0], calf[1], lg.ankle[0], lg.ankle[1], 5.9, 2.8, z, sk.skin, ao);
    /* Foot. A single capsule off the ankle gave every character a rounded
     * stump, and a stump has no direction -- you cannot tell a planted foot
     * from a pointed one, which is most of what sells a kick. This is a
     * heel, an arch and a ball with toes, built along the foot's own axis. */
    var a = (lg.angle || 0) * Math.PI / 180;
    var fx = Math.cos(a) * fw, fy = Math.sin(a);        // toe direction
    var ux = -fy, uy = fx;                             // up off the sole
    var ank = [lg.ankle[0], lg.ankle[1] + 0.6];
    function ft(along, up) {
      return [ank[0] + fx * along + ux * up * fw, ank[1] + fy * along + uy * up * fw];
    }
    var heel = ft(-3.6, 0.2), ball = ft(L.foot * 0.60, -0.4), toe = ft(L.foot * 0.86, -0.6);
    // heel, then the sole tapering forward
    sh.capsule(heel[0], heel[1], ball[0], ball[1], 3.9, 3.2, z - 2, sk.skin, ao);
    sh.capsule(ball[0], ball[1], toe[0], toe[1], 3.1, 2.2, z - 2.4, sk.skin, ao);
    // the instep: a raised wedge from the ankle down to the ball, which is
    // what gives the foot a top rather than a flat side
    var inst = ft(L.foot * 0.30, 2.0);
    sh.capsule(ank[0], ank[1] - 1.6, inst[0], inst[1], 3.4, 2.6, z - 1.4, sk.skin, ao);
    // ankle wrap
    /* Ankle wrap, in the character's trim colour and at a size that reads.
     * A bare foot against a pale gi is a ten-percent value difference, so
     * the foot had no ankle and every kick ended in a mitten. One banded
     * primitive gives the leg a joint, a colour accent and a direction. */
    var wrp = lerp(lg.knee, lg.ankle, 0.84);
    sh.capsule(wrp[0], wrp[1], lg.ankle[0], lg.ankle[1], 3.6, 4.5, z - 1, sk.trim, ao);
  }

  function drawArm(sh, sk0, a, far, z, ao, fw) {
    var sk = matsOf(sk0, far), B = sk0.build.limb;
    // deltoid: a cap angled down the upper arm, not a ball stuck on the
    // chest. The ball read unmistakably as a breast on both fighters, and
    // at a 7.0 front radius the capsule was still doing it.
    var delt = lerp(a.sh, a.elbow, 0.42);
    sh.capsule(a.sh[0], a.sh[1], delt[0], delt[1], 5.8 * B, 5.2 * B, z + 1, sk.gi, ao);
    /* Same non-monotonic profile as the leg. A monotonic 6.2 -> 3.5 taper
     * over the whole arm made every punch a single smooth sausage with the
     * elbow invisible -- most obvious on the cross and the super, where the
     * shoulder, elbow and wrist go nearly collinear. */
    var bic = lerp(a.sh, a.elbow, 0.44);
    sh.capsule(a.sh[0], a.sh[1], bic[0], bic[1], 5.8 * B, 6.6 * B, z, sk.gi, ao);
    var scuf = lerp(a.sh, a.elbow, 0.68);
    sh.capsule(bic[0], bic[1], scuf[0], scuf[1], 6.6 * B, 4.6 * B, z, sk.gi, ao);
    // elbow, then the forearm flaring below it and running thin to the wrist
    sh.capsule(scuf[0], scuf[1], a.elbow[0], a.elbow[1], 4.6 * B, 4.0 * B, z, sk.skin, ao);
    var fa = lerp(a.elbow, a.wrist, 0.28);
    sh.capsule(a.elbow[0], a.elbow[1], fa[0], fa[1], 4.0, 4.9, z, sk.skin, ao);
    sh.capsule(fa[0], fa[1], a.wrist[0], a.wrist[1], 4.9, 2.9, z, sk.skin, ao);
    /* Wrist wrap and fist. A sphere on the end of the forearm is a ball,
     * and a ball has no knuckles and no direction -- a jab and a block ended
     * in exactly the same shape. A fist is a squarish block of knuckles
     * across the punch direction, with a thumb laid along the near side. */
    var wa = ang(a.elbow, a.wrist);
    var cw = Math.cos(wa), sw = Math.sin(wa);
    var px2 = -sw, py2 = cw;                            // across the forearm
    sh.capsule(a.wrist[0] - cw * 3, a.wrist[1] - sw * 3,
      a.wrist[0], a.wrist[1], 3.8, 4.0, z - 1, sk.trim, ao);
    // the block of the closed hand: wider across than along
    sh.ellipsoid(a.wrist[0] + cw * 2.4, a.wrist[1] + sw * 2.4,
      3.9, 4.6, wa, z - 2, sk.skin, ao);
    // knuckle row, standing proud of the front face
    var kx = a.wrist[0] + cw * 4.3, ky = a.wrist[1] + sw * 4.3;
    sh.capsule(kx - px2 * 3.0, ky - py2 * 3.0, kx + px2 * 3.0, ky + py2 * 3.0,
      2.0, 1.7, z - 3.2, sk.skin, ao);
    // thumb, folded across
    sh.capsule(a.wrist[0] + cw * 1.4 + px2 * 2.6 * fw, a.wrist[1] + sw * 1.4 + py2 * 2.6 * fw,
      a.wrist[0] + cw * 3.6 + px2 * 1.4 * fw, a.wrist[1] + sw * 3.6 + py2 * 1.4 * fw,
      1.7, 1.4, z - 3.4, sk.skin, ao);
  }

  function drawTorso(sh, p, f, sk, fw) {
    var la = p.leanA * Math.PI / 180;
    var B = sk.build;
    // pelvis, abdomen, chest -- three masses give the taper a real body has
    sh.ellipsoid(p.hip[0], p.hip[1], L.hipD * B.hip, L.hipH2, la + Math.PI / 2, Z.torso, sk.gi, 0.95);
    sh.ellipsoid(p.waist[0], p.waist[1], L.waistD * B.waist, L.waistH, la + Math.PI / 2, Z.torso, sk.gi, 0.98);
    sh.ellipsoid(p.chest[0], p.chest[1], L.chestD * B.chest, L.chestH, la + Math.PI / 2, Z.torso, sk.gi, 1);
    /* Trapezius: neck out to each shoulder. It used to swell from 5.2 at the
     * neck to 7.4 at the shoulder, putting a rounded mass on each side of
     * the sternum -- which, on a smooth chest, is exactly the shape of a
     * bust. The real muscle is a sheet: thick at the neck, thin at the tip. */
    for (var t2 = 0; t2 < 2; t2++) {
      sh.capsule(p.neck[0], p.neck[1], p.shoulders[t2][0], p.shoulders[t2][1],
        6.0 * B.shoulder, 4.4 * B.shoulder, Z.torso - 2, sk.gi, 1);
    }
    /* The pectoral shelf: a wide flat plane across the chest with a shadowed
     * lower edge. A chest without one is a dome, and a dome under cloth
     * reads as a bust no matter what colour it is. */
    var pec = lerp(p.chest, p.neck, 0.20);
    var pax = Math.cos(la + Math.PI / 2), pay = Math.sin(la + Math.PI / 2);
    sh.capsule(pec[0] - pax * L.chestD * 0.62 * B.chest, pec[1] - pay * L.chestD * 0.62 * B.chest,
      pec[0] + pax * L.chestD * 0.62 * B.chest, pec[1] + pay * L.chestD * 0.62 * B.chest,
      3.0, 3.0, Z.torso - 3.6, sk.gi, 1);
    var pecB = lerp(p.chest, p.waist, 0.18);
    sh.capsule(pecB[0] - pax * L.chestD * 0.56 * B.chest, pecB[1] - pay * L.chestD * 0.56 * B.chest,
      pecB[0] + pax * L.chestD * 0.56 * B.chest, pecB[1] + pay * L.chestD * 0.56 * B.chest,
      1.5, 1.2, Z.torso - 4.4, sk.gi2, 0.86);
    // latissimus: shoulder down to the waist. This is the V, and it fills
    // the armpit that was previously a hole.
    for (var t3 = 0; t3 < 2; t3++) {
      var top3 = lerp(p.shoulders[t3], p.waist, 0.22);
      sh.capsule(top3[0], top3[1], p.waist[0], p.waist[1],
        4.8, 3.0, Z.torso + 3, sk.gi, 0.9);
    }

    // the gi's open front: a darker panel down the centreline
    var top = lerp(p.chest, p.neck, 0.42), bot = lerp(p.hip, p.waist, 0.5);
    sh.capsule(top[0] + fw * 2.6, top[1], bot[0] + fw * 1.6, bot[1], 3.2, 4.4, Z.torso - 3, sk.gi2, 1);

    /* Cloth folds. A gi is loose fabric over a body, and a smooth ellipsoid
     * is neither -- unbroken, the chest mass reads as a bust rather than as
     * a garment. Two shallow diagonal creases from the near shoulder toward
     * the opposite hip are the cheapest thing that says "cloth". */
    for (var fd = 0; fd < 2; fd++) {
      var f0 = lerp(p.shoulders[1], p.chest, 0.30 + fd * 0.26);
      var f1 = lerp(p.waist, p.hip, 0.18 + fd * 0.30);
      sh.capsule(f0[0] + fw * (2.0 - fd * 0.7), f0[1],
        f1[0] - fw * (0.6 + fd * 0.9), f1[1],
        1.35, 1.05, Z.torso - 4.2, sk.gi2, 0.92);
    }
    // and one across the ribs, following the twist
    var rb0 = lerp(p.chest, p.waist, 0.52);
    sh.capsule(rb0[0] - fw * 4.6, rb0[1] - 1.2, rb0[0] + fw * 4.2, rb0[1] + 1.0,
      1.1, 0.85, Z.torso - 4.0, sk.gi2, 0.9);

    // belt
    var b0 = lerp(p.hip, p.waist, 0.62);
    sh.ellipsoid(b0[0], b0[1], L.waistD * 1.16, 4.4, la + Math.PI / 2, Z.belt, sk.trim, 1);
    // belt tails, from the verlet chain
    var prev = [b0[0] - fw * 2, b0[1] + 2];
    for (var i = 0; i < f.belt.length; i++) {
      var b = f.belt[i];
      sh.capsule(prev[0], prev[1], b.x, b.y, 3.4 - i * 0.6, 2.8 - i * 0.6, Z.belt - 1, sk.trim, 0.9);
      prev = [b.x, b.y];
    }
  }

  /* The head.
   *
   * The fighters face each other, so the head is always seen in near
   * profile, and a profile is carried almost entirely by its silhouette:
   * brow, nose, lips and chin have to *break the outline*, not sit painted
   * on an egg. Everything below is placed in a head-local frame -- `fwd`
   * runs toward the opponent, `up` runs toward the crown -- so the whole
   * face follows the head's tilt for free.
   *
   * Depth is the delicate part. Each primitive is a solid whose surface
   * bulges toward the viewer by its own mean radius, so a large volume can
   * swallow a small one placed nearer in z. That is why the hair is built
   * from masses that avoid the face rather than one cap laid over it: a cap
   * wide enough to cover the cranium also bulges out over the eye, and the
   * face went black behind it.
   */
  function drawHead(sh, p, f, sk, fw) {
    var ha = p.headA * Math.PI / 180;
    var fa = ha + Math.PI / 2 * fw;
    var fx = Math.cos(fa), fy = Math.sin(fa);          // toward the opponent
    var ux2 = Math.cos(ha), uy2 = Math.sin(ha);        // toward the crown
    var hx = p.headC[0], hy = p.headC[1];
    var R = L.headRX, RY = L.headRY;
    var BR = sk.brow, JW = sk.jaw, NS = sk.nose;   // per-character proportions

    function at(fwd, up) { return [hx + fx * fwd + ux2 * up, hy + fy * fwd + uy2 * up]; }

    /* Both helpers take the depth of the feature's *front surface*, not the
     * depth of its centre.
     *
     * This matters more than it sounds. A primitive's surface bulges toward
     * the viewer by its own mean radius, so at equal centre depth a large
     * volume comes forward and a small one does not. Layering the face by
     * centre depth therefore buried every small feature inside the skull it
     * was supposed to sit on: the eyelash was nominally two units in front
     * of the eye white and rendered a unit behind it. Ordering by front
     * surface is the thing the code actually means. */
    function fp(fwd, up, rx, ry, rot, zf, m, a) {
      sh.ellipsoid(hx + fx * fwd + ux2 * up, hy + fy * fwd + uy2 * up,
        rx, ry, ha + rot, zf + (rx + ry) * 0.5, m, a === undefined ? 1 : a);
    }
    function fc(f0, u0, f1, u1, r0, r1, zf, m, a) {
      sh.capsule(hx + fx * f0 + ux2 * u0, hy + fy * f0 + uy2 * u0,
        hx + fx * f1 + ux2 * u1, hy + fy * f1 + uy2 * u1,
        r0, r1, zf + (r0 > r1 ? r0 : r1), m, a === undefined ? 1 : a);
    }
    var HZ = Math.PI / 2;   // "upright in head space" for ellipsoid rotation
    var FS = 4.4;           // front of the skull; everything else is relative

    /* ---- neck ---- */
    var nb = at(0, -RY * 0.66);
    sh.capsule(p.neck[0], p.neck[1], nb[0], nb[1], 5.4, 4.9, Z.neck, sk.skin, 0.86);
    // sternocleidomastoid: the cord from behind the ear to the collarbone.
    // Without it the neck is a dowel.
    fc(-1.4, -RY * 0.55, 2.4, -RY * 1.22, 1.6, 1.15, FS + 2.6, sk.skinLit, 0.9);
    // the gi collar, so the neck meets the shoulders instead of vanishing
    fc(-3.6, -RY * 1.28, 3.4, -RY * 1.34, 2.6, 2.2, FS + 3.4, sk.gi2, 0.86);

    /* ---- skull and face masses ---- */
    // cranium, set back: the brain case is behind the face, not centred on it
    fp(-0.9, 1.5, R * 0.94, RY * 0.94, HZ, FS, sk.skin, 1);
    // cheek / maxilla
    fp(2.3, -1.0, R * 0.76, RY * 0.70, HZ, FS - 0.25, sk.skin, 1);
    // jaw, and a chin that leaves the outline
    fp(1.8, -5.2, 4.4 * JW, 3.1, HZ, FS - 0.35, sk.skin, 0.98);
    fp(4.5, -4.9, 1.9 * JW, 1.7, HZ, FS - 0.55, sk.skinLit, 1);
    // under-jaw shadow, sitting behind the jaw so it only shows at the edge
    fc(-2.0, -6.0, 3.2, -6.8, 2.2, 1.8, FS + 0.4, sk.skinDeep, 0.72);
    // cheekbone: the plane that catches light and gives the face structure
    fc(0.6, 1.4, 4.6, 0.2, 2.0, 1.4, FS - 0.45, sk.skinLit, 1);

    /* ---- brow, nose, mouth: the silhouette breakers ---- */
    /* Brow ridge, lit on top, and the shadow it drops into the socket.
     * Both used to be about twice this size, and together with the lash and
     * the fringe they stacked into one horizontal dark band -- the character
     * read as wearing sunglasses, and that band, not the eye, was what the
     * silhouette reported. */
    fc(0.6, 3.2, 5.4, 2.75, 1.2 * BR, 0.9 * BR, FS - 0.65, sk.skinLit, 1);
    fp(4.4, 1.4, 1.8, 1.0, HZ, FS - 0.50, sk.skinDark, 0.86);

    /* Nose: bridge from between the brows out to a tip that breaks the
     * outline by about a tenth of the head radius. It used to overhang by
     * forty percent, which with the heavy brow gave both fighters a
     * Punch-and-Judy profile. */
    fc(4.4, 2.9, R * 0.84 * NS, -0.5, 1.2, 1.35, FS - 0.95, sk.skinLit, 1);
    fp(R * 0.88 * NS, -1.0, 1.35, 1.15, HZ, FS - 1.10, sk.skin, 1);
    // the wing of the nostril, and the shadow under it
    fp(R * 0.62 * NS, -1.9, 0.85, 0.62, HZ, FS - 0.85, sk.skinDark, 0.92);

    // the mouth is carried by the crease, not by colour: one soft form and
    // one dark line, rather than two saturated ellipses
    fp(R * 0.80, -3.7, 1.05, 0.55, HZ, FS - 0.80, sk.lip, 1);
    fc(R * 0.46, -3.72, R * 0.92, -3.84, 0.38, 0.30, FS - 1.05, sk.skinDeep, 0.9);

    /* ---- eye ---- */
    /* Eye. The sclera was rx 2.25 on a head of radius 7.4 -- thirty percent
     * of the head's width, where a real eye in profile is nearer thirteen --
     * and the iris sat further forward than the sclera's own centre, so the
     * pupil hung off the front of the eyeball. Both are the loudest feature
     * on the character, so both were loudly wrong. */
    var open = f.blinkT % f.blink > 0.13 ? 1 : 0.12;
    var ey = 0.5;
    fp(4.7, ey, 1.7, 1.25 * open, HZ, FS - 0.70, sk.sclera, 1);
    fp(5.25, ey - 0.05, 0.86, 1.02 * open, HZ, FS - 0.90, sk.iris, 1);
    // catchlight -- one bright cluster is what makes an eye look alive
    if (open > 0.5) fp(5.45, ey + 0.46, 0.36, 0.32, HZ, FS - 1.30, sk.sclera, 1.4);
    // upper and lower lids: in near profile the visible eye is a wedge, and
    // the lids are what cut that wedge out of the socket. They sit clear of
    // the sclera's own extent -- overlapping it ate most of the eye.
    fc(3.1, ey + 1.75, 6.1, ey + 1.30, 0.72, 0.56, FS - 0.80, sk.skin, 0.92);
    fc(3.5, ey - 1.60, 6.0, ey - 1.25, 0.62, 0.48, FS - 0.80, sk.skin, 0.90);
    fc(3.4, ey + 1.22, 6.1, ey + 0.90, 0.26, 0.21, FS - 1.05, sk.hair, 1);
    /* Eyebrow. Kept close to the skin: pushed proud of the face it stopped
     * reading as hair on a brow and started reading as a black bar floating
     * in front of the forehead. */
    fc(2.3, ey + 3.0, 6.0, ey + 2.35, 0.66 * BR, 0.40 * BR, FS - 0.72, sk.hair, 0.92);

    /* ---- ear ---- */
    fp(-3.4, -0.6, 1.7, 2.5, HZ - 0.2 * fw, FS - 0.60, sk.skin, 0.94);
    fp(-3.4, -0.8, 0.9, 1.5, HZ - 0.2 * fw, FS - 0.75, sk.skinDeep, 0.8);

    /* ---- hair ----
     * Built from masses that stop short of the face, so nothing has to be
     * depth-tricked out of the way of the eye. */
    fp(-2.9, 3.0, R * 0.82, RY * 0.78, HZ, FS - 0.20, sk.hair, 1);
    fp(-4.8, -1.0, R * 0.50, RY * 0.62, HZ, FS - 0.05, sk.hair, 0.94);
    // fringe over the forehead, swept back off the brow
    fp(1.9, RY * 0.72 + 1.2, 4.6, 2.5, HZ + 0.26 * fw, FS - 0.55, sk.hair, 1);
    // a lit strand across the crown, so the mass is not one flat silhouette
    fc(-5.0, RY * 0.72, 2.2, RY * 0.90, 1.15, 0.85, FS - 0.75, sk.hairLit, 1);
    // sideburn, in front of the ear
    fc(-2.2, 2.2, -2.0, -2.4, 1.25, 0.85, FS - 0.68, sk.hair, 0.95);

    /* The tail. Radii come from the hairstyle, so KAI's short topknot and
     * RYO's braid are the same four lines of code and different silhouettes. */
    var st = f.hairStyle, hr = st.r0;
    var prev = at(-R * st.back, st.up);
    sh.ellipsoid(prev[0], prev[1], hr * 0.8, hr * 0.62, ha, FS + 0.1 + hr * 0.7,
      sk.trim, 0.92);
    for (var i = 0; i < f.hair.length; i++) {
      var h = f.hair[i];
      var ra = hr * Math.pow(st.taper, i), rb2 = hr * Math.pow(st.taper, i + 1);
      sh.capsule(prev[0], prev[1], h.x, h.y, ra, rb2, FS + 0.2 + ra, sk.hair, 0.95);
      prev = [h.x, h.y];
    }
  }

  /* Render just a fighter's head into a box, for the HUD portrait.
   *
   * The head geometry already exists and is solved every frame, so a
   * portrait costs a depth clear and about twenty small primitives -- and
   * because it is the live pose, it flinches when the fighter is hit and
   * blinks when they blink. The shader's scale and offset are borrowed for
   * the duration and put back. */
  F.drawPortrait = function (sh, f, cx, cy, S2, w, h) {
    var p = f.pose(), sk = f.skin;
    var oS = sh.S, oOx = sh.ox, oOy = sh.oy, oZ = sh.zBias;
    var oTint = sh.tint, oB0 = sh.bx0, oB1 = sh.bx1, oB2 = sh.by0, oB3 = sh.by1;
    sh.S = S2; sh.zBias = 0; sh.tint = f.flash * 0.7;
    sh.tintR = sk.tint[0]; sh.tintG = sk.tint[1]; sh.tintB = sk.tint[2];
    /* Put the head's own centre at (cx, cy). begin() and every primitive
     * apply `world * S + o`, so solving for o places the portrait without
     * touching a single coordinate in the head builder. */
    sh.ox = cx - p.headC[0] * S2 + (f.facing > 0 ? -w * 0.06 : w * 0.06);
    sh.oy = cy - p.headC[1] * S2 + h * 0.10;
    // clip to the box, in world units around the head
    var hw = (w * 0.5) / S2, hh = (h * 0.5) / S2;
    sh.begin(p.headC[0] - hw, p.headC[1] - hh, p.headC[0] + hw, p.headC[1] + hh);
    sh.clearOcc();
    sh.addOcc(p.headC[0], p.headC[1] + L.headRY * 1.5, L.headRX * 1.6, Z.head + 4, 0.5);
    drawHead(sh, p, f, sk, p.fw);
    sh.S = oS; sh.ox = oOx; sh.oy = oOy; sh.zBias = oZ; sh.tint = oTint;
    sh.bx0 = oB0; sh.bx1 = oB1; sh.by0 = oB2; sh.by1 = oB3;
  };

  F.Z = Z;
})(FX);
