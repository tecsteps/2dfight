/*
 * fight.js -- the match: stage, hit resolution, effects, HUD, AI.
 *
 * The stage is painted once into a backing surface and copied per frame,
 * which leaves the whole frame budget for the things that move. Everything
 * that does move -- fighters, sparks, dust, the shockwave rings -- is drawn
 * live on top.
 *
 * The feel of a fighting game is mostly in three details that cost almost
 * nothing: hitstop (freeze both fighters for a few frames on contact so the
 * blow reads), screen shake scaled to damage, and a flash on the struck
 * body rather than on the whole screen. All three are here.
 */
var FX = FX || {};
(function (F) {
  'use strict';

  /* Framing. The world is the camera's view in abstract units; SCALE turns
   * it into device pixels. Tightening the view from 480x270 to 400x225 (at
   * a matching scale, so the surface stays 1440x810) is a pure zoom: the
   * fighters are ~150 units tall, which was 55% of frame height and is now
   * two thirds -- the proportion a fighting game actually uses. Nothing
   * about the characters changed, only how much room they are given. */
  var W = 444, H = 250;               // world units
  /* Device pixels per world unit. Not a constant: the renderer is entirely
   * on the CPU, so the honest ceiling is whatever the machine can hold at 60
   * frames, and that is a phone-to-desktop range of maybe six to one. The
   * match measures its own frame cost and walks this ladder, so a desktop
   * gets the full 1439x810 and a slow device stays playable instead of
   * running at 20fps in the name of a fixed number. */
  var SCALE_LADDER = [4.05, 3.24, 2.6, 2.05, 1.6];
  var SCALE_START = 1;                // 3.24 -> 1439x810; step up if it holds
  var SCALE = SCALE_LADDER[SCALE_START];
  var GROUND = 216;
  var WALL_TOP = 118;                 // top of the temple wall, in world units
  var WALL_L = 30, WALL_R = W - 30;
  var BAY = 62;                       // pillar-to-pillar pitch, in world units
  /* How high a launched fighter may go. A juggle that carries someone off
   * the top of the frame is not readable, and the headroom depends on the
   * framing above -- so it lives here with the framing, not in the fighter. */
  var CEIL = GROUND - 72;

  /* ---- stage ---------------------------------------------------------- */

  function hash(a, b) {
    var n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967296;
  }

  /* Where the lanterns hang. The floor pools are placed from the same list,
   * so the light on the ground always agrees with the light source. */
  var LANTERNS = (function () {
    var a = [];
    for (var i = 0; i * BAY + 34 < W; i++) a.push(34 + i * BAY);
    return a;
  })();

  /* The stage.
   *
   * The previous version failed on value structure: sky, wall and floor all
   * sat in the same narrow band of dark purple-brown, so the frame read as
   * one flat slab with two characters pasted on it. A stage needs its planes
   * separated -- bright sky, dark mid-ground, mid floor -- and it needs
   * light that visibly lands somewhere. Everything here is painted once into
   * a backing surface and copied per frame, so detail is free at runtime.
   */
  function paintStage(bg) {
    var S = SCALE, w = bg.w, h = bg.h;
    var wallTop = WALL_TOP * S, fy = GROUND * S, wallH = fy - wallTop;
    var i, x, y;

    /* ---- sky ---- */
    bg.gradientV(0, 0, w, wallTop + 2, F.rgb(28, 24, 52), F.rgb(214, 132, 96));
    // the sun, low and mostly behind the wall: a light source you can see
    var sunX = w * 0.70, sunY = wallTop - 4 * S;
    bg.addDisc(sunX, sunY, 62 * S, 255, 150, 92, 0.42);
    bg.addDisc(sunX, sunY, 30 * S, 255, 190, 130, 0.55);
    bg.addDisc(sunX, sunY, 15 * S, 255, 232, 196, 0.85);

    /* ---- distant ranges, hazing toward the sky as they recede ---- */
    /* Far to near, so a near range paints over a far one. Painted the other
     * way round the dark near range punched up through the pale far one as a
     * hard-edged wedge. The profile sums incommensurate sines rather than
     * using |sin|, which has a cusp at every zero crossing -- that cusp was
     * giving every hill the same symmetric hump and a sharp notch between. */
    for (i = 2; i >= 0; i--) {
      var baseY = (WALL_TOP - 2 - i * 11) * S;
      var amp = (30 - i * 8) * S;
      var k = i / 2;                       // 1 = farthest, hazed toward sky
      var col = F.rgb(44 + k * 74, 36 + k * 54, 62 + k * 40);
      for (x = 0; x < w; x++) {
        var t = x / w * 6.2831853;
        var yy = baseY - amp * (
          0.52 + 0.30 * Math.sin(t * (0.7 + i * 0.4) + i * 2.1)
          + 0.14 * Math.sin(t * (1.9 + i * 0.6) + i * 1.3)
          + 0.07 * Math.sin(t * (4.3 + i) + i * 4.7));
        bg.fillRect(x, yy, 1, baseY - yy + 8 * S, col);
      }
    }

    /* ---- temple wall ---- */
    bg.gradientV(0, wallTop, w, wallH, F.rgb(62, 44, 52), F.rgb(26, 18, 24));
    // recessed bays between the pillars: an inset plane with a lit lintel and
    // a shadowed sill, which is what stops the wall reading as one surface
    for (i = 0; i * BAY + 12 < W; i++) {
      var bx = (12 + i * BAY) * S, bw2 = 44 * S;
      var by = wallTop + 9 * S, bh2 = wallH - 20 * S;
      bg.gradientV(bx, by, bw2, bh2, F.rgb(58, 42, 48), F.rgb(34, 25, 31));
      bg.fillRect(bx, by, bw2, 1.4 * S, F.rgb(84, 62, 62));          // lit lintel
      bg.fillRect(bx, by + bh2 - 1.4 * S, bw2, 1.4 * S, F.rgb(12, 8, 12));
      // a lit window deep in the bay
      // the lit window varies bay to bay; identical windows in a perfect row
      // are the strongest "this was generated, not designed" signal there is
      var wa = 0.16 + hash(i, 37) * 0.28;
      bg.blendRect(bx + 15 * S, by + (10 + hash(i, 41) * 5) * S, 14 * S, 20 * S, 226, 146, 78, wa);
      bg.addDisc(bx + 22 * S, by + 22 * S, 16 * S, 255, 156, 74, wa * 0.45);
    }
    // pillars
    for (i = 0; i * BAY + 2 < W + BAY; i++) {
      var px = (2 + i * BAY) * S, pw = 10 * S;
      bg.gradientV(px, wallTop, pw, wallH, F.rgb(104, 78, 76), F.rgb(38, 27, 32));
      bg.fillRect(px, wallTop, 1.6 * S, wallH, F.rgb(142, 112, 104));  // lit edge
      bg.fillRect(px + pw - 1.6 * S, wallTop, 1.6 * S, wallH, F.rgb(20, 14, 18));
      // capital and base
      bg.fillRect(px - 2.4 * S, wallTop, pw + 4.8 * S, 4.5 * S, F.rgb(116, 88, 84));
      bg.fillRect(px - 2.4 * S, wallTop, pw + 4.8 * S, 1.4 * S, F.rgb(164, 132, 120));
      bg.fillRect(px - 2 * S, fy - 6 * S, pw + 4 * S, 6 * S, F.rgb(74, 55, 56));
      bg.fillRect(px - 2 * S, fy - 6 * S, pw + 4 * S, 1.2 * S, F.rgb(112, 86, 80));
    }

    /* ---- spectators on the wall top ----
     * Silhouettes against the bright sky. Nothing sells "this is a place
     * where a fight is happening" like an audience, and against a light sky
     * they cost one dark shape and one warm rim each. */
    for (i = 0; i * 11.6 < W + 12; i++) {
      var cx2 = (6 + i * 11.6 + hash(i, 21) * 5) * S;
      if (hash(i, 53) < 0.10) continue;          // gaps along the rail
      var hh = (6 + hash(i, 5) * 6.5) * S;       // and a real spread of heights
      var cy2 = wallTop - hh * (0.42 + hash(i, 61) * 0.30);
      var bob = hash(i, 9);
      var lean2 = (hash(i, 71) - 0.5) * hh * 0.30;
      bg.blendDisc(cx2 + lean2, cy2 - hh * 0.5, hh * 0.40, 16, 11, 20, 0.94);   // head
      bg.blendDisc(cx2, cy2 + hh * 0.35, hh * 0.64, 16, 11, 20, 0.94);          // shoulders
      // an arm raised, on a few of them
      if (hash(i, 83) > 0.82) {
        bg.blendDisc(cx2 + lean2 * 2 + hh * 0.4, cy2 - hh * 1.05, hh * 0.22, 16, 11, 20, 0.9);
      }
      // warm rim from the sky behind them
      bg.blendDisc(cx2 + lean2 - hh * 0.12, cy2 - hh * 0.62, hh * 0.28, 206, 128, 92, 0.22 + bob * 0.2);
    }
    // the balustrade they stand behind
    bg.fillRect(0, wallTop - 1.5 * S, w, 3.2 * S, F.rgb(92, 68, 68));
    bg.fillRect(0, wallTop - 1.5 * S, w, 1.1 * S, F.rgb(140, 108, 98));

    /* ---- lanterns ---- */
    for (i = 0; i < LANTERNS.length; i++) {
      if (hash(i, 29) < 0.17) continue;          // a gap in the row
      var lx = LANTERNS[i] * S, ly = (WALL_TOP + 22 + hash(i, 3) * 10) * S;
      var lb = 0.80 + hash(i, 17) * 0.20;        // and they are not all as bright
      bg.fillRect(lx - 0.5 * S, wallTop + 3 * S, 1 * S, ly - wallTop - 3 * S, F.rgb(30, 22, 26));
      // paper body, lit from inside
      bg.blendRect(lx - 4 * S, ly, 8 * S, 11 * S, 236, 154, 84, 0.95 * lb);
      bg.blendRect(lx - 4 * S, ly, 8 * S, 2 * S, 255, 206, 150, 0.9 * lb);
      bg.fillRect(lx - 4.6 * S, ly - 1.4 * S, 9.2 * S, 1.6 * S, F.rgb(46, 32, 30));
      bg.fillRect(lx - 4.6 * S, ly + 11 * S, 9.2 * S, 1.6 * S, F.rgb(46, 32, 30));
      bg.addDisc(lx, ly + 5 * S, 26 * S, 255, 150, 66, 0.30 * lb);
      bg.addDisc(lx, ly + 5 * S, 11 * S, 255, 200, 130, 0.42 * lb);
    }

    /* Two hand-placed landmarks at non-multiples of the bay pitch. Without
     * an anchor the eye slides across a repeating pattern and reads the
     * whole wall as wallpaper. */
    var gx0 = 96 * S, gy0 = (WALL_TOP + 30) * S;
    bg.fillRect(gx0 - 22 * S, gy0 - 22 * S, 3 * S, 24 * S, F.rgb(64, 48, 44));
    bg.fillRect(gx0 + 19 * S, gy0 - 22 * S, 3 * S, 24 * S, F.rgb(64, 48, 44));
    bg.fillRect(gx0 - 24 * S, gy0 - 24 * S, 48 * S, 3 * S, F.rgb(78, 58, 52));
    /* The gong. blendDisc falls off toward its edge, so stacking them made
     * a soft yellow smudge rather than an object; a disc needs a hard rim
     * and a defined highlight to read as metal. */
    bg.shadowEllipse(gx0 + 2 * S, gy0 + 3 * S, 19 * S, 19 * S, 0.55);
    for (var gy2 = -18; gy2 <= 18; gy2++) {
      var hw2 = Math.sqrt(Math.max(0, 18 * 18 - gy2 * gy2));
      var tg = (gy2 + 18) / 36;
      bg.fillRect(gx0 - hw2 * S, gy0 + gy2 * S, hw2 * 2 * S, S,
        F.rgb(150 - tg * 74, 112 - tg * 56, 52 - tg * 22));
    }
    // a raised boss in the centre, and a rim -- flat bands across it read as
    // a slot rather than as beaten metal
    for (var gy3 = -7; gy3 <= 7; gy3++) {
      var hw3 = Math.sqrt(Math.max(0, 49 - gy3 * gy3));
      var tb = (gy3 + 7) / 14;
      bg.fillRect(gx0 - hw3 * S, gy0 + gy3 * S, hw3 * 2 * S, S,
        F.rgb(168 - tb * 82, 128 - tb * 62, 60 - tb * 26));
    }
    for (var ga = 0; ga < 40; ga++) {         // rim highlight
      var tha = ga / 40 * Math.PI * 2;
      bg.blendPx((gx0 + Math.cos(tha) * 17.4 * S) | 0, (gy0 + Math.sin(tha) * 17.4 * S) | 0,
        206, 168, 92, 0.55 * Math.max(0, Math.cos(tha + 2.3)));
    }
    bg.addDisc(gx0 - 5 * S, gy0 - 6 * S, 8 * S, 255, 214, 150, 0.30);
    bg.addDisc(gx0 - 5 * S, gy0 - 6 * S, 3.5 * S, 255, 236, 200, 0.34);

    var bnx = 300 * S;                         // and a hanging banner
    bg.blendRect(bnx - 9 * S, wallTop + 4 * S, 18 * S, 56 * S, 128, 34, 40, 0.94);
    bg.blendRect(bnx - 9 * S, wallTop + 4 * S, 18 * S, 3 * S, 176, 58, 58, 0.94);
    bg.blendRect(bnx - 2.5 * S, wallTop + 14 * S, 5 * S, 5 * S, 226, 196, 140, 0.9);
    bg.blendRect(bnx - 2.5 * S, wallTop + 24 * S, 5 * S, 5 * S, 226, 196, 140, 0.9);
    bg.blendRect(bnx - 2.5 * S, wallTop + 34 * S, 5 * S, 5 * S, 226, 196, 140, 0.9);

    /* ---- floor ---- */
    bg.gradientV(0, fy, w, h - fy, F.rgb(132, 102, 88), F.rgb(52, 39, 38));
    var fh = h - fy;
    for (y = 0; y < fh; y++) {
      var d = y / fh;
      if (y % Math.round(8 * S) === 0) {
        bg.fillRect(0, fy + y, w, Math.max(1, 0.5 * S), F.rgb(96 - d * 40, 72 - d * 30, 64 - d * 26));
      }
    }
    // the lanterns land on the floor: warm pools directly below each one
    for (i = 0; i < LANTERNS.length; i++) {
      var px2 = LANTERNS[i] * S;
      for (var q = 0; q < 4; q++) {
        var rr = (34 - q * 7) * S;
        bg.addDisc(px2, fy + 9 * S, rr, 255, 152, 74, 0.075);
        bg.addDisc(px2, fy + 9 * S, rr * 0.5, 255, 190, 120, 0.045);
      }
    }
    // grain
    for (i = 0; i < 3400; i++) {
      var gx = (hash(i, 7) * w) | 0, gy = (fy + hash(i, 11) * fh) | 0;
      var v = hash(i, 3);
      bg.blendPx(gx, gy, 214, 186, 156, 0.04 + v * 0.07);
    }
    // the lip of the platform -- a hard bright line is what reads as an edge
    bg.fillRect(0, fy - 1.2 * S, w, 1.2 * S, F.rgb(46, 32, 34));
    bg.fillRect(0, fy, w, 1.6 * S, F.rgb(178, 138, 108));
    bg.fillRect(0, fy + 1.6 * S, w, 1.4 * S, F.rgb(96, 72, 62));

    /* ---- atmosphere ---- */
    // haze pooling at the base of the wall pushes it back behind the fighters
    for (y = 0; y < 26 * S; y++) {
      var t2 = 1 - y / (26 * S);
      bg.blendRect(0, fy - y, w, 1, 150, 96, 96, 0.10 * t2 * t2);
    }
    // vignette
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        var vx = (x / w - 0.5) * 2, vy = (y / h - 0.5) * 2;
        var r2 = vx * vx * 0.72 + vy * vy * 0.92;
        if (r2 < 0.50) continue;
        bg.blendPx(x, y, 6, 4, 12, Math.min(0.46, (r2 - 0.50) * 0.72));
      }
    }
  }

  /* ---- particles ------------------------------------------------------ */

  function Fx() { this.p = []; this.rings = []; this.shake = 0; this.hitstop = 0; this.flash = 0; }

  /* An impact sprays along the blow, not in all directions. Isotropic
   * sparks made an uppercut and a hook produce the identical puff, and the
   * eye reads direction long before it reads colour. `dir` is the attacker's
   * facing; `up` biases the cone for rising or falling blows. */
  Fx.prototype.spark = function (x, y, n, power, col, dir, up) {
    dir = dir || 1; up = up || 0;
    var base = Math.atan2(-up, dir);
    for (var i = 0; i < n; i++) {
      // a +/-55 degree cone, with a few long spikes at triple speed
      var spike = i < 4;
      var a = base + (Math.random() - 0.5) * (spike ? 0.5 : 1.92);
      var sp = (40 + Math.random() * 170) * power * (spike ? 3.0 : 1);
      this.p.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 30,
        life: (spike ? 0.10 : 0.16) + Math.random() * 0.30, t: 0,
        r: spike ? 1.1 : 1 + Math.random() * 2.4,
        c: col || [255, 226, 150], g: 380, add: 1 });
    }
    // one short bright bloom at the contact point, so the hit has a centre
    this.p.push({ x: x, y: y, vx: 0, vy: 0, life: 0.09, t: 0,
      r: 7 + power * 7, c: col || [255, 226, 150], g: 0, add: 1, bloom: 1 });
  };
  Fx.prototype.dust = function (x, y, n, dir) {
    for (var i = 0; i < n; i++) {
      this.p.push({ x: x + (Math.random() - 0.5) * 12, y: y - Math.random() * 3,
        vx: (Math.random() - 0.3) * 55 * (dir || 1), vy: -18 - Math.random() * 42,
        life: 0.4 + Math.random() * 0.5, t: 0, r: 2 + Math.random() * 4.5,
        c: [210, 176, 142], g: 60, add: 0 });
    }
  };
  Fx.prototype.ring = function (x, y, power, col) {
    this.rings.push({ x: x, y: y, t: 0, life: 0.28, power: power, c: col || [255, 220, 160] });
  };

  Fx.prototype.update = function (dt) {
    var i, a;
    for (i = this.p.length - 1; i >= 0; i--) {
      a = this.p[i];
      a.t += dt;
      if (a.t >= a.life) { this.p.splice(i, 1); continue; }
      a.vy += a.g * dt;
      a.vx *= Math.pow(0.12, dt);
      a.x += a.vx * dt; a.y += a.vy * dt;
    }
    for (i = this.rings.length - 1; i >= 0; i--) {
      a = this.rings[i]; a.t += dt;
      if (a.t >= a.life) this.rings.splice(i, 1);
    }
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 3.2);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 6);
  };

  Fx.prototype.draw = function (surf, ox, oy) {
    var i, a, S = SCALE;
    for (i = 0; i < this.rings.length; i++) {
      a = this.rings[i];
      var u = a.t / a.life;
      var rad = (6 + u * 46 * a.power) * S;
      var al = (1 - u) * (1 - u) * 0.9;
      // a thin expanding shell, drawn additively
      var x0 = a.x * S + ox, y0 = a.y * S + oy;
      // a filled shell with real thickness, falling off on both sides
      var th2 = Math.max(1.4, rad * 0.20);
      var steps = Math.max(40, (rad * 3.2) | 0);
      for (var k = 0; k < steps; k++) {
        var th = k / steps * Math.PI * 2;
        var cth = Math.cos(th), sth = Math.sin(th);
        for (var q2 = -1; q2 <= 1; q2++) {
          var rq = rad + q2 * th2 * 0.5;
          var fq = al * (q2 === 0 ? 1 : 0.45);
          surf.addPx((x0 + cth * rq) | 0, (y0 + sth * rq * 0.62) | 0,
            a.c[0], a.c[1], a.c[2], fq);
        }
      }
    }
    for (i = 0; i < this.p.length; i++) {
      a = this.p[i];
      var t = 1 - a.t / a.life;
      var r = a.r * (a.add ? t : 1 + (1 - t) * 1.4) * S;
      var px2 = a.x * S + ox, py2 = a.y * S + oy;
      if (a.bloom) surf.addDisc(px2, py2, Math.max(1, a.r * S * (0.5 + t)), a.c[0], a.c[1], a.c[2], t * 1.9);
      else if (a.add) surf.addDisc(px2, py2, Math.max(1, r), a.c[0], a.c[1], a.c[2], t * 1.5);
      else surf.blendDisc(px2, py2, Math.max(1, r), a.c[0], a.c[1], a.c[2], t * 0.34);
    }
  };

  /* ---- match ---------------------------------------------------------- */

  function Match(canvas) {
    this.canvas = canvas;
    this.scaleIx = SCALE_START;
    this.sh = new F.Shader(null);
    this.buildSurfaces();
    /* costHold starts high: the first couple of seconds are JIT warm-up and
     * a cold stage repaint, and judging the machine on those frames dropped
     * the resolution on hardware that could hold it comfortably. */
    this.frameCost = 10; this.costN = 0; this.costHold = 180;
    this.frontIx = 0;
    this.fx = new Fx();

    this.a = new F.Fighter(F.SKINS.kai, { name: 'KAI' });
    this.b = new F.Fighter(F.SKINS.ryo, { name: 'RYO' });
    this.a.name = 'KAI'; this.b.name = 'RYO';
    this.reset();

    var self = this;
    this.a.onLand = function () {
      var n = 5 + Math.min(14, (self.a.landV || 0) / 34);
      self.fx.dust(self.a.x, GROUND, n | 0, 1);
      if ((self.a.landV || 0) > 420) self.fx.shake = Math.max(self.fx.shake, 0.18);
    };
    this.b.onLand = function () {
      var n = 5 + Math.min(14, (self.b.landV || 0) / 34);
      self.fx.dust(self.b.x, GROUND, n | 0, -1);
      if ((self.b.landV || 0) > 420) self.fx.shake = Math.max(self.fx.shake, 0.18);
    };

    this.input = { l: 0, r: 0, u: 0, d: 0, p: 0, k: 0, s: 0, g: 0 };
    this.demo = true;
    this.time = 99; this.round = 1; this.wins = [0, 0];
    this.over = 0; this.banner = ''; this.bannerT = 0;
    this.acc = 0; this.last = 0;
    /* Camera. The stage never moved before, which is most of why the frame
     * read as a diorama. Panning alone -- three bands at different rates --
     * turns a backdrop into a place. */
    this.camX = 0; this.camV = 0;
    this.aiT = [0, 0];
    this.aiHold = [null, null];
  }

  Match.prototype.reset = function () {
    this.a.place(W * 0.38, GROUND, 1);
    this.b.place(W * 0.62, GROUND, -1);
    this.a.hp = this.a.maxHp; this.b.hp = this.b.maxHp;
    this.a.meter = this.b.meter = 0;
    this.a.start('idle'); this.b.start('idle');
    this.a.stun = this.b.stun = 0;
    this.a.vx = this.b.vx = 0;
    this.time = 99; this.over = 0;
  };

  Match.prototype.say = function (t, dur) { this.banner = t; this.bannerT = dur || 1.6; };

  /* Resolve one fighter's active frames against the other. */
  Match.prototype.resolve = function (at, df) {
    var d = at.def();
    if (!d.hit || at.hitLanded) return;
    var p = at.progress();
    if (p < d.hit[0] || p > d.hit[1]) return;

    // wake-up and backdash are invulnerable; the flags existed but nothing
    // ever read them, so neither option escaped anything
    if (df.def().inv) return;

    /* Range comes from the limb, not from the move table.
     *
     * `reach * 0.92 + 26` over-reached the drawn limb by between 14 and 39
     * world units depending on the move -- a roundhouse connected with the
     * foot a clear body-width from the victim. HALF_W is the victim's own
     * hurtbox half-width. */
    var HALF_W = 15;
    var tip = F.limbTip(at);
    var dx = (df.x - at.x) * at.facing;
    var tipR = (tip[0] - at.x) * at.facing;
    if (dx < -14 || dx - HALF_W > tipR) return;

    // vertical: the limb has to arrive somewhere on the body
    var lowMove = !!d.low;
    var ty = tip[1];
    if (ty < df.y - 152 || ty > df.y + 8) return;
    // crouching ducks highs, and a low cannot catch an airborne fighter
    var dfCrouch = df.crouchS.v > 0.55;
    if (!lowMove && dfCrouch && !d.super) return;
    if (lowMove && !df.onGround) return;

    at.hitLanded = true;

    /* Contact point: the limb tip, pulled back to the victim's near surface
     * so it never floats past them. Sparks used to spawn from a formula that
     * put them a dozen units in front of the foot and eighteen short of the
     * body, touching neither fighter. */
    var hx = tip[0], hy = tip[1];
    var face = df.x - at.facing * HALF_W;
    if ((hx - face) * at.facing > 0) hx = face;

    // blocking: correct guard height, facing the attacker
    var guarding = (df.move === 'block' || df.move === 'blockLow') &&
      ((df.x - at.x) * df.facing < 0);
    var guardRight = guarding && ((lowMove && df.move === 'blockLow') || (!lowMove && df.move === 'block'));

    if (guardRight) {
      // a grab has no dmg field; blocking one used to set health to NaN
      df.hp = Math.max(0, df.hp - (d.dmg || 0) * 0.12);
      df.vx += at.facing * d.push * 0.45;
      at.vx -= at.facing * 22;
      df.flash = 0.5;
      df.lean.v -= 6; df.hand[1].x.v -= 5;
      /* Blockstun. There was none at all, so blocking anything was a free
       * punish and there was no risk in throwing anything. The attacker eats
       * the larger share on a heavy, which is what makes it punishable. */
      df.stun = Math.max(df.stun, 0.06 + d.hs * 0.28);
      at.stun = Math.max(at.stun, 0.10 + d.hs * 0.55);
      this.fx.spark(hx, hy, 9, 0.5, [180, 220, 255], -at.facing, 0.3);
      this.fx.ring(hx, hy, 0.5, [170, 210, 255]);
      this.fx.shake = Math.max(this.fx.shake, d.hs * 0.4);
      this.fx.hitstop = Math.max(this.fx.hitstop, 0.075);
      at.combo = 0;
      if (this.onSound) this.onSound('block');
      return;
    }

    if (d.grab) {
      var td = F.MOVES.throw.dmg;
      df.hp = Math.max(0, df.hp - td);
      df.start('thrown'); df.stun = 0.9;
      df.vx = at.facing * 240; df.vy = -260; df.onGround = false;
      df.flash = 0.85;
      at.start('throw');
      at.meter = Math.min(100, at.meter + td * 1.5);
      this.fx.spark(hx, hy, 22, 0.9, [255, 210, 160], at.facing, 0.4);
      this.fx.shake = Math.max(this.fx.shake, 0.3);
      this.fx.shakeDir = at.facing;
      if (this.onSound) this.onSound('grab');
      return;
    }

    var dmg = d.dmg * (1 - Math.min(0.45, at.combo * 0.07));
    df.hp = Math.max(0, df.hp - dmg);
    df.flash = 1;

    /* Deform the victim NOW, on the contact frame.
     *
     * `hitHigh` ramps its lean from zero, so with an 8-22 frame hitstop the
     * freeze landed on a body that had barely started reacting -- the head
     * was still moving 17 frames later, long after the impact had passed.
     * The frozen frame has to be the reacting one. These are instant
     * displacements of the pose springs, which then settle normally. */
    var imp = Math.min(1.7, 0.45 + d.dmg / 13);
    df.lean.v -= (lowMove ? -28 : 30) * imp;
    df.headA.v -= 34 * imp;
    df.hipH.v -= 7 * imp;
    df.twist.v += at.facing * df.facing * 24 * imp;
    df.hand[0].x.v -= 20 * imp; df.hand[1].x.v -= 26 * imp;
    df.hand[0].y.v += 10 * imp; df.hand[1].y.v += 15 * imp;
    // and the attacker recoils a little into the blow
    at.lean.v += 5 * imp;
    df.stun = (d.super ? 0.7 : 0.26 + d.hs * 0.5) * (1 - Math.min(0.40, at.combo * 0.06));
    df.vx += at.facing * d.push;
    at.vx -= at.facing * d.push * 0.10;
    at.combo++;
    at.comboT = 0;
    // a super costs meter when it is thrown, not when it connects -- charged
    // on hit only, a whiffed or blocked super was free and repeatable
    if (!d.super) at.meter = Math.min(100, at.meter + dmg * 1.5);

    if (d.launch) {
      /* Juggle decay. Each successive hit while airborne lifts less, and
       * after four the victim simply falls -- otherwise a launcher loops on
       * itself indefinitely, and the measured combo ceiling was however long
       * the attacker cared to keep going. */
      df.juggle = (df.juggle || 0) + (df.onGround ? 0 : 1);
      var lf = Math.pow(0.66, df.juggle);
      if (df.juggle > 3) lf = 0;
      if (df.onGround) df.vy = -d.launch;
      else if (lf > 0) df.vy = Math.max(df.vy - d.launch * 0.35 * lf, -d.launch * 0.8 * lf);
      df.onGround = false;
      df.launched = 1;
      df.start('knockdown');
    } else if (d.trip) {
      df.start('knockdown');
    } else {
      df.start(d.dmg >= 10 ? 'hitHeavy' : (lowMove ? 'hitLow' : 'hitHigh'));
    }

    this.fx.spark(hx, hy, d.super ? 70 : 28 + d.dmg * 2, d.super ? 2.4 : 0.8 + d.dmg / 20,
      d.super ? [255, 190, 255] : [255, 228, 150],
      at.facing, d.launch ? 0.85 : (lowMove ? -0.4 : 0.15));
    if (d.dmg >= 10) this.fx.dust(hx, GROUND, 7, at.facing);
    this.fx.flash = Math.max(this.fx.flash, d.super ? 0.8 : 0.22);
    this.fx.ring(hx, hy, d.super ? 2.2 : 0.6 + d.dmg / 20, d.super ? [255, 170, 255] : null);
    this.fx.shake = Math.max(this.fx.shake, d.hs);
    this.fx.shakeDir = at.facing;
    /* Hitstop. At the old values the whole normal range spanned 7.7 to 10.6
     * frames -- a jab and a roundhouse felt the same -- and 13.7% of the
     * match was frozen. Lower base, steeper slope: lighter lights, heavier
     * heavies, and about half the total freeze. */
    this.fx.hitstop = Math.max(this.fx.hitstop, d.super ? 0.30 : 0.035 + d.hs * 0.30);
    if (d.super) this.fx.flash = 0.8;
    if (this.onSound) this.onSound(d.super ? 'super' : (d.dmg >= 10 ? 'heavy' : 'hit'));
  };

  /* Translate a control struct into a move. */
  Match.prototype.drive = function (f, c, foe) {
    if (f.canAct() && f.onGround) f.facing = foe.x >= f.x ? 1 : -1;
    if (f.hp <= 0) { if (f.move !== 'defeat' && f.onGround) f.start('defeat'); return; }
    if (f.move === 'defeat') return;
    // nothing ever transitioned out of `thrown`: a successful grab locked the
    // victim out of the match permanently
    if (f.move === 'thrown') { if (f.moveDone && f.onGround) f.start('getup'); return; }

    if (f.move === 'knockdown' && f.moveDone && f.onGround) { f.start('getup'); return; }
    if (f.move === 'throw' && f.moveDone) { f.start('idle'); return; }
    /* Hit-confirm cancel. The whole reason moves are sprung trajectories is
     * that they cross-fade; without a cancel window no player could ever
     * see it. Light moves that connected may cancel after their active
     * frames. */
    var d0 = f.def();
    var canCancel = f.hitLanded && d0.hit && f.progress() > d0.hit[1] && d0.dmg <= 10;
    if (!f.canAct() && !canCancel) return;

    var fwd = f.facing > 0 ? c.r : c.l;
    var back = f.facing > 0 ? c.l : c.r;

    /* Airborne. Attacks used to be gated out entirely up here, which meant
     * no jump-in, no air-to-air and no cross-up. Two air normals plus a
     * little drift restore the vertical axis. */
    if (!f.onGround) {
      if (f.launched || f.stun > 0) return;
      if (c.p) { f.start('airPunch'); return; }
      if (c.k) { f.start('airKick'); return; }
      if (fwd) f.vx += f.facing * 9;
      else if (back) f.vx -= f.facing * 9;
      if (f.vx > 150) f.vx = 150; else if (f.vx < -150) f.vx = -150;
      return;
    }

    // double-tap dash
    var tapKey = fwd ? 'f' : (back ? 'b' : null);
    if (tapKey) {
      var lt = f.lastTap, now = this.tick || 0;
      if (!f.tapHeld) {
        if (lt && lt.k === tapKey && now - lt.t < 16) {
          f.start(tapKey === 'f' ? 'dash' : 'backdash');
          f.vx = f.facing * (tapKey === 'f' ? 300 : -260);
          this.fx.dust(f.x, GROUND, 6, f.facing);
          f.lastTap = null; f.tapHeld = 1;
          return;
        }
        f.lastTap = { k: tapKey, t: now };
      }
      f.tapHeld = 1;
    } else f.tapHeld = 0;

    if (c.s && f.meter >= 100) { f.meter = 0; f.start('special'); f.vx = f.facing * 40; return; }
    if (c.g) { f.start('grab'); return; }
    // `cross` sat in the move table with no input path to it at all
    if (c.p) { f.start(c.d ? 'uppercut' : (back ? 'hook' : (fwd ? 'cross' : 'jab'))); return; }
    if (c.k) { f.start(c.d ? 'sweep' : (back ? 'roundhouse' : (c.u ? 'highKick' : 'lowKick'))); return; }
    if (c.u) { f.start('jump'); f.vy = -600; f.onGround = false; f.vx = (fwd ? f.facing : back ? -f.facing : 0) * 118;
      this.fx.dust(f.x, f.y, 7, 1); return; }
    if (c.d) { f.start(back ? 'blockLow' : 'crouch'); return; }
    if (back) { f.start('block'); f.vx = -f.facing * 78; return; }
    if (fwd) { f.start('walk'); f.vx = f.facing * 108; return; }
    f.start('idle');
  };

  Match.prototype.ai = function (f, foe, i, dt) {
    var c = { l: 0, r: 0, u: 0, d: 0, p: 0, k: 0, s: 0, g: 0 };
    this.aiT[i] -= dt;
    var dist = Math.abs(foe.x - f.x);
    var toward = foe.x > f.x ? 'r' : 'l';
    var away = foe.x > f.x ? 'l' : 'r';

    // react to an incoming attack
    var fd = foe.def();
    var incoming = fd.hit && foe.progress() < fd.hit[1] && dist < 96;
    if (incoming && Math.random() < 0.6) {
      c[away] = 1;
      if (fd.low) c.d = 1;
      return c;
    }
    if (this.aiT[i] > 0) return this.aiHold[i] || c;

    /* Whiff punish: if the opponent has committed and their active frames
     * are past, step in and take the free hit. Without this the AI only ever
     * reacted, never capitalised. */
    var whiffed = fd.hit && foe.progress() > fd.hit[1] && !foe.moveDone && dist < 92;
    if (whiffed && Math.random() < 0.72) {
      c[toward] = 1; c.p = 1;
      this.aiT[i] = 0.18; this.aiHold[i] = c; return c;
    }

    if (f.meter >= 100 && dist < 90 && Math.random() < 0.5) { c.s = 1; this.aiT[i] = 0.9; this.aiHold[i] = c; return c; }
    if (dist > 108) { c[toward] = 1; this.aiT[i] = 0.12 + Math.random() * 0.2; this.aiHold[i] = c; return c; }
    if (dist > 74) {
      var rf = Math.random();
      // at range: the long kicks, which need a direction held with the button
      if (rf < 0.24) { c.k = 1; c[away] = 1; }            // roundhouse
      else if (rf < 0.40) { c.k = 1; c.u = 1; }           // highKick
      else if (rf < 0.50) { c.u = 1; c[toward] = 1; }     // jump in
      else c[toward] = 1;
      this.aiT[i] = 0.22 + Math.random() * 0.3;
      this.aiHold[i] = c;
      return c;
    }
    /* Up close. The old table combined a direction with a button in only one
     * branch, so hook, roundhouse and sweep -- every move that needs both --
     * were never once thrown across a whole match. */
    var r = Math.random();
    if (r < 0.16) c.p = 1;                                 // jab
    else if (r < 0.28) { c.p = 1; c[toward] = 1; }         // cross
    else if (r < 0.40) { c.p = 1; c[away] = 1; }           // hook
    else if (r < 0.50) { c.p = 1; c.d = 1; }               // uppercut
    else if (r < 0.60) c.k = 1;                            // lowKick
    else if (r < 0.68) { c.k = 1; c.d = 1; }               // sweep
    else if (r < 0.74) { c.k = 1; c[away] = 1; }           // roundhouse
    else if (r < 0.81) c.g = 1;                            // grab
    else if (r < 0.88) { c.u = 1; c[toward] = 1; }
    else if (r < 0.96) { c[away] = 1; }                    // block / back off
    else c.d = 1;
    this.aiT[i] = 0.18 + Math.random() * 0.30;
    this.aiHold[i] = c;
    return c;
  };

  Match.prototype.step = function (dt) {
    this.tick = (this.tick || 0) + 1;
    /* Nothing ages during hitstop except the freeze itself and the screen
     * flash. The shake used to decay right through it, so a jab's 1.7 frames
     * of shake were entirely consumed inside 7.7 frames of freeze and there
     * was none left when the world started moving again. */
    if (this.fx.hitstop > 0) {
      this.fx.hitstop -= dt;
      if (this.fx.flash > 0) this.fx.flash = Math.max(0, this.fx.flash - dt * 6);
      return;
    }
    this.fx.update(dt);

    if (this.bannerT > 0) this.bannerT -= dt;
    if (!this.over) {
      this.time -= dt;
      if (this.time <= 0) { this.time = 0; this.finish(this.a.hp >= this.b.hp ? 0 : 1); }
    }

    var ca = this.over ? {} : (this.demo ? this.ai(this.a, this.b, 0, dt) : this.readInput());
    var cb = this.over ? {} : this.ai(this.b, this.a, 1, dt);

    this.drive(this.a, ca, this.b);
    this.drive(this.b, cb, this.a);

    this.a.setGround(GROUND); this.b.setGround(GROUND);
    this.a.ceilY = CEIL; this.b.ceilY = CEIL;
    this.a.update(dt, ca); this.b.update(dt, cb);

    this.resolve(this.a, this.b);
    this.resolve(this.b, this.a);


    // walls and body separation
    [this.a, this.b].forEach(function (f) {
      if (f.x < WALL_L) { f.x = WALL_L; f.vx = Math.max(0, f.vx); }
      if (f.x > WALL_R) { f.x = WALL_R; f.vx = Math.min(0, f.vx); }
    });
    var gap = this.b.x - this.a.x;
    if (Math.abs(gap) < 44) {
      var push = (44 - Math.abs(gap)) * 0.5 * Math.sign(gap || 1);
      this.a.x -= push; this.b.x += push;
    }

    if (!this.over && (this.a.hp <= 0 || this.b.hp <= 0)) {
      this.finish(this.a.hp <= 0 ? 1 : 0);
    }
    if (this.over) {
      this.over -= dt;
      if (this.over <= 0) { this.round++; this.reset(); this.say('ROUND ' + this.round, 1.4); }
    }
  };

  Match.prototype.finish = function (winner) {
    if (this.over) return;
    this.over = 3.4;
    this.wins[winner]++;
    var w = winner ? this.b : this.a;
    var l = winner ? this.a : this.b;
    w.start('victory'); l.hp = 0; l.start('defeat');
    this.say('K.O.', 2.2);
    this.fx.flash = 0.9;
    this.fx.shake = 0.9;
    if (this.onSound) this.onSound('ko');
  };

  /* (Re)build the surfaces at the current SCALE and repaint the stage. This
   * costs a stage repaint -- one visible hitch -- so it only runs on a
   * deliberate resolution change, never per frame. */
  Match.prototype.buildSurfaces = function () {
    SCALE = SCALE_LADDER[this.scaleIx];
    F.WORLD.SCALE = SCALE;
    var pw = Math.round(W * SCALE), ph = Math.round(H * SCALE);
    this.surf = new F.Surface(pw, ph);
    this.surf.attach(this.canvas);
    this.bg = new F.Surface(pw, ph);
    paintStage(this.bg);
    this.sh.s = this.surf;
    this.sh.S = SCALE;
    // the page sizes the canvas element to the viewport; its backing store
    // just changed, so it has to lay out again
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new Event('resize'));
    }
  };

  /* Watch the cost of a frame and walk the resolution ladder. Hysteresis in
   * both directions and a hold after each change, so a single slow frame --
   * a GC pause, a tab regaining focus -- cannot start it oscillating. */
  Match.prototype.adaptScale = function (ms) {
    if (this.costHold > 0) { this.costHold--; this.frameCost = ms; return; }
    this.frameCost += (ms - this.frameCost) * 0.05;
    this.costN++;
    if (this.costN < 120) return;
    this.costN = 0;
    /* The gap between the two thresholds has to be wider than the cost ratio
     * between two rungs, or a step down lands somewhere that immediately
     * asks to step back up -- but no wider than necessary, or the ladder
     * sticks on a rung it does not need. Adjacent rungs differ by 1.55x in
     * area, and 8.2 x 1.55 = 12.7, comfortably inside the 13.5 ceiling.
     * The ceiling is 13.5 rather than 16.7 because this only measures the
     * render -- the simulation and the browser's own frame work have to fit
     * in the same budget. */
    if (this.frameCost > 13.5 && this.scaleIx < SCALE_LADDER.length - 1) {
      this.scaleIx++; this.buildSurfaces(); this.costHold = 180;
    } else if (this.frameCost < 8.2 && this.scaleIx > 0) {
      this.scaleIx--; this.buildSurfaces(); this.costHold = 180;
    }
  };

  Match.prototype.readInput = function () {
    var i = this.input;
    return { l: i.l, r: i.r, u: i.u, d: i.d, p: i.p, k: i.k, s: i.s, g: i.g };
  };

  /* ---- render --------------------------------------------------------- */

  Match.prototype.render = function () {
    var surf = this.surf, S = SCALE;

    // follow the midpoint, held back from the stage edges
    var mid = (this.a.x + this.b.x) * 0.5 - W * 0.5;
    var want = Math.max(-46, Math.min(46, mid));
    this.camV += (want - this.camX) * 9 * (1 / 60);
    this.camV *= 0.82;
    this.camX += this.camV;

    /* Screen shake, as a decaying oscillation along the hit direction --
     * white noise reads as a rattle, a sine reads as an impact. */
    var ox = 0, oy = 0;
    if (this.fx.shake > 0) {
      /* Amplitude was 0.09%-0.9% of screen width where commercial fighters
       * run 1-4%, and squaring it made the light hits vanish entirely. */
      var k = this.fx.shake * 30 * S;
      this.shakeT = (this.shakeT || 0) + 1;
      ox = Math.sin(this.shakeT * 1.9) * k * (this.fx.shakeDir || 1);
      oy = Math.sin(this.shakeT * 2.7) * k * 0.45;
    }
    /* Parallax: sky barely moves, the temple wall drifts, the floor tracks
     * the fighters exactly so their feet stay glued to it. */
    var cx = this.camX * S;
    var skyY = WALL_TOP * S, flrY = GROUND * S;
    surf.copyBand(this.bg, 0, skyY, ox - cx * 0.15);
    surf.copyBand(this.bg, skyY, flrY, ox - cx * 0.55);
    surf.copyBand(this.bg, flrY, surf.h, ox - cx);

    var pan = ox - cx;
    this.sh.ox = pan; this.sh.oy = oy;

    /* Super treatment. The move was flagged `super: 1` in the move table and
     * nothing anywhere reacted to it, so the game's money shot rendered
     * exactly like a cross. The stage drops away, the attacker keeps their
     * light and gains a warm ground glow, and the whole thing is driven off
     * the same progress value the strike envelope uses. */
    var sup = null;
    if (this.a.def().super && !this.a.moveDone) sup = this.a;
    else if (this.b.def().super && !this.b.moveDone) sup = this.b;
    if (sup) {
      var sp2 = sup.progress();
      // full darkness through the startup, releasing over the recovery
      var k2 = sp2 < 0.52 ? Math.min(1, sp2 / 0.18) : Math.max(0, 1 - (sp2 - 0.52) / 0.34);
      surf.blendRect(0, 0, surf.w, surf.h, 6, 4, 16, 0.62 * k2);
      // radial light thrown off the attacker
      var gx2 = sup.x * S + pan, gy2 = (sup.y - 62) * S + oy;
      var tc2 = sup.skin.tint;
      surf.addDisc(gx2, gy2, 150 * S * (0.5 + sp2 * 0.9), tc2[0], tc2[1], tc2[2], 0.20 * k2);
      surf.addDisc(gx2, gy2, 62 * S * (0.5 + sp2 * 0.9), tc2[0], tc2[1], tc2[2], 0.28 * k2);
      // speed lines converging on the attacker during the windup
      if (sp2 < 0.5) {
        var n2 = 26;
        for (var q3 = 0; q3 < n2; q3++) {
          var th3 = q3 / n2 * Math.PI * 2 + sp2 * 3;
          var r1 = (150 - sp2 * 190) * S, r2 = r1 + 52 * S;
          surf.addStreak(gx2 + Math.cos(th3) * r1, gy2 + Math.sin(th3) * r1 * 0.8,
            gx2 + Math.cos(th3) * r2, gy2 + Math.sin(th3) * r2 * 0.8,
            1.2 * S, tc2[0], tc2[1], tc2[2], 0.30 * k2);
        }
      }
    }

    F.drawShadowAt(surf, this.a, GROUND, S, pan, oy);
    F.drawShadowAt(surf, this.b, GROUND, S, pan, oy);

    /* One depth pass covering both fighters.
     *
     * They used to get a `begin()` each, and `begin()` clears the depth
     * buffer over its box -- so whichever fighter was drawn second won every
     * overlapping pixel outright. Limbs passed straight through torsos on
     * every throw, juggle and trade. With a single cleared region and a
     * whole-body depth bias per fighter, occlusion falls out of the depth
     * buffer that was already there. */
    var ba = F.fighterBounds(this.a), bb = F.fighterBounds(this.b);
    this.sh.begin(Math.min(ba.x0, bb.x0), Math.min(ba.y0, bb.y0),
      Math.max(ba.x1, bb.x1), Math.max(ba.y1, bb.y1));

    // whoever is committed to a move comes forward, and stays there until
    // the other one commits -- a rule that flips every frame would strobe
    if (this.a.busy() && !this.b.busy()) this.frontIx = 0;
    else if (this.b.busy() && !this.a.busy()) this.frontIx = 1;
    var order = this.frontIx ? [this.a, this.b] : [this.b, this.a];

    for (var i = 0; i < 2; i++) {
      var f = order[i];
      // 20 world units is comfortably more than the body's own depth range
      this.sh.zBias = i === 0 ? 20 : -20;
      F.drawFighter(this.sh, f);
      // motion arc: the working limb's recent path, additively. Free from a
      // solved pose; a sprite sheet would need extra art for every frame.
      /* Motion arc: the working limb's recent path. Additive streaks stack
       * where the samples overlap, so the alpha has to be small -- at the
       * old value a rising uppercut painted a solid white bar across the
       * screen brighter than anything else in frame. */
      var tc = f.skin.tint;
      for (var g = 0; g < f.trail.length; g++) {
        // taper with age: the newest sample is wide and bright, the oldest
        // is a thread. A uniform streak reads as a rendering artifact.
        var seg = f.trail[g], age = (g + 1) / f.trail.length;
        var al = 0.05 + 0.22 * age * age;
        var wd = (0.9 + 2.0 * age) * S;
        surf.addStreak(seg[0][0] * S + pan, seg[0][1] * S + oy,
          seg[1][0] * S + pan, seg[1][1] * S + oy, wd, tc[0], tc[1], tc[2], al * 0.55);
        surf.addStreak(seg[1][0] * S + pan, seg[1][1] * S + oy,
          seg[2][0] * S + pan, seg[2][1] * S + oy, wd * 0.8, tc[0], tc[1], tc[2], al);
      }
    }

    this.sh.zBias = 0;
    this.fx.draw(surf, pan, oy);
    this.sh.ox = 0; this.sh.oy = 0;
    if (this.fx.flash > 0) {
      surf.blendRect(0, 0, surf.w, surf.h, 255, 244, 230, this.fx.flash * 0.5);
    }
    this.hud(surf);
    surf.present();
  };

  /* Chunky vector HUD, drawn with rectangles -- no font asset. */
  /* `ghost` is the chip bar: the damage you just took, draining a beat
   * behind the real value. Its absence was the most conspicuous thing
   * missing from the frame. */
  /* A health bar.
   *
   * Drawn row by row with a horizontal shear, because a parallelogram is
   * most of what makes a bar read as "fighting game" rather than "progress
   * indicator" -- and it costs one add per row. The fill carries a vertical
   * gradient and a specular line at a third height, which is the other half
   * of the read: a flat rectangle of colour looks like debug output no
   * matter how well the rest of the frame is lit.
   */
  function shearRect(surf, x, y, w, h, sk, cb) {
    for (var yy = 0; yy < h; yy++) {
      var off = sk * (h - 1 - yy);
      cb(x + off, y + yy, w, yy / (h - 1 || 1));
    }
  }

  function bar(surf, x, y, w, h, frac, r, g, b, flip, ghost) {
    var sk = h * 0.34 / h;                       // shear per row, ~19 degrees
    var skp = flip ? -0.34 : 0.34;
    // frame: an outer dark plate, then an inner bevel
    shearRect(surf, x - 3, y - 3, w + 6, h + 6, skp, function (bx, by, bw) {
      surf.fillRect(bx, by, bw, 1, F.rgb(12, 10, 15));
    });
    shearRect(surf, x - 1, y - 1, w + 2, h + 2, skp, function (bx, by, bw, t) {
      surf.fillRect(bx, by, bw, 1, F.rgb(96 - t * 40, 86 - t * 36, 92 - t * 38));
    });
    shearRect(surf, x, y, w, h, skp, function (bx, by, bw) {
      surf.fillRect(bx, by, bw, 1, F.rgb(30, 25, 32));
    });

    function fillBar(fr, cr, cg, cb2, spec) {
      var fw = Math.max(0, Math.min(1, fr)) * w;
      if (fw <= 0) return;
      shearRect(surf, x, y, w, h, skp, function (bx, by, bw, t) {
        var fx2 = flip ? bx + bw - fw : bx;
        // vertical gradient, plus a bright line a third of the way down
        var k = 1.02 - t * 0.46;
        if (t > 0.24 && t < 0.34) k += 0.50;
        surf.fillRect(fx2, by, fw, 1, F.rgb(Math.min(255, cr * k),
          Math.min(255, cg * k), Math.min(255, cb2 * k)));
      });
    }
    // the chip bar: damage just taken, draining a beat behind the real value
    if (ghost !== undefined && ghost > frac) fillBar(ghost, 236, 206, 110);
    fillBar(frac, r, g, b);
  }

  /* The super meter, in thirds. A continuous bar tells you nothing about
   * whether you can act; segments tell you at a glance, and MAX has to
   * announce itself. */
  function meterBar(surf, x, y, w, h, frac, flip, t) {
    var skp = flip ? -0.30 : 0.30;
    var maxed = frac >= 0.999;
    shearRect(surf, x - 2, y - 2, w + 4, h + 4, skp, function (bx, by, bw) {
      surf.fillRect(bx, by, bw, 1, F.rgb(12, 10, 15));
    });
    for (var seg = 0; seg < 3; seg++) {
      var sw = (w - 2 * 3) / 3;
      var sx = x + seg * (sw + 3);
      var lo = seg / 3, hi = (seg + 1) / 3;
      var fr = Math.max(0, Math.min(1, (frac - lo) / (hi - lo)));
      shearRect(surf, sx, y, sw, h, skp, function (bx, by, bw, tt) {
        surf.fillRect(bx, by, bw, 1, F.rgb(24, 26, 36));
        if (fr <= 0) return;
        var fw = bw * fr;
        var fx2 = flip ? bx + bw - fw : bx;
        var pulse = maxed ? 0.55 + 0.45 * Math.sin(t * 0.22) : 0;
        var k = (1.15 - tt * 0.35) + pulse * 0.6;
        surf.fillRect(fx2, by, fw, 1, F.rgb(Math.min(255, (maxed ? 255 : 96) * k),
          Math.min(255, (maxed ? 226 : 194) * k), Math.min(255, 255 * k)));
      });
    }
  }

  /* A 3x5 bitmap font written as rows, because the packed-hex version of
   * this was wrong in a dozen places and spelled the fighters' names
   * incorrectly. Rows are legible; hex is not. */
  var FONT = {
    'A': '010101111101101', 'B': '110101110101110', 'C': '011100100100011',
    'D': '110101101101110', 'E': '111100110100111', 'F': '111100110100100',
    'G': '011100101101011', 'H': '101101111101101', 'I': '111010010010111',
    'J': '001001001101010', 'K': '101101110101101', 'L': '100100100100111',
    'M': '101111111101101', 'N': '110101101101101', 'O': '010101101101010',
    'P': '110101110100100', 'Q': '010101101110011', 'R': '110101110101101',
    'S': '011100010001110', 'T': '111010010010010', 'U': '101101101101011',
    'V': '101101101101010', 'W': '101101111111101', 'X': '101101010101101',
    'Y': '101101010010010', 'Z': '111001010100111',
    '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
    '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
    '6': '111100111101111', '7': '111001001001001', '8': '111101111101111',
    '9': '111101111001111',
    '.': '000000000000010', '!': '010010010000010', '-': '000000111000000',
    ' ': '000000000000000'
  };
  function glyph(surf, ch, x, y, px, c) {
    var g = FONT[ch]; if (!g) return;
    for (var r = 0; r < 5; r++) {
      for (var k = 0; k < 3; k++) {
        if (g.charCodeAt(r * 3 + k) === 49) surf.fillRect(x + k * px, y + r * px, px, px, c);
      }
    }
  }
  function text(surf, str, x, y, px, c, shadow) {
    str = String(str).toUpperCase();
    for (var i = 0; i < str.length; i++) {
      if (shadow !== undefined) glyph(surf, str[i], x + i * px * 4 + px, y + px, px, shadow);
      glyph(surf, str[i], x + i * px * 4, y, px, c);
    }
  }
  function textW(str, px) { return String(str).length * px * 4 - px; }
  F.text = text; F.textW = textW;

  Match.prototype.hud = function (surf) {
    var S = SCALE, w = surf.w;
    var bw = 152 * S, bh = 11 * S, by = 12 * S, mg = 14 * S;
    // chip bars trail the real value
    if (this.ghostA === undefined) { this.ghostA = 1; this.ghostB = 1; }
    var ha = this.a.hp / this.a.maxHp, hb = this.b.hp / this.b.maxHp;
    this.ghostA += (ha - this.ghostA) * 0.055; if (this.ghostA < ha) this.ghostA = ha;
    this.ghostB += (hb - this.ghostB) * 0.055; if (this.ghostB < hb) this.ghostB = hb;
    // low health pulses toward white
    function hc(fr, t) {
      if (fr > 0.25) return [226, 72, 62];
      var k = 0.5 + 0.5 * Math.sin(t * 0.42);
      return [226 + 29 * k, 72 + 150 * k, 62 + 140 * k];
    }
    var ca = hc(ha, this.tHud || 0), cb2 = hc(hb, this.tHud || 0);
    this.tHud = (this.tHud || 0) + 1;
    bar(surf, mg, by, bw, bh, ha, ca[0], ca[1], ca[2], false, this.ghostA);
    bar(surf, w - mg - bw, by, bw, bh, hb, cb2[0], cb2[1], cb2[2], true, this.ghostB);
    // super meters
    meterBar(surf, mg + 4 * S, by + bh + 5 * S, bw * 0.56, 4.5 * S, this.a.meter / 100, false, this.tHud);
    meterBar(surf, w - mg - 4 * S - bw * 0.56, by + bh + 5 * S, bw * 0.56, 4.5 * S,
      this.b.meter / 100, true, this.tHud);
    if (this.a.meter >= 100) text(surf, 'MAX', mg + 4 * S + bw * 0.56 + 5 * S, by + bh + 5 * S,
      1.5 * S, F.rgb(255, 236, 170), F.rgb(20, 10, 8));
    if (this.b.meter >= 100) text(surf, 'MAX', w - mg - 4 * S - bw * 0.56 - 5 * S - textW('MAX', 1.5 * S),
      by + bh + 5 * S, 1.5 * S, F.rgb(255, 236, 170), F.rgb(20, 10, 8));

    var np = 1.5 * S;
    text(surf, this.a.name, mg, by + bh + 11 * S, np, F.rgb(240, 226, 200), F.rgb(10, 8, 12));
    var nb = this.b.name;
    text(surf, nb, w - mg - textW(nb, np), by + bh + 11 * S, np, F.rgb(240, 226, 200), F.rgb(10, 8, 12));

    // timer
    var ts = String(Math.max(0, Math.ceil(this.time)));
    if (ts.length < 2) ts = '0' + ts;
    var tp = 3.4 * S;
    surf.fillRect(w / 2 - 19 * S, by - 3 * S, 38 * S, 23 * S, F.rgb(18, 16, 22));
    surf.fillRect(w / 2 - 17 * S, by - 1 * S, 34 * S, 19 * S, F.rgb(10, 8, 12));
    text(surf, ts, w / 2 - textW(ts, tp) / 2, by + 1.5 * S, tp, F.rgb(255, 236, 190), F.rgb(20, 10, 8));

    // round pips
    for (var i = 0; i < 2; i++) {
      for (var k = 0; k < 2; k++) {
        var px = i ? w - mg - 7 * S - k * 11 * S : mg + k * 11 * S;
        var on = this.wins[i] > k;
        var pyy = by + bh + 20 * S, rq = 3.6 * S;
        // a diamond, and a warm glow behind it when the round is won
        if (on) surf.addDisc(px + rq, pyy + rq, rq * 2.4, 255, 190, 90, 0.30);
        for (var dq = -rq; dq <= rq; dq++) {
          var hw = rq - Math.abs(dq);
          surf.fillRect(px + rq - hw, pyy + rq + dq, hw * 2, 1,
            on ? F.rgb(255, 214 - Math.abs(dq) / rq * 60, 110) : F.rgb(52, 45, 52));
        }
      }
    }

    if (this.bannerT > 0 && this.banner) {
      var a = Math.min(1, this.bannerT * 1.6);
      var pop = 1 + 0.35 * Math.exp(-(2.4 - this.bannerT) * 7);
      var bp = 6.4 * S * Math.min(1.28, pop);
      var bwid = textW(this.banner, bp);
      var yy = 56 * S;
      // a scrim keeps the banner off the fighters' faces
      surf.blendRect(0, yy - 7 * S, w, bp * 5 + 14 * S, 8, 4, 10, 0.40 * a);
      text(surf, this.banner, w / 2 - bwid / 2, yy, bp, F.rgb(255, 234, 186), F.rgb(150, 24, 24));
    }
    for (var ci = 0; ci < 2; ci++) {
      var cf = ci ? this.b : this.a;
      if (cf.combo < 2) continue;
      var cs = cf.combo + ' HIT';
      var cp = 2.6 * S * (1 + 0.55 * Math.exp(-(cf.comboT || 0) * 0.35));
      cf.comboT = (cf.comboT || 0) + 1;
      text(surf, cs, ci ? w - 26 * S - textW(cs, cp) : 26 * S, 64 * S, cp,
        F.rgb(255, 210, 120), F.rgb(20, 10, 8));
    }
    if (this.demo) {
      text(surf, 'DEMO', w / 2 - textW('DEMO', 1.8 * S) / 2, surf.h - 13 * S, 1.8 * S,
        F.rgb(200, 190, 180), F.rgb(10, 8, 12));
    }
  };

  Match.prototype.frame = function (now) {
    if (!this.last) this.last = now;
    var dt = Math.min(60, now - this.last) / 1000;
    this.last = now;
    this.acc += dt;
    var fixed = 1 / 60;
    var n = 0;
    while (this.acc >= fixed && n < 4) { this.step(fixed); this.acc -= fixed; n++; }
    var t0 = (typeof performance !== 'undefined' ? performance : Date).now();
    this.render();
    this.adaptScale((typeof performance !== 'undefined' ? performance : Date).now() - t0);
  };

  F.Match = Match;
  F.GROUND = GROUND;
  F.WORLD = { W: W, H: H, SCALE: SCALE };   // .SCALE is updated on each change
})(FX);
