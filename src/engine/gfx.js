/*
 * gfx.js -- software framebuffer.
 *
 * The whole point of this engine: we own every pixel. There is exactly one
 * canvas call in the entire renderer (putImageData). Everything above it is
 * an indexed-colour byte buffer and a hand-written blitter, the way a 1989
 * game would have done it against a VGA mode 13h framebuffer.
 *
 * No SVG. No WebGL. No drawImage, no fillRect, no ctx.translate.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var W = 320, H = 200;

  /* Render scale. The game's whole coordinate system -- the sequence table's
   * chx deltas, tile sizes, room layout -- stays in the original 320x200
   * space. RES only decides how many real pixels each of those units is
   * drawn with, so the figure gains detail without a single movement number
   * changing. Sprites are baked at RES; the blitter and every primitive
   * multiply logical coordinates up on the way in. */
  var RES = 3;

  /* ---- palette -------------------------------------------------------
   * Index 0 is the transparency key in sprites; as a screen colour it is
   * plain black. Everything else is a fixed dungeon/character palette in
   * the spirit of the VGA release.
   */
  var PAL_RGB = [
    0x000000, // 0  transparent key / black
    0x0d0a08, // 1  void
    0x1a1410, // 2  deep shadow
    0x2b211a, // 3  brick shadow
    0x3d2f24, // 4  brick dark
    0x54402f, // 5  brick mid-dark
    0x6b523c, // 6  brick mid
    0x87694e, // 7  brick light
    0xa3856a, // 8  brick highlight
    0xc7a888, // 9  stone highlight
    0xe8d5b5, // 10 bright stone / cream
    0xa87050, // 11 skin shadow
    0xd09068, // 12 skin mid
    0xeeb188, // 13 skin light
    0xa89878, // 14 cloth shadow  (far limbs)
    0xd8c8a8, // 15 cloth mid     (shaded folds)
    0xf0e6cf, // 16 cloth light   (the tunic proper)
    0xfaf5e6, // 17 cloth highlight
    0x1d1a17, // 18 outline / hair dark
    0x8a1c14, // 19 red dark (sash, guard)
    0xc4302010 & 0xffffff, // placeholder, overwritten below
    0x000000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
  ];
  // explicit tail so the table stays readable
  PAL_RGB[20] = 0xc43a24; // red mid
  PAL_RGB[21] = 0xe86a3c; // torch flame / red light
  PAL_RGB[22] = 0xf5c05a; // torch core / gold
  PAL_RGB[23] = 0xfff0b0; // torch hot
  PAL_RGB[24] = 0x243a5e; // guard blue dark
  PAL_RGB[25] = 0x3a5a8c; // guard blue mid
  PAL_RGB[26] = 0x5c82b8; // guard blue light
  PAL_RGB[27] = 0x707070; // steel dark
  PAL_RGB[28] = 0xa8a8a8; // steel mid
  PAL_RGB[29] = 0xe0e4e8; // steel light
  PAL_RGB[30] = 0x2a4a2a; // green (potion glass)
  PAL_RGB[31] = 0x3aa03a; // green light
  // hair is deliberately NOT the outline colour: when they matched, the
  // outline ring fused with the hair and every head grew a halo
  PAL_RGB[32] = 0xb89410; // hair dark   -- the kid is blond, not brunet
  PAL_RGB[33] = 0xdcbc28; // hair mid
  PAL_RGB[34] = 0x141c30; // night sky
  PAL_RGB[35] = 0x6a2a1a; // torch bracket

  P.W = W;
  P.H = H;
  P.RES = RES;

  // named indices used by the rest of the game
  P.C = {
    TRANS: 0, BLACK: 0, VOID: 1, SHADOW: 2,
    BRICK_S: 3, BRICK_D: 4, BRICK_MD: 5, BRICK_M: 6, BRICK_L: 7, BRICK_H: 8,
    STONE_H: 9, CREAM: 10,
    SKIN_D: 11, SKIN_M: 12, SKIN_L: 13,
    CLOTH_D: 14, CLOTH_M: 15, CLOTH_L: 16, CLOTH_H: 17,
    OUTLINE: 18,
    RED_D: 19, RED_M: 20, FLAME: 21, GOLD: 22, HOT: 23,
    BLUE_D: 24, BLUE_M: 25, BLUE_L: 26,
    STEEL_D: 27, STEEL_M: 28, STEEL_L: 29,
    GREEN_D: 30, GREEN_L: 31,
    HAIR_D: 32, HAIR_M: 33, SKY: 34, BRACKET: 35
  };

  function Gfx(w, h, scale) {
    this.s = scale === undefined ? RES : scale;
    this.lw = w || W;
    this.lh = h || H;
    this.w = this.lw * this.s;
    this.h = this.lh * this.s;
    this.buf = new Uint8Array(this.w * this.h);  // framebuffer: one byte/pixel
    this.bg = new Uint8Array(this.w * this.h);   // cached room background
    this.pal32 = new Uint32Array(256);
    this.canvas = null;
    this.ctx = null;
    this.imgData = null;
    this.px32 = null;
    this.buildPalette(0);
  }

  /* Build the ABGR lookup. `flash` lets us do palette tricks -- the cheap
   * old-school way to make the screen react without touching a single pixel. */
  Gfx.prototype.buildPalette = function (flashAmount, flashR, flashG, flashB) {
    var f = flashAmount || 0;
    var fr = flashR === undefined ? 255 : flashR;
    var fg = flashG === undefined ? 255 : flashG;
    var fb = flashB === undefined ? 255 : flashB;
    for (var i = 0; i < 40; i++) {
      var c = PAL_RGB[i] || 0;
      var r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
      if (f > 0) {
        r = (r + (fr - r) * f) | 0;
        g = (g + (fg - g) * f) | 0;
        b = (b + (fb - b) * f) | 0;
      }
      this.pal32[i] = (255 << 24) | (b << 16) | (g << 8) | r;
    }
  };

  Gfx.prototype.attach = function (canvas) {
    this.canvas = canvas;
    canvas.width = this.w;
    canvas.height = this.h;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.imgData = this.ctx.createImageData(this.w, this.h);
    this.px32 = new Uint32Array(this.imgData.data.buffer);
  };

  /* The one and only canvas call. Expand indexed bytes through the palette
   * into the ImageData and hand it to the browser. */
  Gfx.prototype.present = function () {
    var b = this.buf, p = this.px32, pal = this.pal32, n = this.w * this.h;
    for (var i = 0; i < n; i++) p[i] = pal[b[i]];
    this.ctx.putImageData(this.imgData, 0, 0);
  };

  Gfx.prototype.clear = function (c) { this.buf.fill(c | 0); };
  Gfx.prototype.clearBg = function (c) { this.bg.fill(c | 0); };

  /* Restore the framebuffer from the cached room background. This is the
   * classic "erase by redrawing the background" step that every sprite game
   * did before compositing was free. */
  Gfx.prototype.restore = function () { this.buf.set(this.bg); };

  // logical-space pixel: becomes an s-by-s block
  Gfx.prototype.px = function (x, y, c) { this.fillRect(x, y, 1, 1, c); };

  // device-space pixel, for code that is already working in real pixels
  Gfx.prototype.pxRaw = function (x, y, c, target) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    (target || this.buf)[y * this.w + x] = c;
  };

  Gfx.prototype.fillRect = function (x, y, w, h, c, target) {
    var t = target || this.buf, W = this.w, s = this.s;
    var x0 = Math.round(x * s), y0 = Math.round(y * s);
    var x1 = Math.round((x + w) * s), y1 = Math.round((y + h) * s);
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > W) x1 = W; if (y1 > this.h) y1 = this.h;
    if (x1 <= x0) return;
    for (var yy = y0; yy < y1; yy++) t.fill(c, yy * W + x0, yy * W + x1);
  };

  Gfx.prototype.hline = function (x, y, w, c, target) { this.fillRect(x, y, w, 1, c, target); };

  Gfx.prototype.vline = function (x, y, h, c, target) { this.fillRect(x, y, 1, h, c, target); };

  /* ---- the blitter ---------------------------------------------------
   * Sprite = { w, h, ox, oy, data:Uint8Array } with 0 as the transparency
   * key. (x, y) is the sprite's reference point (feet-centre for actors);
   * ox/oy shift from that point to the top-left of the stored bitmap.
   *
   * `flip` mirrors horizontally about the reference point, which is how a
   * single set of right-facing frames serves both directions -- exactly the
   * trick the original used to halve its sprite budget.
   */
  Gfx.prototype.blit = function (spr, x, y, flip, target, clipTop, clipBot) {
    if (!spr) return;
    var t = target || this.buf, W = this.w, H = this.h, s = this.s;
    var sw = spr.w, sh = spr.h, d = spr.data;
    var px = Math.round(x * s), py = Math.round(y * s);
    var dx0 = flip ? (px - spr.ox - sw + 1) : (px + spr.ox);
    var dy0 = py + spr.oy;

    var top = clipTop === undefined ? 0 : clipTop * s;
    var bot = clipBot === undefined ? H : clipBot * s;

    var sy0 = 0, sy1 = sh;
    if (dy0 < top) sy0 = top - dy0;
    if (dy0 + sh > bot) sy1 = bot - dy0;

    for (var sy = sy0; sy < sy1; sy++) {
      var ty = dy0 + sy;
      var srow = sy * sw;
      var trow = ty * W;
      if (!flip) {
        var sx0 = 0, sx1 = sw;
        if (dx0 < 0) sx0 = -dx0;
        if (dx0 + sw > W) sx1 = W - dx0;
        for (var sx = sx0; sx < sx1; sx++) {
          var v = d[srow + sx];
          if (v) t[trow + dx0 + sx] = v;
        }
      } else {
        // mirrored: source column sx lands at dx0 + (sw-1-sx)
        for (var fx = 0; fx < sw; fx++) {
          var v2 = d[srow + fx];
          if (!v2) continue;
          var tx = dx0 + (sw - 1 - fx);
          if (tx < 0 || tx >= W) continue;
          t[trow + tx] = v2;
        }
      }
    }
  };

  /* Blit remapped through a colour table -- used for the guard (same rig,
   * different wardrobe) and for silhouette/flash effects. */
  Gfx.prototype.blitRemap = function (spr, x, y, flip, map, target, clipTop, clipBot) {
    if (!spr) return;
    var t = target || this.buf, W = this.w, H = this.h, s = this.s;
    var sw = spr.w, sh = spr.h, d = spr.data;
    var px = Math.round(x * s), py = Math.round(y * s);
    var dx0 = flip ? (px - spr.ox - sw + 1) : (px + spr.ox);
    var dy0 = py + spr.oy;
    var top = clipTop === undefined ? 0 : clipTop * s;
    var bot = clipBot === undefined ? H : clipBot * s;
    var sy0 = 0, sy1 = sh;
    if (dy0 < top) sy0 = top - dy0;
    if (dy0 + sh > bot) sy1 = bot - dy0;
    for (var sy = sy0; sy < sy1; sy++) {
      var trow = (dy0 + sy) * W, srow = sy * sw;
      for (var sx = 0; sx < sw; sx++) {
        var v = d[srow + sx];
        if (!v) continue;
        var tx = flip ? dx0 + (sw - 1 - sx) : dx0 + sx;
        if (tx < 0 || tx >= W) continue;
        t[trow + tx] = map[v] || v;
      }
    }
  };

  P.Gfx = Gfx;
  P.PAL_RGB = PAL_RGB;
})(POP);
