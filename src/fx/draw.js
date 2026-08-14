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

  function mkSkin(o) {
    return {
      skin: F.mat(o.skin[0], o.skin[1], o.skin[2], 0.16, 16, 0.55),
      gi: F.mat(o.gi[0], o.gi[1], o.gi[2], 0.07, 8, 0.68),
      gi2: F.mat(o.gi2[0], o.gi2[1], o.gi2[2], 0.07, 8, 0.6),
      trim: F.mat(o.trim[0], o.trim[1], o.trim[2], 0.20, 22, 0.7),
      hair: F.mat(o.hair[0], o.hair[1], o.hair[2], 0.28, 26, 0.8),
      metal: F.mat(210, 218, 232, 0.75, 60, 1.0),
      name: o.name, tint: o.tint || [255, 210, 120]
    };
  }
  F.mkSkin = mkSkin;

  F.SKINS = {
    kai: mkSkin({
      name: 'KAI',
      skin: [232, 176, 138], gi: [238, 240, 246], gi2: [206, 210, 222],
      trim: [206, 46, 62], hair: [38, 34, 44], tint: [255, 220, 150]
    }),
    ryo: mkSkin({
      name: 'RYO',
      skin: [206, 150, 112], gi: [58, 92, 168], gi2: [40, 66, 124],
      trim: [242, 196, 72], hair: [58, 40, 30], tint: [150, 200, 255]
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
  F.drawShadow = function (surf, f, groundY) {
    var lift = Math.max(0, groundY - f.y);
    var k = Math.max(0.16, 1 - lift / 150);
    surf.shadowEllipse(f.x + 6, groundY + 2, 30 * k, 8.5 * k, 0.62 * k);
  };

  F.drawFighter = function (sh, f) {
    var p = f.pose();
    var sk = f.skin;
    var fw = p.fw;

    sh.tint = f.flash;
    sh.tintR = sk.tint[0]; sh.tintG = sk.tint[1]; sh.tintB = sk.tint[2];

    var far = 0, near = 1;                    // arm/leg indices
    drawLeg(sh, p.legs[far], sk, Z.farLeg, 0.72, fw);
    drawArm(sh, p.arms[far], sk, Z.farArm, 0.74, fw);

    drawTorso(sh, p, f, sk, fw);
    drawHead(sh, p, f, sk, fw);

    drawLeg(sh, p.legs[near], sk, Z.nearLeg, 1.0, fw);
    drawArm(sh, p.arms[near], sk, Z.nearArm, 1.0, fw);
  };

  function drawLeg(sh, lg, sk, z, ao, fw) {
    // bare lower leg, gi trouser over the thigh and knee
    var mid = lerp(lg.knee, lg.ankle, 0.44);
    sh.capsule(lg.hip[0], lg.hip[1], lg.knee[0], lg.knee[1], 8.2, 6.3, z, sk.gi, ao);
    sh.capsule(lg.knee[0], lg.knee[1], mid[0], mid[1], 6.4, 5.4, z, sk.gi, ao);
    // shin starts inside the trouser cuff so there is no ring at the seam
    sh.capsule(mid[0], mid[1], lg.ankle[0], lg.ankle[1], 5.0, 3.2, z + 0.6, sk.skin, ao);
    // foot
    var a = (lg.angle || 0) * Math.PI / 180;
    var fx = Math.cos(a) * fw, fy = Math.sin(a);
    sh.capsule(lg.ankle[0], lg.ankle[1] + 1, lg.ankle[0] + fx * L.foot * 0.8,
      lg.ankle[1] + 1 + fy * L.foot * 0.8, 4.2, 3.0, z - 2, sk.skin, ao);
    // ankle wrap
    sh.sphere(lg.ankle[0], lg.ankle[1], 3.6, z - 1, sk.trim, ao);
  }

  function drawArm(sh, a, sk, z, ao, fw) {
    sh.sphere(a.sh[0], a.sh[1], L.shoulderR, z + 1, sk.gi, ao);
    var sleeve = lerp(a.sh, a.elbow, 0.60);
    sh.capsule(a.sh[0], a.sh[1], sleeve[0], sleeve[1], 6.4, 5.2, z, sk.gi, ao);
    sh.capsule(sleeve[0], sleeve[1], a.elbow[0], a.elbow[1], 4.8, 4.2, z + 0.6, sk.skin, ao);
    sh.capsule(a.elbow[0], a.elbow[1], a.wrist[0], a.wrist[1], 4.2, 3.5, z, sk.skin, ao);
    // wrist wrap and fist
    var wa = ang(a.elbow, a.wrist);
    sh.capsule(a.wrist[0] - Math.cos(wa) * 3, a.wrist[1] - Math.sin(wa) * 3,
      a.wrist[0], a.wrist[1], 4.0, 4.2, z - 1, sk.trim, ao);
    sh.ellipsoid(a.wrist[0] + Math.cos(wa) * 2.6, a.wrist[1] + Math.sin(wa) * 2.6,
      4.8, 4.2, wa, z - 2, sk.skin, ao);
  }

  function drawTorso(sh, p, f, sk, fw) {
    var la = p.leanA * Math.PI / 180;
    // pelvis, abdomen, chest -- three masses give the taper a real body has
    sh.ellipsoid(p.hip[0], p.hip[1], L.hipD, L.hipH2, la + Math.PI / 2, Z.hipD, sk.gi, 0.95);
    sh.ellipsoid(p.waist[0], p.waist[1], L.waistD, L.waistH, la + Math.PI / 2, Z.torso, sk.gi, 0.98);
    sh.ellipsoid(p.chest[0], p.chest[1], L.chestD, L.chestH, la + Math.PI / 2, Z.torso - 1, sk.gi, 1);
    // the yoke across the shoulders -- this is what gives the V
    sh.capsule(p.shoulders[0][0], p.shoulders[0][1], p.shoulders[1][0], p.shoulders[1][1],
      7.6, 7.6, Z.torso - 2, sk.gi, 1);

    // the gi's open front: a darker panel down the centreline
    var top = lerp(p.chest, p.neck, 0.42), bot = lerp(p.hip, p.waist, 0.5);
    sh.capsule(top[0] + fw * 3.0, top[1], bot[0] + fw * 2.0, bot[1], 4.2, 5.2, Z.torso - 3, sk.gi2, 1);

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

  function drawHead(sh, p, f, sk, fw) {
    var ha = p.headA * Math.PI / 180;
    sh.capsule(p.neck[0], p.neck[1], p.headC[0] - Math.cos(ha) * L.headRY * 0.7,
      p.headC[1] - Math.sin(ha) * L.headRY * 0.7, 4.6, 4.2, Z.neck, sk.skin, 0.88);
    // skull and jaw
    sh.ellipsoid(p.headC[0], p.headC[1], L.headRX, L.headRY, ha + Math.PI / 2, Z.head, sk.skin, 1);
    var jaw = [p.headC[0] - Math.cos(ha) * 3.0 + Math.cos(ha + Math.PI / 2 * fw) * 2.0,
      p.headC[1] - Math.sin(ha) * 3.0 + Math.sin(ha + Math.PI / 2 * fw) * 2.0];
    sh.ellipsoid(jaw[0], jaw[1], 5.4, 5.0, ha, Z.head - 1, sk.skin, 0.97);

    // hair: a cap set back off the brow, plus the verlet tail
    var bx = Math.cos(ha + Math.PI / 2 * fw), by = Math.sin(ha + Math.PI / 2 * fw);
    sh.ellipsoid(p.headC[0] + Math.cos(ha) * 2.2 - bx * 1.5,
      p.headC[1] + Math.sin(ha) * 2.2 - by * 1.5,
      L.headRX * 0.98, L.headRY * 0.74, ha + Math.PI / 2, Z.hair, sk.hair, 1);
    var prev = [p.headC[0] - Math.cos(ha + Math.PI / 2 * fw) * L.headRX * 0.7 + Math.cos(ha) * 2,
      p.headC[1] - Math.sin(ha + Math.PI / 2 * fw) * L.headRX * 0.7 + Math.sin(ha) * 2];
    for (var i = 0; i < f.hair.length; i++) {
      var h = f.hair[i];
      sh.capsule(prev[0], prev[1], h.x, h.y, 5.2 - i * 0.9, 4.4 - i * 0.9, Z.hair + 1, sk.hair, 0.95);
      prev = [h.x, h.y];
    }

    /* Face. At this size it is three marks -- brow, nose, mouth -- but
     * without them the head is an egg and the character has no direction. */
    var fx = Math.cos(ha + Math.PI / 2 * fw), fy = Math.sin(ha + Math.PI / 2 * fw);
    var ux2 = Math.cos(ha), uy2 = Math.sin(ha);
    function fp(fwd, up, r1, r2, rot, z, m, a) {
      sh.ellipsoid(p.headC[0] + fx * fwd + ux2 * up, p.headC[1] + fy * fwd + uy2 * up,
        r1, r2, rot, z, m, a === undefined ? 1 : a);
    }
    // nose
    fp(L.headRX * 0.92, -0.4, 2.3, 1.9, ha, Z.head - 2, sk.skin, 1.04);
    // brow shelf
    fp(L.headRX * 0.62, 2.2, 3.0, 1.5, ha + Math.PI / 2, Z.head - 2, sk.hair, 0.9);
    // eye
    var open = f.blinkT % f.blink > 0.13 ? 1 : 0.16;
    fp(L.headRX * 0.60, 0.5, 1.9, 1.7 * open, ha + Math.PI / 2, Z.head - 3,
      F.mat(24, 20, 28, 0.55, 45, 0.3));
    // mouth line
    fp(L.headRX * 0.66, -3.4, 1.7, 0.75, ha + Math.PI / 2, Z.head - 3,
      F.mat(150, 84, 78, 0.1, 10, 0.2));
  }

  F.Z = Z;
})(FX);
