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

  var W = 480, H = 270;               // world units
  var SCALE = 2;                      // device pixels per world unit
  var GROUND = 232;
  var WALL_L = 34, WALL_R = W - 34;

  /* ---- stage ---------------------------------------------------------- */

  function hash(a, b) {
    var n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967296;
  }

  function paintStage(bg) {
    var S = SCALE, w = bg.w, h = bg.h;
    // dusk sky
    bg.gradientV(0, 0, w, GROUND * S, F.rgb(48, 36, 62), F.rgb(196, 118, 96));
    // sun haze
    bg.addDisc(w * 0.66, GROUND * S * 0.74, 190 * S / 2, 255, 176, 120, 0.5);
    bg.addDisc(w * 0.66, GROUND * S * 0.74, 90 * S / 2, 255, 214, 160, 0.55);

    // far mountains
    var i, x, y;
    for (i = 0; i < 3; i++) {
      var baseY = (GROUND - 44 - i * 9) * S;
      var amp = (26 - i * 6) * S;
      var col = F.rgb(52 + i * 12, 44 + i * 12, 70 + i * 10);
      for (x = 0; x < w; x++) {
        var t = x / w;
        var yy = baseY - Math.abs(Math.sin(t * (5 + i * 3) + i)) * amp
          - Math.sin(t * (17 + i * 7)) * amp * 0.22;
        bg.fillRect(x, yy, 1, baseY - yy + 6 * S, col);
      }
    }

    // temple wall behind the arena
    var wallTop = (GROUND - 132) * S, wallH = (GROUND - 6) * S - wallTop;
    bg.gradientV(0, wallTop, w, wallH, F.rgb(74, 56, 62), F.rgb(44, 32, 40));
    // pillars
    for (i = 0; i < 7; i++) {
      var px = (24 + i * 74) * S;
      bg.gradientV(px, wallTop, 15 * S, wallH, F.rgb(96, 74, 78), F.rgb(52, 38, 46));
      bg.fillRect(px, wallTop, 2 * S, wallH, F.rgb(126, 100, 100));
      bg.fillRect(px + 13 * S, wallTop, 2 * S, wallH, F.rgb(34, 24, 30));
      // capital
      bg.fillRect(px - 3 * S, wallTop, 21 * S, 5 * S, F.rgb(108, 84, 86));
      bg.fillRect(px - 3 * S, wallTop, 21 * S, 1.5 * S, F.rgb(148, 120, 116));
    }
    // hanging lanterns
    for (i = 0; i < 6; i++) {
      var lx = (52 + i * 76) * S, ly = (GROUND - 148) * S;
      bg.fillRect(lx, wallTop - 22 * S, 1 * S, 22 * S, F.rgb(40, 30, 34));
      bg.addDisc(lx, ly + 8 * S, 16 * S, 255, 150, 70, 0.30);
    }

    // floor: a stone platform in perspective
    var fy = GROUND * S;
    bg.gradientV(0, fy, w, h - fy, F.rgb(92, 72, 68), F.rgb(30, 24, 26));
    // boards converging slightly, plus grain
    for (y = 0; y < h - fy; y++) {
      var d = y / (h - fy);
      var lineC = F.rgb(70 - d * 30, 54 - d * 22, 52 - d * 22);
      if (y % Math.round(9 * S) === 0) bg.fillRect(0, fy + y, w, 1, lineC);
    }
    for (i = 0; i < 2600; i++) {
      var gx = (hash(i, 7) * w) | 0, gy = (fy + hash(i, 11) * (h - fy)) | 0;
      var v = hash(i, 3);
      bg.blendPx(gx, gy, 210, 180, 150, 0.05 + v * 0.07);
    }
    // front edge highlight
    bg.fillRect(0, fy, w, 1.5 * S, F.rgb(150, 120, 104));
    bg.fillRect(0, fy - 1 * S, w, 1 * S, F.rgb(58, 42, 44));

    // vignette
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x += 1) {
        var dx = (x / w - 0.5) * 2, dy = (y / h - 0.5) * 2;
        var r = dx * dx * 0.7 + dy * dy * 0.9;
        if (r < 0.55) { x += 0; continue; }
        var k = Math.min(0.62, (r - 0.55) * 0.85);
        bg.blendPx(x, y, 8, 6, 14, k);
      }
    }
  }

  /* ---- particles ------------------------------------------------------ */

  function Fx() { this.p = []; this.rings = []; this.shake = 0; this.hitstop = 0; this.flash = 0; }

  Fx.prototype.spark = function (x, y, n, power, col) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2;
      var sp = (30 + Math.random() * 190) * power;
      this.p.push({ x: x, y: y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 40,
        life: 0.18 + Math.random() * 0.34, t: 0, r: 1 + Math.random() * 2.4,
        c: col || [255, 226, 150], g: 380, add: 1 });
    }
  };
  Fx.prototype.dust = function (x, y, n, dir) {
    for (var i = 0; i < n; i++) {
      this.p.push({ x: x + (Math.random() - 0.5) * 12, y: y - Math.random() * 3,
        vx: (Math.random() - 0.3) * 55 * (dir || 1), vy: -18 - Math.random() * 42,
        life: 0.4 + Math.random() * 0.5, t: 0, r: 2 + Math.random() * 4.5,
        c: [186, 160, 138], g: 60, add: 0 });
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
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 5.5);
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
      var steps = Math.max(18, (rad * 0.9) | 0);
      for (var k = 0; k < steps; k++) {
        var th = k / steps * Math.PI * 2;
        var px = x0 + Math.cos(th) * rad, py = y0 + Math.sin(th) * rad * 0.62;
        surf.addPx(px | 0, py | 0, a.c[0], a.c[1], a.c[2], al);
        surf.addPx((px + 1) | 0, py | 0, a.c[0], a.c[1], a.c[2], al * 0.6);
      }
    }
    for (i = 0; i < this.p.length; i++) {
      a = this.p[i];
      var t = 1 - a.t / a.life;
      var r = a.r * (a.add ? t : 1 + (1 - t) * 1.4) * S;
      var px2 = a.x * S + ox, py2 = a.y * S + oy;
      if (a.add) surf.addDisc(px2, py2, Math.max(1, r), a.c[0], a.c[1], a.c[2], t * 1.5);
      else surf.blendDisc(px2, py2, Math.max(1, r), a.c[0], a.c[1], a.c[2], t * 0.34);
    }
  };

  /* ---- match ---------------------------------------------------------- */

  function Match(canvas) {
    this.surf = new F.Surface(W * SCALE, H * SCALE);
    this.surf.attach(canvas);
    this.bg = new F.Surface(W * SCALE, H * SCALE);
    paintStage(this.bg);

    this.sh = new F.Shader(this.surf);
    this.sh.S = SCALE;
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

    var dx = (df.x - at.x) * at.facing;
    var reachW = d.reach * 0.92 + 26;
    if (dx < -12 || dx > reachW) return;
    // height check: crouching ducks highs, jumping avoids lows
    var lowMove = !!d.low;
    var dfCrouch = df.crouchS.v > 0.55;
    if (!lowMove && dfCrouch && !d.super) return;
    if (lowMove && !df.onGround) return;

    at.hitLanded = true;

    var hx = at.x + at.facing * (dx * 0.6 + 14);
    var hy = df.y - (lowMove ? 22 : 78);

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
      this.fx.spark(hx, hy, 9, 0.5, [180, 220, 255]);
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
      this.fx.spark(hx, hy, 22, 0.9, [255, 210, 160]);
      this.fx.shake = Math.max(this.fx.shake, 0.3);
      this.fx.shakeDir = at.facing;
      if (this.onSound) this.onSound('grab');
      return;
    }

    var dmg = d.dmg * (1 - Math.min(0.45, at.combo * 0.07));
    df.hp = Math.max(0, df.hp - dmg);
    df.flash = 1;
    df.stun = (d.super ? 0.7 : 0.26 + d.hs * 0.5) * (1 - Math.min(0.40, at.combo * 0.06));
    df.vx += at.facing * d.push;
    at.vx -= at.facing * d.push * 0.10;
    at.combo++;
    at.comboT = 0;
    at.meter = Math.min(100, at.meter + (d.super ? -100 : dmg * 1.5));

    if (d.launch) {
      /* Only launch from the floor, or from the top of an existing arc.
       * Re-applying full launch velocity on every juggle hit walked the
       * victim off the top of the screen. */
      if (df.onGround) df.vy = -d.launch;
      else df.vy = Math.max(df.vy - d.launch * 0.35, -d.launch * 0.8);
      df.onGround = false;
      df.start('knockdown');
    } else if (d.trip) {
      df.start('knockdown');
    } else {
      df.start(d.dmg >= 10 ? 'hitHeavy' : (lowMove ? 'hitLow' : 'hitHigh'));
    }

    this.fx.spark(hx, hy, d.super ? 70 : 28 + d.dmg * 2, d.super ? 2.4 : 0.8 + d.dmg / 20,
      d.super ? [255, 190, 255] : [255, 228, 150]);
    if (d.dmg >= 10) this.fx.dust(hx, GROUND, 7, at.facing);
    this.fx.flash = Math.max(this.fx.flash, d.super ? 0.8 : 0.22);
    this.fx.ring(hx, hy, d.super ? 2.2 : 0.6 + d.dmg / 20, d.super ? [255, 170, 255] : null);
    this.fx.shake = Math.max(this.fx.shake, d.hs);
    this.fx.shakeDir = at.facing;
    this.fx.hitstop = Math.max(this.fx.hitstop, d.super ? 0.36 : 0.09 + d.hs * 0.24);
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

    if (!f.onGround) return;

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

    if (c.s && f.meter >= 100) { f.start('special'); f.vx = f.facing * 40; return; }
    if (c.g) { f.start('grab'); return; }
    if (c.p) { f.start(c.d ? 'uppercut' : (back ? 'hook' : 'jab')); return; }
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

    if (f.meter >= 100 && dist < 90 && Math.random() < 0.5) { c.s = 1; this.aiT[i] = 0.9; this.aiHold[i] = c; return c; }
    if (dist > 108) { c[toward] = 1; this.aiT[i] = 0.12 + Math.random() * 0.2; this.aiHold[i] = c; return c; }
    if (dist > 74) {
      if (Math.random() < 0.42) { c.k = 1; c.u = Math.random() < 0.4 ? 1 : 0; }
      else c[toward] = 1;
      this.aiT[i] = 0.22 + Math.random() * 0.3;
      return c;
    }
    var r = Math.random();
    if (r < 0.30) c.p = 1;
    else if (r < 0.46) { c.p = 1; c.d = 1; }
    else if (r < 0.60) c.k = 1;
    else if (r < 0.68) c.g = 1;
    else if (r < 0.78) { c.u = 1; c[toward] = 1; }
    else if (r < 0.90) { c[away] = 1; }
    else c.d = 1;
    this.aiT[i] = 0.20 + Math.random() * 0.34;
    return c;
  };

  Match.prototype.step = function (dt) {
    this.tick = (this.tick || 0) + 1;
    this.fx.update(dt);
    if (this.fx.hitstop > 0) { this.fx.hitstop -= dt; return; }

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
    this.a.update(dt, ca); this.b.update(dt, cb);

    this.resolve(this.a, this.b);
    this.resolve(this.b, this.a);


    // walls and body separation
    [this.a, this.b].forEach(function (f) {
      if (f.x < WALL_L) { f.x = WALL_L; f.vx = Math.max(0, f.vx); }
      if (f.x > WALL_R) { f.x = WALL_R; f.vx = Math.min(0, f.vx); }
    });
    var gap = this.b.x - this.a.x;
    if (Math.abs(gap) < 36) {
      var push = (36 - Math.abs(gap)) * 0.5 * Math.sign(gap || 1);
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
      var k = this.fx.shake * this.fx.shake * 16 * S;
      this.shakeT = (this.shakeT || 0) + 1;
      ox = Math.sin(this.shakeT * 1.9) * k * (this.fx.shakeDir || 1);
      oy = Math.sin(this.shakeT * 2.7) * k * 0.45;
    }
    /* Parallax: sky barely moves, the temple wall drifts, the floor tracks
     * the fighters exactly so their feet stay glued to it. */
    var cx = this.camX * S;
    var skyY = (GROUND - 132) * S, flrY = GROUND * S;
    surf.copyBand(this.bg, 0, skyY, ox - cx * 0.15);
    surf.copyBand(this.bg, skyY, flrY, ox - cx * 0.55);
    surf.copyBand(this.bg, flrY, surf.h, ox - cx);

    var pan = ox - cx;
    this.sh.ox = pan; this.sh.oy = oy;

    F.drawShadowAt(surf, this.a, GROUND, S, pan, oy);
    F.drawShadowAt(surf, this.b, GROUND, S, pan, oy);

    // far fighter first
    var order = this.a.y <= this.b.y ? [this.a, this.b] : [this.b, this.a];
    for (var i = 0; i < 2; i++) {
      var f = order[i];
      var b = F.fighterBounds(f);
      this.sh.begin(b.x0, b.y0, b.x1, b.y1);
      F.drawFighter(this.sh, f);
      // motion arc: the working limb's recent path, additively. Free from a
      // solved pose; a sprite sheet would need extra art for every frame.
      var tc = f.skin.tint;
      for (var g = 0; g < f.trail.length; g++) {
        var seg = f.trail[g], al = 0.055 + g * 0.032;
        surf.addStreak(seg[0][0] * S + pan, seg[0][1] * S + oy,
          seg[1][0] * S + pan, seg[1][1] * S + oy, 5 * S, tc[0], tc[1], tc[2], al * 0.5);
        surf.addStreak(seg[1][0] * S + pan, seg[1][1] * S + oy,
          seg[2][0] * S + pan, seg[2][1] * S + oy, 4.5 * S, tc[0], tc[1], tc[2], al);
      }
    }

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
  function bar(surf, x, y, w, h, frac, r, g, b, flip, ghost) {
    surf.fillRect(x - 3, y - 3, w + 6, h + 6, F.rgb(14, 12, 18));
    surf.fillRect(x - 1, y - 1, w + 2, h + 2, F.rgb(74, 66, 74));
    surf.fillRect(x, y, w, h, F.rgb(38, 32, 40));
    var gw, gx;
    if (ghost !== undefined && ghost > frac) {
      gw = Math.max(0, Math.min(1, ghost)) * w;
      gx = flip ? x + w - gw : x;
      surf.fillRect(gx, y, gw, h, F.rgb(238, 214, 120));
    }
    var fw = Math.max(0, Math.min(1, frac)) * w;
    var bx = flip ? x + w - fw : x;
    surf.fillRect(bx, y, fw, h, F.rgb(r, g, b));
    surf.fillRect(bx, y, fw, h * 0.30,
      F.rgb(Math.min(255, r + 70), Math.min(255, g + 70), Math.min(255, b + 60)));
    surf.fillRect(bx, y + h - Math.max(1, h * 0.16), fw, Math.max(1, h * 0.16),
      F.rgb(r * 0.55, g * 0.55, b * 0.55));
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
    var bw = 186 * S, bh = 13 * S, by = 14 * S;
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
    bar(surf, 20 * S, by, bw, bh, ha, ca[0], ca[1], ca[2], false, this.ghostA);
    bar(surf, w - 20 * S - bw, by, bw, bh, hb, cb2[0], cb2[1], cb2[2], true, this.ghostB);
    // super meters
    bar(surf, 20 * S, by + bh + 5 * S, bw * 0.62, 5 * S, this.a.meter / 100, 90, 190, 255, false);
    bar(surf, w - 20 * S - bw * 0.62, by + bh + 5 * S, bw * 0.62, 5 * S, this.b.meter / 100, 90, 190, 255, true);

    text(surf, this.a.name, 20 * S, by + bh + 13 * S, 1.6 * S, F.rgb(240, 226, 200), F.rgb(10, 8, 12));
    var nb = this.b.name;
    text(surf, nb, w - 20 * S - textW(nb, 1.6 * S), by + bh + 13 * S, 1.6 * S, F.rgb(240, 226, 200), F.rgb(10, 8, 12));

    // timer
    var ts = String(Math.max(0, Math.ceil(this.time)));
    if (ts.length < 2) ts = '0' + ts;
    var tp = 4 * S;
    surf.fillRect(w / 2 - 22 * S, by - 3 * S, 44 * S, 26 * S, F.rgb(18, 16, 22));
    text(surf, ts, w / 2 - textW(ts, tp) / 2, by + 1 * S, tp, F.rgb(255, 236, 190), F.rgb(20, 10, 8));

    // round pips
    for (var i = 0; i < 2; i++) {
      for (var k = 0; k < 2; k++) {
        var px = i ? w - 26 * S - k * 12 * S : 20 * S + k * 12 * S;
        var on = this.wins[i] > k;
        surf.fillRect(px, by + bh + 22 * S, 7 * S, 7 * S, on ? F.rgb(255, 206, 90) : F.rgb(58, 50, 56));
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
      text(surf, 'DEMO', w / 2 - textW('DEMO', 2 * S) / 2, surf.h - 16 * S, 2 * S,
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
    this.render();
  };

  F.Match = Match;
  F.GROUND = GROUND;
  F.WORLD = { W: W, H: H, SCALE: SCALE };
})(FX);
