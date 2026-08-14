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
 */
var FX = FX || {};
(function (F) {
  'use strict';

  /* Materials: base colour, how shiny, how much rim. Tuned to read as
   * cloth / skin / metal rather than as tinted plastic. */
  function mat(r, g, b, spec, gloss, rim) {
    return { r: r, g: g, b: b, spec: spec === undefined ? 0.12 : spec,
      gloss: gloss || 12, rim: rim === undefined ? 0.5 : rim };
  }
  F.mat = mat;

  // light: front, above, from the character's left
  var LX = -0.36, LY = -0.66, LZ = 0.66;
  // a second, cooler fill from the opposite side keeps shadows from going flat
  var FX2 = 0.55, FY2 = -0.15, FZ2 = 0.82;

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
    this.rimR = 190; this.rimG = 214; this.rimB = 255;
    this.tint = 0;                                     // 0..1 hit flash
    this.tintR = 255; this.tintG = 255; this.tintB = 255;
  }

  /* Reserve a region: the depth buffer only needs clearing where we draw. */
  Shader.prototype.begin = function (x0, y0, x1, y1) {
    var S = this.S;
    x0 *= S; y0 *= S; x1 *= S; y1 *= S;
    this.bx0 = Math.max(0, x0 | 0); this.by0 = Math.max(0, y0 | 0);
    this.bx1 = Math.min(this.s.w, x1 | 0); this.by1 = Math.min(this.s.h, y1 | 0);
    this.s.clearDepthRect(this.bx0, this.by0, this.bx1, this.by1);
  };

  /* Shade one pixel given its normal and depth, with coverage for the edge. */
  Shader.prototype.px = function (x, y, nx, ny, nz, z, m, cov, ao) {
    if (x < this.bx0 || y < this.by0 || x >= this.bx1 || y >= this.by1) return;
    var s = this.s, i = y * s.w + x;
    if (z >= s.depth[i]) return;
    if (cov >= 0.995) s.depth[i] = z;

    var d = nx * LX + ny * LY + nz * LZ;
    if (d < 0) d = 0;
    // wrap term: skin and cloth do not fall to black at the terminator
    d = d * 0.82 + 0.18;

    var f = nx * FX2 + ny * FY2 + nz * FZ2;
    if (f < 0) f = 0;
    f *= 0.34;

    // Blinn specular against the key light
    var hx = LX, hy = LY, hz = LZ + 1;
    var hl = 1 / Math.sqrt(hx * hx + hy * hy + hz * hz);
    var sp = nx * hx * hl + ny * hy * hl + nz * hz * hl;
    if (sp < 0) sp = 0;
    sp = Math.pow(sp, m.gloss) * m.spec;

    // rim: strongest where the surface turns away from the viewer
    var rim = 1 - nz;
    rim = rim * rim * rim * m.rim;

    var occ = ao === undefined ? 1 : ao;
    var r = (this.ambR + this.keyR * d) * m.r / 255 * occ + this.fillR * f * m.r / 255
      + this.keyR * sp + this.rimR * rim;
    var g = (this.ambG + this.keyG * d) * m.g / 255 * occ + this.fillG * f * m.g / 255
      + this.keyG * sp + this.rimG * rim;
    var b = (this.ambB + this.keyB * d) * m.b / 255 * occ + this.fillB * f * m.b / 255
      + this.keyB * sp + this.rimB * rim;

    if (this.tint > 0) {
      var t = this.tint;
      r += (this.tintR - r) * t; g += (this.tintG - g) * t; b += (this.tintB - b) * t;
    }
    if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
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
    if (S !== 1) { ax *= S; ay *= S; bx *= S; by *= S; r0 *= S; r1 *= S; zb *= S; }
    var dx = bx - ax, dy = by - ay;
    var seg = Math.sqrt(dx * dx + dy * dy);
    if (seg < 0.0001) { this.sphere(ax, ay, Math.max(r0, r1), zb, m, ao); return; }
    var ux = dx / seg, uy = dy / seg;
    var px = -uy, py = ux;
    var rmax = Math.max(r0, r1);

    var x0 = Math.floor(Math.min(ax, bx) - rmax - 1), x1 = Math.ceil(Math.max(ax, bx) + rmax + 1);
    var y0 = Math.floor(Math.min(ay, by) - rmax - 1), y1 = Math.ceil(Math.max(ay, by) + rmax + 1);
    if (x0 < this.bx0) x0 = this.bx0; if (y0 < this.by0) y0 = this.by0;
    if (x1 > this.bx1) x1 = this.bx1; if (y1 > this.by1) y1 = this.by1;

    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var vx = x + 0.5 - ax, vy = y + 0.5 - ay;
        var t = (vx * ux + vy * uy) / seg;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var qx = ax + ux * seg * t, qy = ay + uy * seg * t;
        var r = r0 + (r1 - r0) * t;
        var ex = x + 0.5 - qx, ey = y + 0.5 - qy;
        var dist = Math.sqrt(ex * ex + ey * ey);
        if (dist > r + 0.75) continue;
        var cov = r + 0.5 - dist;
        if (cov > 1) cov = 1; else if (cov <= 0) continue;
        var u = (ex * px + ey * py) / r;
        if (u > 1) u = 1; else if (u < -1) u = -1;
        var nz = Math.sqrt(1 - u * u);
        this.px(x, y, px * u, py * u, nz, zb - nz * r, m, cov, ao);
      }
    }
  };

  Shader.prototype.sphere = function (cx, cy, r, zb, m, ao) {
    this.ellipsoid(cx, cy, r, r, 0, zb, m, ao);
  };

  /* An ellipsoid, optionally rotated -- heads, shoulders, torso masses. */
  Shader.prototype.ellipsoid = function (cx, cy, rx, ry, rot, zb, m, ao) {
    var S = this.S;
    if (S !== 1) { cx *= S; cy *= S; rx *= S; ry *= S; zb *= S; }
    var ca = Math.cos(rot), sa = Math.sin(rot);
    var rr = Math.max(rx, ry);
    var x0 = Math.floor(cx - rr - 1), x1 = Math.ceil(cx + rr + 1);
    var y0 = Math.floor(cy - rr - 1), y1 = Math.ceil(cy + rr + 1);
    if (x0 < this.bx0) x0 = this.bx0; if (y0 < this.by0) y0 = this.by0;
    if (x1 > this.bx1) x1 = this.bx1; if (y1 > this.by1) y1 = this.by1;
    var rz = (rx + ry) * 0.5;

    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        // into the ellipse's own frame
        var lx = dx * ca + dy * sa, ly = -dx * sa + dy * ca;
        var a = lx / rx, b = ly / ry;
        var q = a * a + b * b;
        if (q > 1.3) continue;
        var dq = Math.sqrt(q);
        var cov = (1 - dq) * Math.min(rx, ry) + 0.5;
        if (cov > 1) cov = 1; else if (cov <= 0) continue;
        var nzs = 1 - q;
        var nz = nzs > 0 ? Math.sqrt(nzs) : 0;
        // normal in world frame
        var nlx = a, nly = b;
        var nx = nlx * ca - nly * sa, ny = nlx * sa + nly * ca;
        var il = 1 / Math.max(0.0001, Math.sqrt(nx * nx + ny * ny + nz * nz));
        this.px(x, y, nx * il, ny * il, nz * il, zb - nz * rz, m, cov, ao);
      }
    }
  };

  /* A flat convex polygon, shaded as a slab facing the viewer with a soft
   * bevel toward its edges. Used for cloth panels and blades, where a tube
   * would read wrong. */
  Shader.prototype.polySlab = function (pts, zb, m, bevel, ao) {
    var n = pts.length, i;
    var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (i = 0; i < n; i++) {
      if (pts[i][0] < minX) minX = pts[i][0];
      if (pts[i][0] > maxX) maxX = pts[i][0];
      if (pts[i][1] < minY) minY = pts[i][1];
      if (pts[i][1] > maxY) maxY = pts[i][1];
    }
    var x0 = Math.max(this.bx0, Math.floor(minX)), x1 = Math.min(this.bx1, Math.ceil(maxX) + 1);
    var y0 = Math.max(this.by0, Math.floor(minY)), y1 = Math.min(this.by1, Math.ceil(maxY) + 1);
    var bv = bevel || 3;

    for (var y = y0; y < y1; y++) {
      for (var x = x0; x < x1; x++) {
        // signed distance to the polygon boundary (convex assumption)
        var px = x + 0.5, py = y + 0.5;
        var inside = true, best = 1e9, bnx = 0, bny = 0;
        for (i = 0; i < n; i++) {
          var ax = pts[i][0], ay = pts[i][1];
          var j = (i + 1) % n, bx = pts[j][0], by = pts[j][1];
          var ex = bx - ax, ey = by - ay;
          var el = Math.sqrt(ex * ex + ey * ey);
          if (el < 0.0001) continue;
          var nxe = ey / el, nye = -ex / el;          // outward if CW
          var d = (px - ax) * nxe + (py - ay) * nye;
          if (d > 0.5) { inside = false; break; }
          if (-d < best) { best = -d; bnx = nxe; bny = nye; }
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
