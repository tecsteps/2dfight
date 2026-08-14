/*
 * shade.js -- per-pixel lit primitives.
 *
 * The reason this engine can afford to look modern is that it *generates*
 * its geometry. A sprite is a finished picture: whatever shading it has was
 * painted once and can never respond to anything. A capsule defined by two
 * endpoints and two radii still knows its own shape at render time, so for
 * every pixel we can recover a surface normal and light it properly.
 *
 * Each limb is treated as a capsule swept in Z as well as X/Y -- a rounded
 * tube seen side-on. For a pixel at signed offset u across the tube (-1 at
 * one silhouette edge, +1 at the other) the surface normal is
 *
 *     N = perp * u  +  z * sqrt(1 - u^2)
 *
 * which is exact for a cylinder, and gives a real Lambert term, a real
 * specular highlight and a real rim light. Depth comes out of the same
 * expression, so limbs occlude each other correctly instead of relying on
 * paint order.
 *
 * Everything here is forward-shaded straight into the surface with a depth
 * test, and silhouette pixels are coverage-blended, so edges are smooth
 * without a separate anti-aliasing pass.
 *
 * A note on the shape of the code. The shading maths appears three times:
 * once as Shader.prototype.px, and again inlined into the capsule and
 * ellipsoid loops. That duplication is deliberate. At the resolution this
 * runs at, those two primitives shade well over a hundred thousand pixels a
 * frame, and a nine-argument method call per pixel -- plus reloading a dozen
 * light constants off `this` each time -- was a large fraction of the frame.
 * Inlined, the constants are hoisted into the loop prologue and the inner
 * loop is straight-line arithmetic. px() remains the reference version and
 * the one every other primitive uses; when the lighting model changes, all
 * three change together.
 */
