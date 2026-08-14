/*
 * raster.js -- the bake-time rasteriser.
 *
 * This is the tool half of the engine. At startup we draw every character
 * pose once, at 3x, with scanline polygon fills, then majority-vote it down
 * to 1x and grow a dark outline. The result is a plain indexed bitmap.
 *
 * After boot this file is never touched again: the runtime only ever blits
 * finished bytes. That split -- an offline-ish art pipeline feeding a dumb
 * fast blitter -- is exactly how the original was structured, except their
 * pipeline ran on a VHS deck and a light table.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  /* Supersample factor used while baking. At RES=1 this wanted to be 3 to
   * keep thin limbs solid; now that sprites are baked at RES the effective
   * oversample is RES*SS, so 2 is plenty and costs a third less. */
  var SS = 2;

  /* The canvas carries a parallel part-id plane. Every fill stamps the
   * current partId alongside the colour, so afterwards we know which pixel
   * belongs to which limb -- that is what lets us draw outlines *between*
   * overlapping body parts, not just around the silhouette. Without it a
   * white-clothed figure collapses into one unreadable blob. */
  function Canvas(w, h) {
    this.w = w; this.h = h;
    this.data = new Uint8Array(w * h);
    this.part = new Uint8Array(w * h);
    this.partId = 1;
  }
  Canvas.prototype.clear = function () { this.data.fill(0); this.part.fill(0); };

  P.RasterCanvas = Canvas;

  /* --- scanline convex/simple polygon fill, even-odd ------------------ */
  function fillPoly(cv, pts, color) {
    var n = pts.length / 2;
    if (n < 3) return;
    var minY = 1e9, maxY = -1e9, i;
    for (i = 0; i < n; i++) {
      var y = pts[i * 2 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    var y0 = Math.max(0, Math.ceil(minY));
    var y1 = Math.min(cv.h - 1, Math.floor(maxY));
    var xs = [];
    for (var sy = y0; sy <= y1; sy++) {
      var cy = sy + 0.5;
      xs.length = 0;
      for (i = 0; i < n; i++) {
        var ax = pts[i * 2], ay = pts[i * 2 + 1];
        var j = (i + 1) % n;
        var bx = pts[j * 2], by = pts[j * 2 + 1];
        if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
          xs.push(ax + (cy - ay) / (by - ay) * (bx - ax));
        }
      }
      if (xs.length < 2) continue;
      xs.sort(function (a, b) { return a - b; });
      for (var k = 0; k + 1 < xs.length; k += 2) {
        var xa = Math.max(0, Math.ceil(xs[k] - 0.5));
        var xb = Math.min(cv.w - 1, Math.floor(xs[k + 1] - 0.5));
        if (xb < xa) continue;
        span(cv, sy, xa, xb, color);
      }
    }
  }

  function span(cv, y, xa, xb, color) {
    var o = y * cv.w;
    cv.data.fill(color, o + xa, o + xb + 1);
    cv.part.fill(cv.partId, o + xa, o + xb + 1);
  }

  function disc(cv, cx, cy, r, color) {
    if (r <= 0) return;
    var y0 = Math.max(0, Math.ceil(cy - r)), y1 = Math.min(cv.h - 1, Math.floor(cy + r));
    var r2 = r * r;
    for (var y = y0; y <= y1; y++) {
      var dy = y + 0.5 - cy;
      var t = r2 - dy * dy;
      if (t <= 0) continue;
      var hw = Math.sqrt(t);
      var xa = Math.max(0, Math.ceil(cx - hw - 0.5));
      var xb = Math.min(cv.w - 1, Math.floor(cx + hw - 0.5));
      if (xb < xa) continue;
      span(cv, y, xa, xb, color);
    }
  }

  /* Tapered capsule: a limb. Quad body plus round caps so joints hinge
   * cleanly without gaps at any angle. */
  function capsule(cv, x0, y0, x1, y1, r0, r1, color) {
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.0001) { disc(cv, x0, y0, Math.max(r0, r1), color); return; }
    var nx = -dy / len, ny = dx / len;
    fillPoly(cv, [
      x0 + nx * r0, y0 + ny * r0,
      x1 + nx * r1, y1 + ny * r1,
      x1 - nx * r1, y1 - ny * r1,
      x0 - nx * r0, y0 - ny * r0
    ], color);
    disc(cv, x0, y0, r0, color);
    disc(cv, x1, y1, r1, color);
  }

  function ellipse(cv, cx, cy, rx, ry, color) {
    var y0 = Math.max(0, Math.ceil(cy - ry)), y1 = Math.min(cv.h - 1, Math.floor(cy + ry));
    for (var y = y0; y <= y1; y++) {
      var dy = (y + 0.5 - cy) / ry;
      var t = 1 - dy * dy;
      if (t <= 0) continue;
      var hw = rx * Math.sqrt(t);
      var xa = Math.max(0, Math.ceil(cx - hw - 0.5));
      var xb = Math.min(cv.w - 1, Math.floor(cx + hw - 0.5));
      if (xb < xa) continue;
      span(cv, y, xa, xb, color);
    }
  }

  /* --- downsample by majority vote ------------------------------------
   * Straight point-sampling at 1x turns thin limbs into dotted lines. A
   * majority vote over the SSxSS block keeps limbs solid and quantises the
   * shading into clean bands, which is what pixel art wants.
   */
  /* There are only SS*SS samples per output pixel -- at SS=2 that is four.
   * Clearing and scanning a 64-bucket histogram for four samples costs
   * around fifty times more than tallying them directly, and with tens of
   * thousands of output pixels per pose that was most of the bake. */
  function downsample(hi, w, h, coverage) {
    var out = new Uint8Array(w * h);
    var outPart = new Uint8Array(w * h);
    var need = coverage === undefined ? Math.max(1, Math.round(SS * SS * 0.42)) : coverage;
    var N = SS * SS;
    var cv = new Uint8Array(N), cn = new Uint8Array(N);
    var pv = new Uint8Array(N), pn = new Uint8Array(N);
    var hw = hi.w, hd = hi.data, hp = hi.part;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var nc = 0, np = 0, opaque = 0, i;
        for (var sy = 0; sy < SS; sy++) {
          var row = (y * SS + sy) * hw + x * SS;
          for (var sx = 0; sx < SS; sx++) {
            var v = hd[row + sx];
            if (!v) continue;
            opaque++;
            var f = -1;
            for (i = 0; i < nc; i++) if (cv[i] === v) { f = i; break; }
            if (f < 0) { cv[nc] = v; cn[nc] = 1; nc++; } else cn[f]++;
            var p = hp[row + sx];
            f = -1;
            for (i = 0; i < np; i++) if (pv[i] === p) { f = i; break; }
            if (f < 0) { pv[np] = p; pn[np] = 1; np++; } else pn[f]++;
          }
        }
        if (opaque < need) continue;
        var best = 0, bestN = 0;
        for (i = 0; i < nc; i++) if (cn[i] > bestN) { bestN = cn[i]; best = cv[i]; }
        var bp = 0, bpN = 0;
        for (i = 0; i < np; i++) if (pn[i] > bpN) { bpN = pn[i]; bp = pv[i]; }
        out[y * w + x] = best;
        outPart[y * w + x] = bp;
      }
    }
    return { color: out, part: outPart };
  }

  /* Grow a 1px dark border around the silhouette. The original sprites read
   * clearly against busy brickwork because of exactly this. */
  function outline(data, w, h, color, part) {
    var out = new Uint8Array(data);
    var i, x, y;
    // internal edges first: where two different parts touch, darken the one
    // that was drawn earlier (further back), so the nearer limb reads on top
    if (part) {
      for (y = 0; y < h; y++) {
        for (x = 0; x < w; x++) {
          i = y * w + x;
          var pa = part[i];
          if (!pa) continue;
          var pb;
          if (x < w - 1) {
            pb = part[i + 1];
            if (pb && pb !== pa) out[pb > pa ? i : i + 1] = color;
          }
          if (y < h - 1) {
            pb = part[i + w];
            if (pb && pb !== pa) out[pb > pa ? i : i + w] = color;
          }
        }
      }
    }
    // then the silhouette
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (data[i]) continue;
        var hit = false;
        if (x > 0 && data[i - 1]) hit = true;
        else if (x < w - 1 && data[i + 1]) hit = true;
        else if (y > 0 && data[i - w]) hit = true;
        else if (y < h - 1 && data[i + w]) hit = true;
        if (hit) out[i] = color;
      }
    }
    return out;
  }

  /* Crop to the used bounding box and record where the reference point
   * ended up, so the blitter can put it back exactly. */
  function crop(data, w, h, refX, refY) {
    var minX = w, minY = h, maxX = -1, maxY = -1;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!data[y * w + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return { w: 1, h: 1, ox: 0, oy: 0, data: new Uint8Array(1) };
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var out = new Uint8Array(cw * ch);
    for (var yy = 0; yy < ch; yy++) {
      for (var xx = 0; xx < cw; xx++) {
        out[yy * cw + xx] = data[(minY + yy) * w + (minX + xx)];
      }
    }
    return { w: cw, h: ch, ox: minX - refX, oy: minY - refY, data: out };
  }

  P.Raster = {
    SS: SS,
    fillPoly: fillPoly,
    disc: disc,
    capsule: capsule,
    ellipse: ellipse,
    downsample: downsample,
    outline: outline,
    crop: crop
  };
})(POP);
