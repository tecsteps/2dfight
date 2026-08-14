/*
 * fighter.js -- a fighting-game character with no animation data.
 *
 * Same principle as before, scaled up: the pose is solved every frame from
 * continuous state. What changes for a fighter is *how* moves are described.
 *
 * A punch is not a set of poses here. It is a trajectory for one hand --
 * three or four points in body-local space with timings -- and the arm is
 * solved to reach it. That has three consequences worth the trouble:
 *
 *   - moves blend. Two springs chasing two targets cross-fade for free, so
 *     cancelling a jab into a kick is continuous rather than a cut.
 *   - moves adapt. The same jab reaches further when the body is leaning in,
 *     lands lower when crouching, and tracks the opponent's height.
 *   - the body follows the limb. Hips and shoulders counter-rotate against
 *     the working arm because that is written as a rule, not drawn.
 *
 * And because nothing is ever "at rest" in a spring system, the character
 * keeps breathing, shifting weight and settling even when standing still.
 */
var FX = FX || {};
(function (F) {
  'use strict';

  var D2R = Math.PI / 180, TAU = Math.PI * 2;

  /* Proportions for a ~128px-tall fighter, roughly seven and a half heads --
   * the heroic build these games use, not a realistic one. */
  /* Seen from the side, the "width" of a torso is its front-to-back depth,
   * not the shoulder span -- an easy thing to get wrong, and it turned the
   * first build into a barrel. These are half-axes: chest 8.5 means a body
   * 17 deep. The shoulder span reads instead from how far apart the two
   * shoulder balls sit along the body's forward axis. */
  var L = {
    headRX: 7.4, headRY: 8.8, neck: 4.6,
    torso: 41,
    chestD: 7.8, waistD: 5.8, hipD: 7.2,       // half-depth, front to back
    chestH: 12.5, waistH: 10.0, hipH2: 9.2,    // half-height of each mass
    shoulderSep: 9.6, shoulderR: 8.2,
    uArm: 23, lArm: 20, hand: 4.6,
    uLeg: 32, lLeg: 29, foot: 13,
    standHip: 64
  };
  F.FighterL = L;

  function Spring(v, w) { this.v = v; this.d = 0; this.t = v; this.w = w || 14; }
  Spring.prototype.set = function (v) { this.v = this.t = v; this.d = 0; };
  Spring.prototype.step = function (dt) {
    var w = this.w, f = 1 + 2 * dt * w, ww = w * w, dtww = dt * ww;
    var det = f + dt * dtww;
    this.v = (f * this.v + dt * this.d + dtww * dt * this.t) / det;
    this.d = (this.d + dtww * (this.t - this.v)) / f;
    return this.v;
  };
  F.Spring = Spring;

  /* Two-link IK. `pole` is +1/-1 and picks which way the joint breaks. */
  function ik2(ax, ay, bx, by, l1, l2, pole) {
    var dx = bx - ax, dy = by - ay;
    var raw = Math.sqrt(dx * dx + dy * dy) || 0.0001;
    var d = raw;
    var dmin = Math.abs(l1 - l2) + 0.01, dmax = l1 + l2 - 0.01;
    if (d < dmin) d = dmin; else if (d > dmax) d = dmax;
    var ux = dx / raw, uy = dy / raw;
    var a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    var h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    return [ax + ux * a + uy * h * pole, ay + uy * a - ux * h * pole];
  }
  F.ik2 = ik2;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* ---- move definitions ---------------------------------------------
   * Each move is a duration, a set of phase markers, and a function that
   * writes targets. `p` is normalised progress. Targets are in body-local
   * space: +x forward, +y up, measured from the chest.
   */
  var MOVES = {
    idle: { dur: 0, loop: true },
    walk: { dur: 0, loop: true },
    dash: { dur: 0.34, recover: 0.1 },
    crouch: { dur: 0, loop: true },
    block: { dur: 0, loop: true },
    blockLow: { dur: 0, loop: true },
    jump: { dur: 0, loop: true },

    jab:       { dur: 0.26, hit: [0.30, 0.48], dmg: 4,  reach: 46, hy: 12,  arm: 0, push: 26, hs: 0.16 },
    cross:     { dur: 0.36, hit: [0.34, 0.54], dmg: 8,  reach: 52, hy: 10,  arm: 1, push: 46, hs: 0.24 },
    hook:      { dur: 0.42, hit: [0.40, 0.58], dmg: 10, reach: 40, hy: 14,  arm: 1, push: 54, hs: 0.28, arc: 1 },
    uppercut:  { dur: 0.50, hit: [0.36, 0.56], dmg: 13, reach: 34, hy: 26,  arm: 1, push: 40, hs: 0.34, launch: 210 },
    lowKick:   { dur: 0.40, hit: [0.34, 0.54], dmg: 7,  reach: 50, hy: -30, leg: 1, push: 40, hs: 0.22, low: 1 },
    highKick:  { dur: 0.50, hit: [0.38, 0.58], dmg: 12, reach: 56, hy: 22,  leg: 1, push: 62, hs: 0.30 },
    roundhouse:{ dur: 0.58, hit: [0.44, 0.62], dmg: 15, reach: 58, hy: 6,   leg: 1, push: 78, hs: 0.36, arc: 1, launch: 120 },
    sweep:     { dur: 0.46, hit: [0.36, 0.56], dmg: 8,  reach: 52, hy: -40, leg: 1, push: 24, hs: 0.26, low: 1, trip: 1 },

    special:   { dur: 0.90, hit: [0.40, 0.70], dmg: 26, reach: 66, hy: 8, arm: 1,
                 push: 130, hs: 0.5, launch: 260, super: 1 },

    grab:      { dur: 0.34, hit: [0.24, 0.44], grab: 1, reach: 34, hy: 6 },
    throw:     { dur: 0.85, dmg: 18 },
    thrown:    { dur: 0.85 },

    hitHigh:   { dur: 0.30, stun: 1 },
    hitLow:    { dur: 0.30, stun: 1 },
    hitHeavy:  { dur: 0.45, stun: 1 },
    knockdown: { dur: 1.25, stun: 1 },
    getup:     { dur: 0.55 },
    victory:   { dur: 0, loop: true },
    defeat:    { dur: 0, loop: true }
  };
  F.MOVES = MOVES;

  /* ---- the fighter --------------------------------------------------- */

  function Fighter(skin, opts) {
    opts = opts || {};
    this.skin = skin;
    this.name = opts.name || 'FIGHTER';
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.groundY = 0;
    this.onGround = true;

    this.hp = 100; this.maxHp = 100;
    this.meter = 0;                       // builds toward the special
    this.move = 'idle'; this.mt = 0; this.moveDone = true;
    this.hitLanded = false;
    this.stun = 0;
    this.flash = 0;
    this.blocking = false;
    this.combo = 0;

    // gait
    this.phase = 0; this.cadence = 0;
    this.feet = [
      { planted: true, wx: -8, wy: 0, liftX: 0, angle: 0 },
      { planted: true, wx: 8, wy: 0, liftX: 0, angle: 0 }
    ];
    this.stride = 44; this.duty = 0.62; this.lift = 8;

    // posture
    this.hipH = new Spring(L.standHip, 15);
    this.lean = new Spring(0, 11);           // degrees, + = forward
    this.twist = new Spring(0, 13);          // shoulder counter-rotation
    this.headA = new Spring(0, 9);
    this.crouchS = new Spring(0, 16);
    this.hipShift = new Spring(0, 7);        // weight on which foot

    // hands live as sprung points in body-local space
    this.hand = [
      { x: new Spring(9, 16), y: new Spring(-2, 16) },   // rear
      { x: new Spring(14, 16), y: new Spring(3, 16) }    // lead
    ];
    // a kicking foot gets its own local target while it is off the ground
    this.kick = { on: 0, x: new Spring(0, 18), y: new Spring(0, 18), leg: 1 };

    // always-on life
    this.breath = Math.random() * TAU;
    this.sway = Math.random() * TAU;
    this.blink = 1.5 + Math.random() * 3;
    this.blinkT = 0;

    // secondary motion
    this.hair = [];
    for (var i = 0; i < 4; i++) this.hair.push({ x: 0, y: 0, vx: 0, vy: 0 });
    this.belt = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 0, y: 0, vx: 0, vy: 0 }];
    this.trail = [];
  }

  Fighter.prototype.setGround = function (y) { this.groundY = y; };

  Fighter.prototype.place = function (x, y, facing) {
    this.x = x; this.y = y; this.groundY = y; this.facing = facing || 1;
    this.feet[0].wx = x - 9; this.feet[1].wx = x + 9;
    this.feet[0].wy = this.feet[1].wy = y;
    this.hipH.set(L.standHip);
    var c = this.chest();
    for (var i = 0; i < this.hair.length; i++) { this.hair[i].x = c[0]; this.hair[i].y = c[1]; }
    for (var j = 0; j < this.belt.length; j++) { this.belt[j].x = c[0]; this.belt[j].y = c[1]; }
  };

  Fighter.prototype.chest = function () {
    var hipY = this.y - this.hipH.v;
    var a = (-90 + this.lean.v * this.facing) * D2R;
    return [this.x + Math.cos(a) * L.torso * 0.72, hipY + Math.sin(a) * L.torso * 0.72];
  };

  Fighter.prototype.def = function () { return MOVES[this.move] || MOVES.idle; };
  Fighter.prototype.progress = function () {
    var d = this.def();
    return d.dur > 0 ? clamp01(this.mt / d.dur) : 0;
  };

  Fighter.prototype.start = function (name) {
    if (!MOVES[name]) return;
    this.move = name; this.mt = 0; this.moveDone = false; this.hitLanded = false;
  };

  Fighter.prototype.busy = function () {
    var d = this.def();
    return d.dur > 0 && !this.moveDone;
  };

  Fighter.prototype.canAct = function () {
    return this.stun <= 0 && !this.busy();
  };

  /* ---- update -------------------------------------------------------- */

  Fighter.prototype.update = function (dt, cmd) {
    cmd = cmd || {};
    var d = this.def();

    this.breath += dt * (1.55 + (1 - this.hp / this.maxHp) * 1.5);
    this.sway += dt * 0.62;
    this.blinkT += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 14);
    if (this.stun > 0) this.stun = Math.max(0, this.stun - dt);

    if (d.dur > 0) {
      this.mt += dt;
      if (this.mt >= d.dur) { this.moveDone = true; }
    }

    // gravity and ground
    if (!this.onGround) {
      this.vy += 780 * dt;
      this.y += this.vy * dt;
      if (this.y >= this.groundY) {
        this.y = this.groundY; this.vy = 0; this.onGround = true;
        if (this.onLand) this.onLand();
      }
    }
    this.x += this.vx * dt;
    if (this.onGround) this.vx *= Math.pow(0.0009, dt);   // friction

    this.posture(dt, cmd);
    this.arms(dt, cmd);
    this.legs(dt, cmd);
    this.secondary(dt);

    this.hipH.step(dt); this.lean.step(dt); this.twist.step(dt);
    this.headA.step(dt); this.crouchS.step(dt); this.hipShift.step(dt);
    this.hand[0].x.step(dt); this.hand[0].y.step(dt);
    this.hand[1].x.step(dt); this.hand[1].y.step(dt);
    this.kick.x.step(dt); this.kick.y.step(dt);
  };

  Fighter.prototype.posture = function (dt, cmd) {
    var m = this.move, p = this.progress(), d = this.def();
    var br = Math.sin(this.breath);                 // -1..1, always running
    var crouching = (m === 'crouch' || m === 'blockLow' || m === 'sweep');

    this.crouchS.t = crouching ? 1 : 0;

    // breathing lifts the chest and rocks the shoulders a little
    var hip = L.standHip - 22 * this.crouchS.v + br * 0.9;
    if (!this.onGround) hip = L.standHip - 6;
    this.hipH.t = hip;

    var lean = 4 + br * 1.2;
    if (m === 'walk') lean = 8;
    if (m === 'dash') lean = 16;
    if (crouching) lean = 16;
    if (m === 'block' || m === 'blockLow') lean = -3;
    if (d.arm || d.leg) lean = 6 + 16 * Math.sin(Math.PI * p);
    if (m === 'hitHigh' || m === 'hitHeavy') lean = -18 * Math.sin(Math.PI * p);
    if (m === 'hitLow') lean = 20 * Math.sin(Math.PI * p);
    if (m === 'knockdown') lean = -70 * smooth(clamp01(p * 2));
    if (m === 'defeat') lean = -60;
    if (m === 'victory') lean = -4 + br * 2;
    this.lean.t = lean;

    // shoulders counter-rotate against whichever limb is working
    var tw = br * 2.5;
    if (d.arm !== undefined) tw = (d.arm ? -1 : 1) * 22 * Math.sin(Math.PI * p);
    if (d.leg) tw = 26 * Math.sin(Math.PI * p);
    if (m === 'walk' || m === 'dash') tw = Math.sin(this.phase * TAU) * 9;
    this.twist.t = tw;

    this.headA.t = (m === 'knockdown' || m === 'defeat') ? 26 : -br * 2.2 - this.lean.v * 0.25;

    // idle weight shift: a slow drift from one foot to the other
    this.hipShift.t = (m === 'idle' || m === 'block') ? Math.sin(this.sway) * 2.4 : 0;
  };

  /* Hand targets in body-local space. Every move writes here; the springs
   * and the IK do the rest. */
  Fighter.prototype.arms = function (dt, cmd) {
    var m = this.move, p = this.progress(), d = this.def();
    var br = Math.sin(this.breath), br2 = Math.sin(this.breath * 2);
    // guard stance: lead hand up and forward, rear hand by the chin
    var g = [[8 + br * 0.9, 7 + br2 * 0.8], [17 + br * 1.2, 11 + br2 * 0.9]];

    if (m === 'block') { g = [[11, 14], [16, 16]]; }
    else if (m === 'blockLow') { g = [[9, -2], [13, 1]]; }
    else if (m === 'crouch') { g = [[6, -4], [12, -1]]; }
    else if (m === 'walk') { g = [[7 + Math.sin(this.phase * TAU) * 3, 1], [16, 5]]; }
    else if (m === 'jump') { g = [[2, 12], [10, 14]]; }
    else if (m === 'hitHigh' || m === 'hitHeavy') {
      var k = Math.sin(Math.PI * p);
      g = [[7 - 9 * k, 1 + 10 * k], [14 - 12 * k, 5 + 12 * k]];
    } else if (m === 'hitLow') { g = [[6, -6], [12, -3]]; }
    else if (m === 'knockdown' || m === 'defeat') { g = [[-6, -8], [2, -12]]; }
    else if (m === 'victory') { g = [[4, 20 + br * 2], [10, 24 + br * 2]]; }
    else if (m === 'grab') {
      var e = Math.sin(Math.PI * clamp01(p * 1.3));
      g = [[7 + 22 * e, 1 + 4 * e], [16 + 20 * e, 5 + 2 * e]];
    } else if (m === 'throw') {
      var tp = smooth(p);
      g = [[8 + 16 * Math.sin(Math.PI * tp), 4 + 22 * tp], [16 + 14 * Math.sin(Math.PI * tp), 8 + 20 * tp]];
    } else if (d.arm !== undefined) {
      /* A strike: the working hand runs out to reach and back. `arc` swings
       * it wide instead of straight, which is what separates a hook from a
       * cross without a second animation. */
      var i = d.arm;
      var ex = p < 0.45 ? smooth(p / 0.45) : 1 - smooth((p - 0.45) / 0.55);
      var reach = d.reach, hy = d.hy;
      var hx2 = 8 + (reach - 8) * ex;
      var hy2 = 7 + (hy - 7) * ex;
      if (d.arc) {
        var a = Math.PI * (0.85 - 1.1 * p);
        hx2 = 8 + reach * 0.86 * ex * Math.sin(a + 0.6);
        hy2 = 7 + (hy - 7) * ex + Math.cos(a) * 14 * ex;
      }
      if (m === 'uppercut') { hy2 = 7 + (hy + 14) * ex; hx2 = 8 + (reach - 8) * ex * 0.8; }
      g = [[8, 7], [17, 11]];
      g[i] = [hx2, hy2];
      // the other hand pulls back as a counterweight
      g[1 - i] = [g[1 - i][0] - 8 * ex, g[1 - i][1] + 2 * ex];
    }

    for (var h = 0; h < 2; h++) {
      var stiff = (d.arm !== undefined && h === d.arm) ? 42 : 16;
      this.hand[h].x.w = stiff; this.hand[h].y.w = stiff;
      this.hand[h].x.t = g[h][0];
      this.hand[h].y.t = g[h][1];
    }
  };

  Fighter.prototype.legs = function (dt, cmd) {
    var m = this.move, p = this.progress(), d = this.def();
    var speed = Math.abs(this.vx);

    // kicking foot target
    if (d.leg) {
      var ex = p < 0.45 ? smooth(p / 0.45) : 1 - smooth((p - 0.45) / 0.55);
      var kx = 4 + (d.reach - 4) * ex;
      var ky = -34 + (d.hy + 34) * ex;
      if (d.arc) {
        var a = Math.PI * (0.75 - 0.95 * p);
        kx = 4 + d.reach * 0.9 * ex * Math.sin(a + 0.7);
        ky = d.hy * ex + Math.cos(a) * 16 * ex;
      }
      this.kick.on = 1; this.kick.leg = 1;
      this.kick.x.w = 40; this.kick.y.w = 40;
      this.kick.x.t = kx; this.kick.y.t = ky;
    } else {
      this.kick.on = 0;
      this.kick.x.t = 4; this.kick.y.t = -34;
    }

    var gy = this.groundY;

    if (!this.onGround) {
      for (var a2 = 0; a2 < 2; a2++) {
        var ff = this.feet[a2];
        ff.planted = false;
        var tuck = Math.max(0, Math.min(1, -this.vy / 260));
        var tx = this.x + this.facing * (a2 ? 9 : -5) - this.facing * 5 * tuck;
        ff.wx += (tx - ff.wx) * Math.min(1, dt * 13);
        ff.wy += ((gy - 16 - 16 * tuck) - ff.wy) * Math.min(1, dt * 11);
        ff.angle += (-26 - ff.angle) * Math.min(1, dt * 9);
      }
      return;
    }

    var moving = (m === 'walk' || m === 'dash') && speed > 4;
    if (moving) {
      var walkRun = Math.min(1, speed / 150);
      this.stride = 34 + 26 * walkRun;
      this.duty = 0.64 - 0.2 * walkRun;
      this.lift = 5 + 7 * walkRun;
      this.cadence = speed / this.stride;
      this.phase = (this.phase + this.cadence * dt) % 1;
      for (var i = 0; i < 2; i++) {
        var f = this.feet[i];
        var ph = (this.phase + i * 0.5) % 1;
        if (ph < this.duty) {
          if (!f.planted) { f.planted = true; f.wy = gy; }
          f.angle += ((ph / this.duty < 0.25 ? 10 : ph / this.duty > 0.78 ? -26 : 0) - f.angle) * Math.min(1, dt * 16);
        } else {
          if (f.planted) { f.planted = false; f.liftX = f.wx; }
          var u = (ph - this.duty) / (1 - this.duty);
          var st = (1 - this.duty) / Math.max(0.001, this.cadence);
          var land = this.x + this.vx * st * (1 - u) + Math.sign(this.vx) * this.stride * 0.30;
          f.wx = f.liftX + (land - f.liftX) * smooth(u);
          f.wy = gy - Math.sin(Math.PI * u) * this.lift;
          f.angle += ((u < 0.5 ? -24 + 48 * u : 14) - f.angle) * Math.min(1, dt * 14);
        }
      }
      return;
    }

    /* Standing: a fighting stance, lead foot forward, rear foot turned out.
     * The stance drifts with the weight shift so he is never truly still. */
    var lead = this.facing, back = -this.facing;
    var shift = this.hipShift.v;
    var stanceW = 15 + 7 * this.crouchS.v;
    var want = [this.x + back * stanceW * 0.85 - shift, this.x + lead * stanceW + shift * 0.6];
    if (this.kick.on) {
      // planted foot takes all the weight and slides under the body
      want[1] = this.x + lead * 2;
      want[0] = this.x - lead * 5;
    }
    if (m === 'knockdown' || m === 'defeat') {
      want = [this.x - lead * 26, this.x - lead * 6];
    }
    for (var s = 0; s < 2; s++) {
      var fs = this.feet[s];
      fs.planted = true;
      var rate = (m === 'dash' || this.kick.on) ? 18 : 7;
      fs.wx += (want[s] - fs.wx) * Math.min(1, dt * rate);
      fs.wy += (gy - fs.wy) * Math.min(1, dt * 14);
      fs.angle += ((s === 0 ? -12 : 4) - fs.angle) * Math.min(1, dt * 7);
    }
  };

  /* Hair and belt tails: verlet points chasing an anchor. Free follow-through
   * on every movement, and the main reason the character reads as alive. */
  Fighter.prototype.secondary = function (dt) {
    var c = this.chest();
    var hipY = this.y - this.hipH.v;
    var pp = this.pose();
    var hb = (pp.headA + 90 * this.facing) * D2R;
    var ax = pp.headC[0] - Math.cos(hb) * L.headRX * 0.85;
    var ay = pp.headC[1] - Math.sin(hb) * L.headRX * 0.85 + 1.5;
    var seg = 5.2;
    for (var i = 0; i < this.hair.length; i++) {
      var h = this.hair[i];
      h.vy += 620 * dt;
      h.vx *= 0.90; h.vy *= 0.90;
      h.x += h.vx * dt; h.y += h.vy * dt;
      var px = i === 0 ? ax : this.hair[i - 1].x;
      var py = i === 0 ? ay : this.hair[i - 1].y;
      var dx = h.x - px, dy = h.y - py;
      var d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      var k = (d - seg) / d;
      h.x -= dx * k; h.y -= dy * k;
      h.vx += (-dx * k) / Math.max(dt, 0.0001) * 0.30;
      h.vy += (-dy * k) / Math.max(dt, 0.0001) * 0.30;
    }
    var bx = this.x - this.facing * 3, by = hipY + 3;
    for (var j = 0; j < this.belt.length; j++) {
      var b = this.belt[j];
      b.vy += 700 * dt;
      b.vx *= 0.88; b.vy *= 0.88;
      b.x += b.vx * dt; b.y += b.vy * dt;
      var qx = j === 0 ? bx : this.belt[j - 1].x;
      var qy = j === 0 ? by : this.belt[j - 1].y;
      var ex = b.x - qx, ey = b.y - qy;
      var e = Math.sqrt(ex * ex + ey * ey) || 0.0001;
      var kk = (e - 9) / e;
      b.x -= ex * kk; b.y -= ey * kk;
      b.vx += (-ex * kk) / Math.max(dt, 0.0001) * 0.30;
      b.vy += (-ey * kk) / Math.max(dt, 0.0001) * 0.30;
    }
  };

  /* ---- solved skeleton ------------------------------------------------ */

  Fighter.prototype.pose = function () {
    var fw = this.facing;
    var hipY = this.y - this.hipH.v;
    var hipX = this.x + this.hipShift.v * 0.35 * fw;
    var leanA = -90 + this.lean.v * fw;
    var la = leanA * D2R;
    var ux = Math.cos(la), uy = Math.sin(la);          // hip -> shoulders
    var neck = [hipX + ux * L.torso, hipY + uy * L.torso];
    var chest = [hipX + ux * L.torso * 0.72, hipY + uy * L.torso * 0.72];
    var waist = [hipX + ux * L.torso * 0.34, hipY + uy * L.torso * 0.34];

    // shoulder line, rotated by the torso twist
    var tw = this.twist.v * D2R * fw;
    var sx = -uy, sy = ux;                              // perpendicular
    var sw = L.shoulderSep;
    var twc = Math.cos(tw), tws = Math.sin(tw);
    var offx = (sx * twc - ux * tws) * sw, offy = (sy * twc - uy * tws) * sw;
    var shR = [neck[0] - offx + ux * -3, neck[1] - offy + uy * -3];
    var shL = [neck[0] + offx + ux * -3, neck[1] + offy + uy * -3];
    // near shoulder is the one on the viewer's side
    var shoulders = [shR, shL];

    var headA = leanA + this.headA.v * fw;
    var ha = headA * D2R;
    var headBase = [neck[0] + Math.cos(ha) * L.neck, neck[1] + Math.sin(ha) * L.neck];
    var headC = [headBase[0] + Math.cos(ha) * L.headRY * 0.86,
      headBase[1] + Math.sin(ha) * L.headRY * 0.86];

    // hands: body-local -> world
    var hands = [], arms = [];
    for (var i = 0; i < 2; i++) {
      var lx = this.hand[i].x.v, ly = this.hand[i].y.v;
      var hx = chest[0] + fw * lx, hy = chest[1] - ly;
      var pole = (i === 0 ? 1 : 1) * fw;
      var elbow = ik2(shoulders[i][0], shoulders[i][1], hx, hy, L.uArm, L.lArm, -pole);
      hands.push([hx, hy]);
      arms.push({ sh: shoulders[i], elbow: elbow, wrist: [hx, hy] });
    }

    // legs
    var legs = [];
    for (var j = 0; j < 2; j++) {
      var hxp = hipX + (j ? 1 : -1) * fw * L.hipD * 0.40;
      var ax, ay, angle;
      if (this.kick.on && j === 1) {
        ax = chest[0] + fw * this.kick.x.v;
        ay = chest[1] - this.kick.y.v;
        angle = this.def().low ? 8 : -4;
      } else {
        ax = this.feet[j].wx; ay = this.feet[j].wy - 4;
        angle = this.feet[j].angle;
      }
      var rdx = ax - hxp, rdy = ay - hipY;
      var rd = Math.sqrt(rdx * rdx + rdy * rdy), reach = L.uLeg + L.lLeg - 1;
      if (rd > reach) { ax = hxp + rdx / rd * reach; ay = hipY + rdy / rd * reach; }
      var knee = ik2(hxp, hipY, ax, ay, L.uLeg, L.lLeg, -fw);
      legs.push({ hip: [hxp, hipY], knee: knee, ankle: [ax, ay], angle: angle });
    }

    return {
      fw: fw, hip: [hipX, hipY], waist: waist, chest: chest, neck: neck,
      headC: headC, headA: headA, leanA: leanA,
      shoulders: shoulders, arms: arms, hands: hands, legs: legs
    };
  };

  F.Fighter = Fighter;
})(FX);