var FX = FX || {};
(function (F) {
  'use strict';

  /* Materials: base colour, how shiny, how much rim. Tuned to read as
   * cloth / skin / metal rather than as tinted plastic. */
  function mat(r, g, b, spec, gloss, rim, sss) {
    /* nr/ng/nb are the albedo pre-divided by 255. Doing that division three
     * times inside the pixel loop was costing more than the specular. */
    return { r: r, g: g, b: b, nr: r / 255, ng: g / 255, nb: b / 255,
      spec: spec === undefined ? 0.12 : spec,
      gloss: gloss || 12, rim: rim === undefined ? 0.5 : rim, sss: sss || 0 };
  }
  F.mat = mat;

  /* The light rig has to agree with the stage it stands in.
   *
   * It used to key from screen-left with a cold blue rim, while the stage
   * puts its sun at 0.70 of screen width -- to the right -- under a warm
   * orange sky. Both fighters were therefore lit from the wrong side and
   * rimmed in blue against an orange sunset, which is most of the reason
   * they read as pasted onto the stage rather than standing in it.
   *
   * Key: frontal, above, from the right, where the sun is. */
  var LX = 0.36, LY = -0.60, LZ = 0.72;
  // Fill: the cool sky bounce, from the opposite side, keeping the shadow
  // side from going flat and dead.
  var FX2 = -0.55, FY2 = -0.20, FZ2 = 0.80;
  // Kicker: behind and to the right, the sun again. The rim only fires
  // where the surface turns away from the viewer *toward this direction*,
  // which is what makes a lit side and a dark side rather than a uniform
  // glowing outline around everything.
  var BX = 0.62, BY = -0.30, BZ = -0.72;
  /* A warm bounce off the floor. Every light in the rig came from above, so
   * the underside of a raised limb fell to flat ambient and a lifted leg
   * looked like it had been cut out of the picture. Real ground bounce is
   * weak, warm, and comes from below-front. */
  var OX = 0.15, OY = 0.80, OZ = 0.58;
  var boR = 122, boG = 74, boB = 52, boK = 0.30;

  /* Highlight rolloff. A hard clamp at 255 turns every lit area brighter
   * than white into one flat plateau -- a white gi under a key light lost
   * its folds entirely and read as cut paper. Above the knee, compress
   * toward an asymptote at 255 instead, so a bright surface keeps its
   * gradient all the way up. KSH is 1/(255-KNEE). */
  var KNEE = 188, KSH = 1 / 67;

  function Shader(surf) {
    this.s = surf;
    /* World-to-device scale. The fighter is authored in its own ~128-unit
     * space; the game lays out a 480x270 world and renders it to a denser
     * surface. One knob here beats scaling every radius by hand. */
    this.S = 1;
    this.bx0 = 0; this.by0 = 0; this.bx1 = 0; this.by1 = 0;
    this.ambR = 42; this.ambG = 46; this.ambB = 60;   // ambient/sky bounce
    this.keyR = 255; this.keyG = 238; this.keyB = 214;
    this.fillR = 90; this.fillG = 120; this.fillB = 168;
    // warm, because the thing behind the fighters is a sunset
    this.rimR = 255; this.rimG = 188; this.rimB = 130;
    this.tint = 0;                                     // 0..1 hit flash
    this.tintR = 255; this.tintG = 255; this.tintB = 255;
    /* Occluders live in a flat array rather than as objects: five property
     * loads per occluder per shaded pixel was measurable once the surface
     * grew. Layout is x, y, r2, z, k. */
    this.occ = new Float64Array(64 * 5); this.nOcc = 0;
    this.ox = 0; this.oy = 0;                          // screen shake
    this.ghost = 0;                                    // >0 draws an afterimage
    /* A whole-object depth offset, in world units. Two fighters share one
     * depth buffer, and in a 2D fighter one of them is simply in front of
     * the other -- biasing each by more than a body's depth makes them
     * occlude cleanly instead of interleaving limb by limb. */
    this.zBias = 0;

    /* The half-vector is a constant of the light rig, but it was being
     * rebuilt -- including a reciprocal square root -- for every shaded
     * pixel. Hoisted, it costs nothing. */
    var hx = LX, hy = LY, hz = LZ + 1;
    var hl = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
    this.HX = hx * hl; this.HY = hy * hl; this.HZ = hz * hl;
  }

  /* Occluders are a handful of body masses in device space. Anything drawn
   * behind one darkens near it, which is what puts shadow in the armpit,
   * under the chin, under the belt and where the near arm crosses the
   * chest. Six discs is enough to read as ambient occlusion. */
  Shader.prototype.clearOcc = function () { this.nOcc = 0; };
  Shader.prototype.addOcc = function (x, y, r, z, k) {
    if (this.nOcc >= 64) return;
    var S = this.S, o = this.occ, i = this.nOcc * 5, rr = r * S;
    o[i] = x * S + this.ox; o[i + 1] = y * S + this.oy; o[i + 2] = rr * rr;
    o[i + 3] = (z + this.zBias) * S; o[i + 4] = k === undefined ? 0.5 : k;
    this.nOcc++;
  };

  /* Reserve a region: the depth buffer only needs clearing where we draw. */
  Shader.prototype.begin = function (x0, y0, x1, y1) {
    var S = this.S;
    x0 = x0 * S + this.ox; y0 = y0 * S + this.oy;
    x1 = x1 * S + this.ox; y1 = y1 * S + this.oy;
    this.bx0 = Math.max(0, x0 | 0); this.by0 = Math.max(0, y0 | 0);
    this.bx1 = Math.min(this.s.w, x1 | 0); this.by1 = Math.min(this.s.h, y1 | 0);
    this.s.clearDepthRect(this.bx0, this.by0, this.bx1, this.by1);
  };

  /* Shade one pixel given its normal and depth, with coverage for the edge.
   * The reference implementation of the lighting model. */
  Shader.prototype.px = function (x, y, nx, ny, nz, z, m, cov, ao) {
    // callers already clip to the shader's box; re-testing here cost a
    // branch on every covered pixel
    var s = this.s, i = y * s.w + x;
    if (z >= s.depth[i]) return;
    if (this.ghost > 0) { cov *= this.ghost; }
    else if (cov >= 0.995) s.depth[i] = z;

    var d = nx * LX + ny * LY + nz * LZ;
    if (d < 0) d = 0;
    // wrap term: skin and cloth do not fall to black at the terminator
    d = d * 0.82 + 0.18;

    var f = nx * FX2 + ny * FY2 + nz * FZ2;
    if (f < 0) f = 0;
    f *= 0.34;

    // Blinn specular against the key light
    var sp = 0;
    if (m.spec > 0.001) {
      sp = nx * this.HX + ny * this.HY + nz * this.HZ;
      if (sp <= 0) sp = 0;
      else {
        // integer gloss by repeated squaring beats Math.pow per pixel
        var e = m.gloss, acc = 1, base = sp;
        while (e > 0) { if (e & 1) acc *= base; base *= base; e >>= 1; }
        sp = acc * m.spec;
      }
    }

    // rim, gated by direction
    var rb = nx * BX + ny * BY + nz * BZ;
    var rim = 0;
    if (rb > 0) {
      rim = 1 - nz;
      rim = rim * rim * rim * rb * m.rim * 2.0;
    }

    // warm ground bounce
    var bo = nx * OX + ny * OY + nz * OZ;
    bo = bo > 0 ? bo * boK : 0;

    var occ = ao === undefined ? 1 : ao;
    // per-pixel ambient occlusion from the body's own masses
    var oa = this.occ;
    for (var oi = 0, on = this.nOcc * 5; oi < on; oi += 5) {
      var oz = oa[oi + 3];
      if (z <= oz) continue;                        // only occluders in front
      var odx = x - oa[oi], ody = y - oa[oi + 1];
      var od2 = odx * odx + ody * ody, or2 = oa[oi + 2];
      if (od2 >= or2) continue;
      var dz = z - oz; if (dz > 16) dz = 16;
      occ -= occ * oa[oi + 4] * (1 - od2 / or2) * dz * 0.0625;
    }

    // subsurface warmth on the terminator; without it the cold fill light
    // makes skin read dead
    var sss = m.sss ? m.sss * (1 - d) * (nz * 0.6 + 0.4) : 0;

    // radiance, with the albedo factored out of the ambient/key/fill sum --
    // three divisions per pixel used to live here
    var r = (m.nr * (this.ambR + this.keyR * d + this.fillR * f + boR * bo)
      + this.keyR * sp + this.rimR * rim + 62 * sss) * occ;
    var g = (m.ng * (this.ambG + this.keyG * d + this.fillG * f + boG * bo)
      + this.keyG * sp + this.rimG * rim + 26 * sss) * occ;
    var b = (m.nb * (this.ambB + this.keyB * d + this.fillB * f + boB * bo)
      + this.keyB * sp + this.rimB * rim + 14 * sss) * occ;

    if (this.tint > 0) {
      /* Multiply, don't add. Adding a large constant to every channel drove
       * the whole body past the knee at once, so a struck fighter -- gi,
       * skin, hair, face and HUD portrait alike -- went to one chalky white
       * with every gradient and every facial feature erased. Scaling the lit
       * colour brightens it by the same proportion everywhere and leaves the
       * form intact. */
      var t = this.tint * 0.55;
      r *= 1 + t * (this.tintR / 255) * 1.9;
      g *= 1 + t * (this.tintG / 255) * 1.9;
      b *= 1 + t * (this.tintB / 255) * 1.9;
    }
    if (r > KNEE) r = KNEE + (r - KNEE) / (1 + (r - KNEE) * KSH);
    if (g > KNEE) g = KNEE + (g - KNEE) / (1 + (g - KNEE) * KSH);
    if (b > KNEE) b = KNEE + (b - KNEE) / (1 + (b - KNEE) * KSH);
    if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;

    if (cov >= 0.995) {
      s.px[i] = 0xff000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    } else {
      var v = s.px[i], ia = 1 - cov;
      s.px[i] = 0xff000000 |
        (((((v >>> 16) & 255) * ia + b * cov) | 0) << 16) |
        (((((v >>> 8) & 255) * ia + g * cov) | 0) << 8) |
        ((((v & 255) * ia + r * cov) | 0));
    }
  };

  /* A limb. (ax,ay)-(bx,by) with radii r0..r1, lying at depth zb; the tube
   * bulges toward the viewer by its own radius, which is what makes crossing
   * limbs sort correctly. */
  Shader.prototype.capsule = function (ax, ay, bx, by, r0, r1, zb, m, ao) {
    var S = this.S;
    ax = ax * S + this.ox; ay = ay * S + this.oy;
    bx = bx * S + this.ox; by = by * S + this.oy;
    r0 *= S; r1 *= S; zb = (zb + this.zBias) * S;
    var dx = bx - ax, dy = by - ay;
    var seg = Math.sqrt(dx * dx + dy * dy);
    if (seg < 0.0001) { this.sphere(ax / S, ay / S, Math.max(r0, r1) / S, zb / S, m, ao); return; }
    var ux = dx / seg, uy = dy / seg;
    var perpX = -uy, perpY = ux;
    var rmax = Math.max(r0, r1);
    /* Interior pixels are fully covered, so their distance to the axis is
     * never needed -- only the edge band has to take the square root. On a
     * fat limb that is nine pixels in ten. */
    var rmin = Math.min(r0, r1), rin = rmin - 0.5, rin2 = rin > 0 ? rin * rin : -1;

    var x0 = Math.floor(Math.min(ax, bx) - rmax - 1), x1 = Math.ceil(Math.max(ax, bx) + rmax + 1);
    var y0 = Math.floor(Math.min(ay, by) - rmax - 1), y1 = Math.ceil(Math.max(ay, by) + rmax + 1);
    if (x0 < this.bx0) x0 = this.bx0; if (y0 < this.by0) y0 = this.by0;
    if (x1 > this.bx1) x1 = this.bx1; if (y1 > this.by1) y1 = this.by1;
    if (x1 <= x0 || y1 <= y0) return;

    /* ---- shading prologue: everything constant over the primitive ---- */
    var s = this.s, sw = s.w, spx = s.px, sdep = s.depth;
    var ambR = this.ambR, ambG = this.ambG, ambB = this.ambB;
    var keyR = this.keyR, keyG = this.keyG, keyB = this.keyB;
    var fillR = this.fillR, fillG = this.fillG, fillB = this.fillB;
    var rimR = this.rimR, rimG = this.rimG, rimB = this.rimB;
    var HX = this.HX, HY = this.HY, HZ = this.HZ;
    var mnr = m.nr, mng = m.ng, mnb = m.nb;
    var mspec = m.spec, mgloss = m.gloss, mrim = m.rim, msss = m.sss;
    var occA = this.occ, nOcc5 = this.nOcc * 5;
    var ghost = this.ghost;
    // hit flash, as a per-channel multiplier so the shading survives it
    var tt = this.tint > 0 ? this.tint * 0.55 : 0;
    var tR = 1 + tt * (this.tintR / 255) * 1.9;
    var tG = 1 + tt * (this.tintG / 255) * 1.9;
    var tB = 1 + tt * (this.tintB / 255) * 1.9;
    if (ao === undefined) ao = 1;

    for (var y = y0; y < y1; y++) {
      var vy0 = y + 0.5 - ay;
      for (var x = x0; x < x1; x++) {
        var vx = x + 0.5 - ax;
        var t = (vx * ux + vy0 * uy) / seg;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var r = r0 + (r1 - r0) * t;
        var ex = vx - ux * seg * t, ey = vy0 - uy * seg * t;
        var d2 = ex * ex + ey * ey;
        var rlim = r + 0.75;
        if (d2 > rlim * rlim) continue;               // reject before the sqrt
        var cov = 1;
        if (d2 > rin2) {
          cov = r + 0.5 - Math.sqrt(d2);
          if (cov > 1) cov = 1; else if (cov <= 0) continue;
        }
        var u = (ex * perpX + ey * perpY) / r;
        if (u > 1) u = 1; else if (u < -1) u = -1;
        var nz = Math.sqrt(1 - u * u);
        var nx = perpX * u, ny = perpY * u;
        var z = zb - nz * r;

        /* ---- inlined from px(); see the note at the top of the file ---- */
        var i = y * sw + x;
        if (z >= sdep[i]) continue;
        var cv = cov;
        if (ghost > 0) cv *= ghost;
        else if (cv >= 0.995) sdep[i] = z;
        var dd = nx * LX + ny * LY + nz * LZ;
        if (dd < 0) dd = 0;
        dd = dd * 0.82 + 0.18;
        var ff = nx * FX2 + ny * FY2 + nz * FZ2;
        if (ff < 0) ff = 0;
        ff *= 0.34;
        var sp = 0;
        if (mspec > 0.001) {
          sp = nx * HX + ny * HY + nz * HZ;
          if (sp <= 0) sp = 0;
          else {
            var e = mgloss, acc = 1, base = sp;
            while (e > 0) { if (e & 1) acc *= base; base *= base; e >>= 1; }
            sp = acc * mspec;
          }
        }
        var rim = 0, rb = nx * BX + ny * BY + nz * BZ;
        if (rb > 0) { rim = 1 - nz; rim = rim * rim * rim * rb * mrim * 2.0; }
        var bo = nx * OX + ny * OY + nz * OZ;
        bo = bo > 0 ? bo * boK : 0;
        var occ = ao;
        for (var oi = 0; oi < nOcc5; oi += 5) {
          var oz = occA[oi + 3];
          if (z <= oz) continue;
          var odx = x - occA[oi], ody = y - occA[oi + 1];
          var od2 = odx * odx + ody * ody, or2 = occA[oi + 2];
          if (od2 >= or2) continue;
          var dz = z - oz; if (dz > 16) dz = 16;
          occ -= occ * occA[oi + 4] * (1 - od2 / or2) * dz * 0.0625;
        }
        var ss = msss ? msss * (1 - dd) * (nz * 0.6 + 0.4) : 0;
        var cr = (mnr * (ambR + keyR * dd + fillR * ff + boR * bo) + keyR * sp + rimR * rim + 62 * ss) * occ * tR;
        var cg = (mng * (ambG + keyG * dd + fillG * ff + boG * bo) + keyG * sp + rimG * rim + 26 * ss) * occ * tG;
        var cb = (mnb * (ambB + keyB * dd + fillB * ff + boB * bo) + keyB * sp + rimB * rim + 14 * ss) * occ * tB;
        if (cr > KNEE) cr = KNEE + (cr - KNEE) / (1 + (cr - KNEE) * KSH);
        if (cg > KNEE) cg = KNEE + (cg - KNEE) / (1 + (cg - KNEE) * KSH);
        if (cb > KNEE) cb = KNEE + (cb - KNEE) / (1 + (cb - KNEE) * KSH);
        if (cv >= 0.995) {
          spx[i] = 0xff000000 | ((cb | 0) << 16) | ((cg | 0) << 8) | (cr | 0);
        } else {
          var v = spx[i], ia = 1 - cv;
          spx[i] = 0xff000000 |
            (((((v >>> 16) & 255) * ia + cb * cv) | 0) << 16) |
            (((((v >>> 8) & 255) * ia + cg * cv) | 0) << 8) |
            ((((v & 255) * ia + cr * cv) | 0));
        }
      }
    }
  };

  Shader.prototype.sphere = function (cx, cy, r, zb, m, ao) {
    this.ellipsoid(cx, cy, r, r, 0, zb, m, ao);
  };

  /* An ellipsoid, optionally rotated -- heads, shoulders, torso masses. */
  Shader.prototype.ellipsoid = function (cx, cy, rx, ry, rot, zb, m, ao) {
    var S = this.S;
    cx = cx * S + this.ox; cy = cy * S + this.oy;
    rx *= S; ry *= S; zb = (zb + this.zBias) * S;
    var ca = Math.cos(rot), sa = Math.sin(rot);
    var rr = Math.max(rx, ry);
    var x0 = Math.floor(cx - rr - 1), x1 = Math.ceil(cx + rr + 1);
    var y0 = Math.floor(cy - rr - 1), y1 = Math.ceil(cy + rr + 1);
    if (x0 < this.bx0) x0 = this.bx0; if (y0 < this.by0) y0 = this.by0;
    if (x1 > this.bx1) x1 = this.bx1; if (y1 > this.by1) y1 = this.by1;
    if (x1 <= x0 || y1 <= y0) return;
    var rz = (rx + ry) * 0.5;
    var irx = 1 / rx, iry = 1 / ry;
    /* Interior test in q-space: inside this the pixel is fully covered and
     * neither the square root nor the edge gradient is needed. */
    var rmn = Math.min(rx, ry);
    var qin = rmn > 1.2 ? (1 - 1 / rmn) * (1 - 1 / rmn) : -1;

    /* ---- shading prologue ---- */
    var s = this.s, sw = s.w, spx = s.px, sdep = s.depth;
    var ambR = this.ambR, ambG = this.ambG, ambB = this.ambB;
    var keyR = this.keyR, keyG = this.keyG, keyB = this.keyB;
    var fillR = this.fillR, fillG = this.fillG, fillB = this.fillB;
    var rimR = this.rimR, rimG = this.rimG, rimB = this.rimB;
    var HX = this.HX, HY = this.HY, HZ = this.HZ;
    var mnr = m.nr, mng = m.ng, mnb = m.nb;
    var mspec = m.spec, mgloss = m.gloss, mrim = m.rim, msss = m.sss;
    var occA = this.occ, nOcc5 = this.nOcc * 5;
    var ghost = this.ghost;
    // hit flash, as a per-channel multiplier so the shading survives it
    var tt = this.tint > 0 ? this.tint * 0.55 : 0;
    var tR = 1 + tt * (this.tintR / 255) * 1.9;
    var tG = 1 + tt * (this.tintG / 255) * 1.9;
    var tB = 1 + tt * (this.tintB / 255) * 1.9;
    if (ao === undefined) ao = 1;

    for (var y = y0; y < y1; y++) {
      var dy = y + 0.5 - cy;
      for (var x = x0; x < x1; x++) {
        var dx = x + 0.5 - cx;
        // into the ellipse's own frame
        var lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        var a = lx * irx, b = ly * iry;
        var q = a * a + b * b;
        if (q > 1.3) continue;
        var cov = 1;
        if (q > qin) {
          /* Coverage from the true distance to the ellipse, which is the
           * implicit value divided by its own gradient. Scaling by min(rx,ry)
           * instead -- the old shortcut -- made a wide-but-short ellipse fade
           * out along its long sides and stay hard on its short ones. */
          var dq = Math.sqrt(q);
          var ga = a * irx, gb = b * iry;
          var gl = Math.sqrt(ga * ga + gb * gb);
          cov = gl > 1e-6 ? 0.5 + (1 - dq) * dq / gl : 1;
          if (cov > 1) cov = 1; else if (cov <= 0) continue;
        }
        /* For q <= 1 the frame normal (a, b, sqrt(1-q)) is already unit
         * length by construction; only the antialiased fringe outside the
         * ellipse needs rescaling. */
        var nzs = 1 - q, nx, ny, nz;
        if (nzs > 0) {
          nz = Math.sqrt(nzs);
          nx = a * ca - b * sa; ny = a * sa + b * ca;
        } else {
          nz = 0;
          var il = 1 / Math.sqrt(q);
          var a2 = a * il, b2 = b * il;
          nx = a2 * ca - b2 * sa; ny = a2 * sa + b2 * ca;
        }
        var z = zb - nz * rz;

        /* ---- inlined from px(); see the note at the top of the file ---- */
        var i = y * sw + x;
        if (z >= sdep[i]) continue;
        var cv = cov;
        if (ghost > 0) cv *= ghost;
        else if (cv >= 0.995) sdep[i] = z;
        var dd = nx * LX + ny * LY + nz * LZ;
        if (dd < 0) dd = 0;
        dd = dd * 0.82 + 0.18;
        var ff = nx * FX2 + ny * FY2 + nz * FZ2;
        if (ff < 0) ff = 0;
        ff *= 0.34;
        var sp = 0;
        if (mspec > 0.001) {
          sp = nx * HX + ny * HY + nz * HZ;
          if (sp <= 0) sp = 0;
          else {
            var e = mgloss, acc = 1, base = sp;
            while (e > 0) { if (e & 1) acc *= base; base *= base; e >>= 1; }
            sp = acc * mspec;
          }
        }
        var rim = 0, rb = nx * BX + ny * BY + nz * BZ;
        if (rb > 0) { rim = 1 - nz; rim = rim * rim * rim * rb * mrim * 2.0; }
        var bo = nx * OX + ny * OY + nz * OZ;
        bo = bo > 0 ? bo * boK : 0;
        var occ = ao;
        for (var oi = 0; oi < nOcc5; oi += 5) {
          var oz = occA[oi + 3];
          if (z <= oz) continue;
          var odx = x - occA[oi], ody = y - occA[oi + 1];
          var od2 = odx * odx + ody * ody, or2 = occA[oi + 2];
          if (od2 >= or2) continue;
          var dz = z - oz; if (dz > 16) dz = 16;
          occ -= occ * occA[oi + 4] * (1 - od2 / or2) * dz * 0.0625;
        }
        var ss = msss ? msss * (1 - dd) * (nz * 0.6 + 0.4) : 0;
        var cr = (mnr * (ambR + keyR * dd + fillR * ff + boR * bo) + keyR * sp + rimR * rim + 62 * ss) * occ * tR;
        var cg = (mng * (ambG + keyG * dd + fillG * ff + boG * bo) + keyG * sp + rimG * rim + 26 * ss) * occ * tG;
        var cb = (mnb * (ambB + keyB * dd + fillB * ff + boB * bo) + keyB * sp + rimB * rim + 14 * ss) * occ * tB;
        if (cr > KNEE) cr = KNEE + (cr - KNEE) / (1 + (cr - KNEE) * KSH);
        if (cg > KNEE) cg = KNEE + (cg - KNEE) / (1 + (cg - KNEE) * KSH);
        if (cb > KNEE) cb = KNEE + (cb - KNEE) / (1 + (cb - KNEE) * KSH);
        if (cv >= 0.995) {
          spx[i] = 0xff000000 | ((cb | 0) << 16) | ((cg | 0) << 8) | (cr | 0);
        } else {
          var v = spx[i], ia = 1 - cv;
          spx[i] = 0xff000000 |
            (((((v >>> 16) & 255) * ia + cb * cv) | 0) << 16) |
            (((((v >>> 8) & 255) * ia + cg * cv) | 0) << 8) |
            ((((v & 255) * ia + cr * cv) | 0));
        }
      }
    }
  };

  /* A flat convex polygon, shaded as a slab facing the viewer with a soft
   * bevel toward its edges. Used for cloth panels and blades, where a tube
   * would read wrong. Coordinates are already in device space. */
  Shader.prototype.polySlab = function (pts, zb, m, bevel, ao) {
    /* Takes world coordinates like every other primitive. It used to take
     * device coordinates, which made it the one shape a caller had to
     * transform by hand. */
    var S = this.S, n = pts.length, i;
    var q = this._poly || (this._poly = []);
    q.length = 0;
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (i = 0; i < n; i++) {
      var qx0 = pts[i][0] * S + this.ox, qy0 = pts[i][1] * S + this.oy;
      q.push([qx0, qy0]);
      if (qx0 < minX) minX = qx0;
      if (qx0 > maxX) maxX = qx0;
      if (qy0 < minY) minY = qy0;
      if (qy0 > maxY) maxY = qy0;
    }
    pts = q; zb = (zb + this.zBias) * S; bevel = (bevel || 3) * S;
    var x0 = Math.max(this.bx0, Math.floor(minX)), x1 = Math.min(this.bx1, Math.ceil(maxX) + 1);
    var y0 = Math.max(this.by0, Math.floor(minY)), y1 = Math.min(this.by1, Math.ceil(maxY) + 1);
    if (x1 <= x0 || y1 <= y0) return;
    var bv = bevel;

    /* Edge planes, precomputed. These are constants of the polygon, and
     * rebuilding them per pixel meant a square root and two divides per edge
     * per pixel -- for a four-sided cloth panel, sixteen divides and four
     * square roots to shade one pixel. Now each edge is one dot product. */
    var ed = this._edge || (this._edge = []);
    var ne = 0;
    for (i = 0; i < n; i++) {
      var ax = pts[i][0], ay = pts[i][1];
      var j = (i + 1) % n;
      var ex = pts[j][0] - ax, ey = pts[j][1] - ay;
      var el = Math.sqrt(ex * ex + ey * ey);
      if (el < 0.0001) continue;
      var nxe = ey / el, nye = -ex / el;            // outward if CW
      var e0 = ed[ne] || (ed[ne] = {});
      e0.nx = nxe; e0.ny = nye; e0.d = ax * nxe + ay * nye;   // plane offset
      ne++;
    }
    if (ne < 3) return;

    for (var y = y0; y < y1; y++) {
      var py = y + 0.5;
      for (var x = x0; x < x1; x++) {
        // signed distance to the polygon boundary (convex assumption)
        var px = x + 0.5;
        var inside = true, best = 1e9, bnx = 0, bny = 0;
        for (i = 0; i < ne; i++) {
          var e1 = ed[i];
          var d = px * e1.nx + py * e1.ny - e1.d;
          if (d > 0.5) { inside = false; break; }
          if (-d < best) { best = -d; bnx = e1.nx; bny = e1.ny; }
        }
        if (!inside) continue;
        var cov = best + 0.5; if (cov > 1) cov = 1; else if (cov <= 0) continue;
        var e = Math.min(1, best / bv);
        var nz = Math.sqrt(Math.max(0.02, e));
        var s = Math.sqrt(Math.max(0, 1 - nz * nz));
        this.px(x, y, bnx * s, bny * s, nz, zb - nz * bv, m, cov, ao);
      }
    }
  };

  F.Shader = Shader;
})(FX);
