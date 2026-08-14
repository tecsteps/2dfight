/*
 * surface.js -- a 32-bit software surface.
 *
 * The indexed 8-bit framebuffer this engine started with was an authenticity
 * choice, and it capped what the renderer could ever look like: no blending,
 * so no glow, no soft shadow, no motion trail, and shading limited to
 * whatever fitted in a palette ramp.
 *
 * This replaces it with a straight RGBA surface. Everything is still done in
 * software, by hand, one pixel at a time -- there is exactly one canvas call
 * in the whole renderer (putImageData) and no GPU anywhere. What changes is
 * only the range: 24-bit colour and an alpha channel, which is what makes
 * lighting and effects possible at all.
 *
 * Colours are packed 0xAABBGGRR to match the little-endian byte order of
 * ImageData, so a pixel is one 32-bit store.
 */
var FX = FX || {};
(function (F) {
  'use strict';

  function rgb(r, g, b) {
    return (255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  }
  function rgba(r, g, b, a) {
    return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
  }

  function Surface(w, h) {
    this.w = w; this.h = h;
    this.px = new Uint32Array(w * h);
    this.depth = new Float32Array(w * h);   // for the shaded character pass
    this.canvas = null; this.ctx = null; this.img = null; this.out = null;
  }

  /* Attaching re-sizes the canvas backing store, which also clears it. Safe
   * to call again on the same canvas when the render resolution changes. */
  Surface.prototype.attach = function (canvas) {
    this.canvas = canvas;
    canvas.width = this.w; canvas.height = this.h;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.img = this.ctx.createImageData(this.w, this.h);
    this.out = new Uint32Array(this.img.data.buffer);
  };

  /* The one and only canvas call. */
  Surface.prototype.present = function () {
    this.out.set(this.px);
    this.ctx.putImageData(this.img, 0, 0);
  };

  Surface.prototype.clear = function (c) { this.px.fill(c >>> 0); };
  Surface.prototype.copyFrom = function (other) { this.px.set(other.px); };

  /* Copy with an offset, for screen shake and parallax. Rows outside the
   * source are clamped rather than left blank. */
  Surface.prototype.copyFromOffset = function (other, dx, dy) {
    dx = dx | 0; dy = dy | 0;
    if (dx === 0 && dy === 0) { this.px.set(other.px); return; }
    var W = this.w, H = this.h, src = other.px, dst = this.px;
    for (var y = 0; y < H; y++) {
      var sy = y - dy; if (sy < 0) sy = 0; else if (sy >= H) sy = H - 1;
      var so = sy * W, dof = y * W;
      if (dx === 0) { dst.set(src.subarray(so, so + W), dof); continue; }
      // the shifted span is one contiguous row copy; only the exposed edge
      // needs filling, and it fills with the clamped edge pixel
      if (dx > 0) {
        dst.set(src.subarray(so, so + W - dx), dof + dx);
        dst.fill(src[so], dof, dof + dx);
      } else {
        var n = W + dx;
        dst.set(src.subarray(so - dx, so + W), dof);
        dst.fill(src[so + W - 1], dof + n, dof + W);
      }
    }
  };
  /* Copy a horizontal band with its own x offset. Parallax is just this,
   * called once per depth layer. */
  Surface.prototype.copyBand = function (other, y0, y1, dx) {
    dx = Math.round(dx);
    var W = this.w, src = other.px, dst = this.px;
    y0 = Math.max(0, y0 | 0); y1 = Math.min(this.h, y1 | 0);
    for (var y = y0; y < y1; y++) {
      var so = y * W, dof = y * W;
      if (dx === 0) { dst.set(src.subarray(so, so + W), dof); continue; }
      if (dx > 0) {
        dst.set(src.subarray(so, so + W - dx), dof + dx);
        dst.fill(src[so], dof, dof + dx);
      } else {
        var n = W + dx;
        dst.set(src.subarray(so - dx, so + W), dof);
        dst.fill(src[so + W - 1], dof + n, dof + W);
      }
    }
  };

  Surface.prototype.clearDepth = function () { this.depth.fill(1e9); };

  /* Clear only a rectangle of the depth buffer -- the characters occupy a
   * small part of the screen, and clearing half a megabyte of float per
   * frame for that would be most of the frame budget. */
  Surface.prototype.clearDepthRect = function (x0, y0, x1, y1) {
    x0 = Math.max(0, x0 | 0); y0 = Math.max(0, y0 | 0);
    x1 = Math.min(this.w, x1 | 0); y1 = Math.min(this.h, y1 | 0);
    for (var y = y0; y < y1; y++) this.depth.fill(1e9, y * this.w + x0, y * this.w + x1);
  };

  Surface.prototype.fillRect = function (x, y, w, h, c) {
    var x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    var x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    if (x1 <= x0) return;
    for (var yy = y0; yy < y1; yy++) this.px.fill(c >>> 0, yy * this.w + x0, yy * this.w + x1);
  };

  /* Source-over blend of a flat colour. `a` is 0..1. */
  Surface.prototype.blendRect = function (x, y, w, h, r, g, b, a) {
    var x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
    var x1 = Math.min(this.w, (x + w) | 0), y1 = Math.min(this.h, (y + h) | 0);
    if (x1 <= x0 || a <= 0) return;
    var p = this.px, W = this.w;
    var ia = 1 - a, ra = r * a, ga = g * a, ba = b * a;
    for (var yy = y0; yy < y1; yy++) {
      var o = yy * W;
      for (var xx = x0; xx < x1; xx++) {
        var i = o + xx, v = p[i];
        p[i] = 0xff000000 |
          ((((v >>> 16) & 255) * ia + ba) << 16) |
          ((((v >>> 8) & 255) * ia + ga) << 8) |
          (((v & 255) * ia + ra));
      }
    }
  };

  Surface.prototype.blendPx = function (x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    if (a > 1) a = 1;
    var i = y * this.w + x, v = this.px[i], ia = 1 - a;
    this.px[i] = 0xff000000 |
      (((((v >>> 16) & 255) * ia + b * a) | 0) << 16) |
      (((((v >>> 8) & 255) * ia + g * a) | 0) << 8) |
      ((((v & 255) * ia + r * a) | 0));
  };

  /* Additive -- glows, sparks, fire. */
  Surface.prototype.addPx = function (x, y, r, g, b, a) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || a <= 0) return;
    var i = y * this.w + x, v = this.px[i];
    var nr = (v & 255) + r * a, ng = ((v >>> 8) & 255) + g * a, nb = ((v >>> 16) & 255) + b * a;
    this.px[i] = 0xff000000 |
      ((nb > 255 ? 255 : nb | 0) << 16) | ((ng > 255 ? 255 : ng | 0) << 8) | (nr > 255 ? 255 : nr | 0);
  };

  /* Additive disc with a quadratic falloff.
   *
   * This is the hottest routine in the effects layer -- sparks, dust, glows
   * and motion streaks all land here -- and it used to take a square root
   * and make a function call for every pixel it touched. Working in squared
   * distance and writing the pixel inline removes both. The falloff shape
   * changes slightly (1-q)^2 rather than (1-sqrt(q))^2, which is a little
   * fuller in the middle and is compensated in the callers' alpha. */
  Surface.prototype.addDisc = function (cx, cy, rad, r, g, b, a) {
    if (rad <= 0 || a <= 0) return;
    var x0 = Math.max(0, Math.ceil(cx - rad)), x1 = Math.min(this.w - 1, Math.floor(cx + rad));
    var y0 = Math.max(0, Math.ceil(cy - rad)), y1 = Math.min(this.h - 1, Math.floor(cy + rad));
    if (x1 < x0 || y1 < y0) return;
    var ir2 = 1 / (rad * rad), px = this.px, W = this.w;
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy, dy2 = dy * dy, o = y * W;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx;
        var q = (dx * dx + dy2) * ir2;
        if (q >= 1) continue;
        var f = 1 - q;
        var al = a * f * f;
        var i = o + x, v = px[i];
        var nr = (v & 255) + r * al;
        var ng = ((v >>> 8) & 255) + g * al;
        var nb = ((v >>> 16) & 255) + b * al;
        px[i] = 0xff000000 | ((nb > 255 ? 255 : nb | 0) << 16) |
          ((ng > 255 ? 255 : ng | 0) << 8) | (nr > 255 ? 255 : nr | 0);
      }
    }
  };

  /* Soft elliptical shadow -- multiply, so it darkens whatever is under it. */
  Surface.prototype.shadowEllipse = function (cx, cy, rx, ry, strength) {
    var x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(this.w - 1, Math.ceil(cx + rx));
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(this.h - 1, Math.ceil(cy + ry));
    var p = this.px, W = this.w;
    for (var y = y0; y <= y1; y++) {
      var dy = (y - cy) / ry;
      for (var x = x0; x <= x1; x++) {
        var dx = (x - cx) / rx, d = dx * dx + dy * dy;
        if (d >= 1) continue;
        var k = 1 - strength * (1 - d) * (1 - d);
        var i = y * W + x, v = p[i];
        p[i] = 0xff000000 |
          (((((v >>> 16) & 255) * k) | 0) << 16) |
          (((((v >>> 8) & 255) * k) | 0) << 8) |
          ((((v & 255) * k) | 0));
      }
    }
  };

  /* Vertical gradient, used for skies and stage washes. */
  Surface.prototype.gradientV = function (x, y, w, h, c0, c1) {
    var y0 = Math.max(0, y | 0), y1 = Math.min(this.h, (y + h) | 0);
    var r0 = c0 & 255, g0 = (c0 >>> 8) & 255, b0 = (c0 >>> 16) & 255;
    var r1 = c1 & 255, g1 = (c1 >>> 8) & 255, b1 = (c1 >>> 16) & 255;
    for (var yy = y0; yy < y1; yy++) {
      var t = h <= 1 ? 0 : (yy - y) / (h - 1);
      var c = rgb(r0 + (r1 - r0) * t, g0 + (g1 - g0) * t, b0 + (b1 - b0) * t);
      this.fillRect(x, yy, w, 1, c);
    }
  };

  /* Soft alpha disc -- dust and smoke. Drawing these as squares was
   * leaving grey blocks on the floor. */
  Surface.prototype.blendDisc = function (cx, cy, rad, r, g, b, a) {
    if (rad <= 0 || a <= 0) return;
    var x0 = Math.max(0, Math.ceil(cx - rad)), x1 = Math.min(this.w - 1, Math.floor(cx + rad));
    var y0 = Math.max(0, Math.ceil(cy - rad)), y1 = Math.min(this.h - 1, Math.floor(cy + rad));
    if (x1 < x0 || y1 < y0) return;
    var ir2 = 1 / (rad * rad), px = this.px, W = this.w;
    for (var y = y0; y <= y1; y++) {
      var dy = y - cy, dy2 = dy * dy, o = y * W;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx;
        var q = (dx * dx + dy2) * ir2;
        if (q >= 1) continue;
        var al = a * (1 - q);
        if (al > 1) al = 1;
        var i = o + x, v = px[i], ia = 1 - al;
        px[i] = 0xff000000 |
          (((((v >>> 16) & 255) * ia + b * al) | 0) << 16) |
          (((((v >>> 8) & 255) * ia + g * al) | 0) << 8) |
          ((((v & 255) * ia + r * al) | 0));
      }
    }
  };

  /* A soft additive streak along a segment -- motion arcs, no shading. */
  /* An additive capsule along a segment -- motion arcs and speed lines.
   *
   * This used to stamp up to twenty-three overlapping discs along the line,
   * so every pixel near the middle was shaded a dozen times and the alpha
   * stacked unpredictably with the segment's length. One pass over the
   * segment's bounding box, shading each pixel exactly once by its distance
   * to the axis, is both cheaper and gives a streak of even density. */
  Surface.prototype.addStreak = function (ax, ay, bx, by, rad, r, g, b, a) {
    if (rad <= 0 || a <= 0) return;
    var ex = bx - ax, ey = by - ay;
    var len2 = ex * ex + ey * ey;
    var inv = len2 > 1e-6 ? 1 / len2 : 0;
    var x0 = Math.max(0, Math.ceil(Math.min(ax, bx) - rad));
    var x1 = Math.min(this.w - 1, Math.floor(Math.max(ax, bx) + rad));
    var y0 = Math.max(0, Math.ceil(Math.min(ay, by) - rad));
    var y1 = Math.min(this.h - 1, Math.floor(Math.max(ay, by) + rad));
    if (x1 < x0 || y1 < y0) return;
    var ir2 = 1 / (rad * rad), px = this.px, W = this.w;
    for (var y = y0; y <= y1; y++) {
      var vy = y - ay, o = y * W;
      for (var x = x0; x <= x1; x++) {
        var vx = x - ax;
        var t = (vx * ex + vy * ey) * inv;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        var qx = vx - ex * t, qy = vy - ey * t;
        var q = (qx * qx + qy * qy) * ir2;
        if (q >= 1) continue;
        var f = 1 - q;
        var al = a * f * f;
        var i = o + x, v = px[i];
        var nr = (v & 255) + r * al;
        var ng = ((v >>> 8) & 255) + g * al;
        var nb = ((v >>> 16) & 255) + b * al;
        px[i] = 0xff000000 | ((nb > 255 ? 255 : nb | 0) << 16) |
          ((ng > 255 ? 255 : ng | 0) << 8) | (nr > 255 ? 255 : nr | 0);
      }
    }
  };

  /* An additive elliptical annulus -- shockwave rings.
   *
   * Walking the circumference and stamping a disc at each step is both
   * gappy and ruinously expensive: a 150-pixel ring needs ~1500 steps to
   * close, and each stamp shades its own disc, so one ring costs millions of
   * pixel writes. One pass over the bounding box shading by distance from
   * the ring's radius is exact, gapless, and costs the area of the ring. */
  Surface.prototype.addRing = function (cx, cy, rad, thick, squash, r, g, b, a) {
    if (rad <= 0 || a <= 0) return;
    var ry = rad * squash, ty = thick * squash;
    var x0 = Math.max(0, Math.ceil(cx - rad - thick));
    var x1 = Math.min(this.w - 1, Math.floor(cx + rad + thick));
    var y0 = Math.max(0, Math.ceil(cy - ry - ty));
    var y1 = Math.min(this.h - 1, Math.floor(cy + ry + ty));
    if (x1 < x0 || y1 < y0) return;
    var isq = 1 / squash, it = 1 / thick, px = this.px, W = this.w;
    for (var y = y0; y <= y1; y++) {
      var dy = (y - cy) * isq, dy2 = dy * dy, o = y * W;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx;
        var dd = Math.sqrt(dx * dx + dy2) - rad;
        if (dd < 0) dd = -dd;
        if (dd >= thick) continue;
        var f = 1 - dd * it;
        var al = a * f * f;
        var i = o + x, v = px[i];
        var nr = (v & 255) + r * al;
        var ng = ((v >>> 8) & 255) + g * al;
        var nb = ((v >>> 16) & 255) + b * al;
        px[i] = 0xff000000 | ((nb > 255 ? 255 : nb | 0) << 16) |
          ((ng > 255 ? 255 : ng | 0) << 8) | (nr > 255 ? 255 : nr | 0);
      }
    }
  };

  F.Surface = Surface;
  F.rgb = rgb;
  F.rgba = rgba;
})(FX);
