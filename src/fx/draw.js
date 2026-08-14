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
    var lip = [Math.min(255, sk[0] * 0.92), sk[1] * 0.70, sk[2] * 0.68];
    return {
      skin: F.mat(sk[0], sk[1], sk[2], 0.22, 30, 0.5, 1.0),
      // sockets, the underside of the jaw, the shadow beside the nose
      skinDark: F.mat(dark[0], dark[1], dark[2], 0.16, 24, 0.4, 1.0),
      skinDeep: F.mat(deep[0], deep[1], deep[2], 0.10, 18, 0.3, 0.9),
      // the planes that catch light: nose bridge, cheekbone, brow
      skinLit: F.mat(lit[0], lit[1], lit[2], 0.30, 34, 0.6, 1.0),
      lip: F.mat(lip[0], lip[1], lip[2], 0.34, 26, 0.4, 0.8),
      sclera: F.mat(232, 228, 232, 0.30, 26, 0.25),
      iris: F.mat(46, 38, 52, 0.80, 64, 0.3),
      gi: F.mat(o.gi[0], o.gi[1], o.gi[2], 0.02, 4, 0.34),
      gi2: F.mat(o.gi2[0], o.gi2[1], o.gi2[2], 0.02, 4, 0.30),
      trim: F.mat(o.trim[0], o.trim[1], o.trim[2], 0.16, 20, 0.5),
      /* Hair used to be spec 0.34 / gloss 34, which at this resolution put a
       * single hard highlight on the crown and made it read as moulded
       * vinyl. Real hair scatters: broad and weak. */
      hair: F.mat(o.hair[0], o.hair[1], o.hair[2], 0.10, 12, 0.62),
      hairLit: F.mat(Math.min(255, o.hair[0] * 1.55 + 14), Math.min(255, o.hair[1] * 1.5 + 12),
        Math.min(255, o.hair[2] * 1.45 + 16), 0.14, 14, 0.7),
      metal: F.mat(210, 218, 232, 0.75, 60, 1.0),
      name: o.name, tint: o.tint || [255, 210, 120],
      hairStyle: o.hairStyle,
      // per-character face proportions, so the two heads are not one head
      brow: o.brow || 1, jaw: o.jaw || 1, nose: o.nose || 1
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
      hairStyle: { n: 3, seg: 3.0, r0: 3.2, taper: 0.72, back: 0.62, up: 3.2, grav: 520 },
      brow: 1.15, jaw: 1.10, nose: 1.0
    }),
    /* RYO: blue gi, gold belt, a long braid that swings. Narrower jaw and a
     * lighter brow so the two silhouettes are not the same face. */
    ryo: mkSkin({
      name: 'RYO',
      skin: [206, 150, 112], gi: [58, 92, 168], gi2: [40, 66, 124],
      trim: [242, 196, 72], hair: [58, 40, 30], tint: [150, 200, 255],
      hairStyle: { n: 4, seg: 4.2, r0: 2.9, taper: 0.5, back: 0.86, up: 0.4, grav: 700 },
      brow: 0.86, jaw: 0.92, nose: 1.12
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
    surf.shadowEllipse((f.x + 4) * S + ox, (groundY + 2) * S + oy, 34 * k * S, 9 * k * S, 0.44 * k);
    surf.shadowEllipse((f.x + 4) * S + ox, (groundY + 2) * S + oy, 15 * k * S, 4.2 * k * S, 0.58 * k);
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

    var far = 0, near = 1;                    // arm/leg indices
    drawLeg(sh, p.legs[far], sk, Z.farLeg, 0.72, fw);
    drawArm(sh, p.arms[far], sk, Z.farArm, 0.74, fw);

    drawTorso(sh, p, f, sk, fw);
    drawHead(sh, p, f, sk, fw);

    drawLeg(sh, p.legs[near], sk, Z.nearLeg, 1.0, fw);
    drawArm(sh, p.arms[near], sk, Z.nearArm, 1.0, fw);
    sh.ghost = 0;
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
    // deltoid: a cap angled down the upper arm, not a ball stuck on the
    // chest. The ball read unmistakably as a breast on both fighters.
    var delt = lerp(a.sh, a.elbow, 0.30);
    sh.capsule(a.sh[0], a.sh[1], delt[0], delt[1], 7.0, 5.2, z + 1, sk.gi, ao);
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
    sh.ellipsoid(p.hip[0], p.hip[1], L.hipD, L.hipH2, la + Math.PI / 2, Z.torso, sk.gi, 0.95);
    sh.ellipsoid(p.waist[0], p.waist[1], L.waistD, L.waistH, la + Math.PI / 2, Z.torso, sk.gi, 0.98);
    sh.ellipsoid(p.chest[0], p.chest[1], L.chestD, L.chestH, la + Math.PI / 2, Z.torso, sk.gi, 1);
    // trapezius: neck out to each shoulder, so the head stops sitting on a
    // flat shelf
    for (var t2 = 0; t2 < 2; t2++) {
      sh.capsule(p.neck[0], p.neck[1], p.shoulders[t2][0], p.shoulders[t2][1],
        5.2, 7.4, Z.torso - 2, sk.gi, 1);
    }
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
    // brow ridge, lit on top, and the shadow it casts into the socket
    fc(0.4, 3.4, 5.4, 2.9, 2.0 * BR, 1.5 * BR, FS - 0.65, sk.skinLit, 1);
    fp(4.2, 1.5, 3.0, 1.7, HZ, FS - 0.50, sk.skinDark, 0.80);

    // nose: bridge from between the brows out to a tip past the outline
    fc(4.6, 3.0, R * 0.98 * NS, -0.5, 1.5, 1.9, FS - 0.95, sk.skinLit, 1);
    fp(R * 1.02 * NS, -1.1, 2.0, 1.8, HZ, FS - 1.10, sk.skin, 1);
    // the wing of the nostril, and the shadow under it
    fp(R * 0.70 * NS, -2.1, 1.05, 0.8, HZ, FS - 0.85, sk.skinDark, 0.92);

    // lips, and the crease between them
    fp(R * 0.84, -3.4, 1.55, 0.85, HZ, FS - 0.80, sk.lip, 1);
    fp(R * 0.78, -4.3, 1.6, 0.95, HZ, FS - 0.85, sk.lip, 1);
    fc(R * 0.48, -3.82, R * 0.94, -3.94, 0.42, 0.34, FS - 1.05, sk.skinDeep, 0.9);

    /* ---- eye ---- */
    var open = f.blinkT % f.blink > 0.13 ? 1 : 0.12;
    var ey = 0.4;
    fp(4.8, ey, 2.25, 1.65 * open, HZ, FS - 0.70, sk.sclera, 1);
    fp(5.6, ey - 0.1, 1.15, 1.35 * open, HZ, FS - 0.90, sk.iris, 1);
    // catchlight -- one bright cluster is what makes an eye look alive
    if (open > 0.5) fp(5.95, ey + 0.62, 0.5, 0.44, HZ, FS - 1.30, sk.sclera, 1.4);
    // upper lid and lash line, which also give the eye an expression
    fc(2.8, ey + 1.9, 6.5, ey + 1.35, 1.0, 0.78, FS - 0.80, sk.skin, 0.92);
    fc(3.2, ey + 1.35, 6.5, ey + 0.9, 0.38, 0.30, FS - 1.05, sk.hair, 1);
    // eyebrow
    fc(2.0, ey + 3.3, 6.1, ey + 2.6, 0.78 * BR, 0.46 * BR, FS - 1.00, sk.hair, 1);

    /* ---- ear ---- */
    fp(-3.4, -0.6, 1.7, 2.5, HZ - 0.2 * fw, FS - 0.60, sk.skin, 0.94);
    fp(-3.4, -0.8, 0.9, 1.5, HZ - 0.2 * fw, FS - 0.75, sk.skinDeep, 0.8);

    /* ---- hair ----
     * Built from masses that stop short of the face, so nothing has to be
     * depth-tricked out of the way of the eye. */
    fp(-2.9, 3.0, R * 0.82, RY * 0.78, HZ, FS - 0.20, sk.hair, 1);
    fp(-4.8, -1.0, R * 0.50, RY * 0.62, HZ, FS - 0.05, sk.hair, 0.94);
    // fringe over the forehead, swept back off the brow
    fp(1.9, RY * 0.72, 4.6, 2.5, HZ + 0.26 * fw, FS - 0.55, sk.hair, 1);
    // a lit strand across the crown, so the mass is not one flat silhouette
    fc(-5.0, RY * 0.72, 2.2, RY * 0.90, 1.15, 0.85, FS - 0.75, sk.hairLit, 1);
    // sideburn, in front of the ear
    fc(-2.2, 2.2, -2.0, -2.4, 1.25, 0.85, FS - 0.68, sk.hair, 0.95);

    /* The tail. Radii come from the hairstyle, so KAI's short topknot and
     * RYO's braid are the same four lines of code and different silhouettes. */
    var st = f.hairStyle, hr = st.r0;
    var prev = at(-R * st.back, st.up);
    for (var i = 0; i < f.hair.length; i++) {
      var h = f.hair[i];
      var ra = hr * Math.pow(st.taper, i), rb2 = hr * Math.pow(st.taper, i + 1);
      sh.capsule(prev[0], prev[1], h.x, h.y, ra, rb2, FS + 0.2 + ra, sk.hair, 0.95);
      prev = [h.x, h.y];
    }
  }

  F.Z = Z;
})(FX);
