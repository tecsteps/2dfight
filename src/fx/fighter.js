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
    /* Half-depth, front to back. The old set went 7.8 / 5.8 / 7.2 -- widest
     * at the chest, narrowest at the waist, wide again at the hips -- which
     * is an hourglass, and combined with a smooth unbroken chest mass both
     * fighters read unmistakably as women in a white gi. A male martial
     * artist tapers: broad chest, narrower waist, narrower hips still. */
    chestD: 8.6, waistD: 6.6, hipD: 6.8,
    chestH: 11.4, waistH: 10.0, hipH2: 9.2,    // half-height of each mass
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
    /* Never let a joint reach full extension. At dmax = l1 + l2 the two
     * segments go exactly collinear and the elbow or knee vanishes from the
     * silhouette entirely -- an extended punch became one straight tube. A
     * six-percent limit leaves about twelve degrees of flexion, which is
     * both what a real joint does under load and enough to put a visible
     * notch in the outline. */
    var dmin = Math.abs(l1 - l2) + 0.01, dmax = (l1 + l2) * 0.94;
    if (d < dmin) d = dmin; else if (d > dmax) d = dmax;
    var ux = dx / raw, uy = dy / raw;
    var a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    var h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    return [ax + ux * a + uy * h * pole, ay + uy * a - ux * h * pole];
  }
  F.ik2 = ik2;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function smooth(t) { return t * t * (3 - 2 * t); }

  /* The strike envelope: anticipate, snap, HOLD, drag back.
   *
   * The first version was a symmetric bell -- ease out to a peak, ease back.
   * Measured, that peaked at p~0.6, after the move's own hit window had
   * already closed, and reached only ~84% of the authored extension because
   * the limb spring could not catch a target that was already retreating.
   * So the hitstop freeze landed on a half-extended arm and nothing read as
   * a blow. A fighting game wants a plateau: the limb arrives early, locks
   * out, and *stays* there through the active frames. */
  function strikeEnv(p) {
    return p < 0.14 ? -0.20 * smooth(p / 0.14)
      : p < 0.34 ? -0.20 + 1.20 * smooth((p - 0.14) / 0.20)
        : p < 0.58 ? 1
          : 1 - smooth((p - 0.58) / 0.42);
  }
  F.strikeEnv = strikeEnv;

  /* ---- move definitions ---------------------------------------------
   * Each move is a duration, a set of phase markers, and a function that
   * writes targets. `p` is normalised progress. Targets are in body-local
   * space: +x forward, +y up, measured from the chest.
   */
  var MOVES = {
    idle: { dur: 0, loop: true },
    walk: { dur: 0, loop: true },
    dash:      { dur: 0.24 },
    backdash:  { dur: 0.30, inv: [0, 0.45] },
    crouch: { dur: 0, loop: true },
    block: { dur: 0, loop: true },
    blockLow: { dur: 0, loop: true },
    jump: { dur: 0, loop: true },

    /* Startup, active and recovery all fall out of `dur` and the `hit`
     * window. Recovery used to equal startup on every move, so a 15-damage
     * launcher was exactly as safe as a jab -- there was no reason to ever
     * throw anything but the heaviest option. The heavies now carry their
     * cost: the same active frames sit earlier in a longer move. */
    /* Two things are true of every window here now.
     *
     * First, the active frames sit on the plateau. strikeEnv holds full
     * extension from p = 0.34 to 0.58, and every window used to open on the
     * rising edge -- an air kick went active with the leg 23% extended, and
     * the first frames of every heavy landed at two-thirds reach.
     *
     * Second, the reach numbers are honest. A leg is 60 units from the hip,
     * so a head-height kick physically cannot travel 66 forward -- the
     * authored figure was clamped away and the real reach was 46, which is
     * how a 14-frame jab came to out-range a 37-frame roundhouse. The kicks
     * are lower and longer; the punches are authored at what an arm reaches. */
    jab:       { dur: 0.24, hit: [0.34, 0.56], dmg: 4,  reach: 46, hy: 12,  arm: 0, push: 52,  hs: 0.16 },
    cross:     { dur: 0.36, hit: [0.34, 0.56], dmg: 8,  reach: 50, hy: 10,  arm: 1, push: 132, hs: 0.24 },
    hook:      { dur: 0.46, hit: [0.34, 0.56], dmg: 10, reach: 44, hy: 14,  arm: 1, push: 155, hs: 0.28, arc: 1 },
    uppercut:  { dur: 0.56, hit: [0.34, 0.56], dmg: 13, reach: 38, hy: 36,  arm: 1, push: 120, hs: 0.34, launch: 490 },
    lowKick:   { dur: 0.34, hit: [0.34, 0.56], dmg: 7,  reach: 56, hy: -30, leg: 1, push: 96,  hs: 0.22, low: 1 },
    highKick:  { dur: 0.50, hit: [0.34, 0.56], dmg: 12, reach: 60, hy: 8,   leg: 1, push: 190, hs: 0.30 },
    roundhouse:{ dur: 0.62, hit: [0.34, 0.56], dmg: 15, reach: 62, hy: 4,   leg: 1, push: 300, hs: 0.36, arc: 1.6, launch: 380 },
    sweep:     { dur: 0.50, hit: [0.34, 0.56], dmg: 8,  reach: 56, hy: -40, leg: 1, push: 90,  hs: 0.26, low: 1, trip: 1 },

    /* Air normals. Without them there is no jump-in, no air-to-air and no
     * cross-up -- roughly half the neutral game of any commercial fighter
     * was missing because every attack branch sat behind an onGround test. */
    airPunch:  { dur: 0.34, hit: [0.34, 0.70], dmg: 7,  reach: 46, hy: -6, arm: 1, push: 90,  hs: 0.24, air: 1 },
    airKick:   { dur: 0.40, hit: [0.34, 0.70], dmg: 11, reach: 56, hy: -18, leg: 1, push: 150, hs: 0.30, air: 1 },

    special:   { dur: 0.80, hit: [0.34, 0.58], dmg: 26, reach: 58, hy: 8, arm: 1,
                 push: 560, hs: 0.5, launch: 560, super: 1 },

    /* The grab reached 43 units and the two bodies were held 44 apart, so
     * it missed by one unit, always -- about a 4% connect rate, entirely on
     * frames where knockback happened to close the gap. */
    grab:      { dur: 0.34, hit: [0.20, 0.52], grab: 1, reach: 50, hy: 6 },
    throw:     { dur: 0.85, dmg: 18 },
    thrown:    { dur: 0.85 },

    hitHigh:   { dur: 0.30, stun: 1 },
    hitLow:    { dur: 0.30, stun: 1 },
    hitHeavy:  { dur: 0.45, stun: 1 },
    knockdown: { dur: 1.25, stun: 1 },
    // wake-up is invulnerable while getting up, then not -- whole-move
    // invulnerability makes okizeme impossible by construction
    getup:     { dur: 0.55, inv: [0, 0.42] },
    victory:   { dur: 0, loop: true },
    defeat:    { dur: 0, loop: true }
  };
  F.MOVES = MOVES;

  /* Where the working limb actually is, in world coordinates.
   *
   * Hit detection used to run off the authored `reach` number, which several
   * moves never physically achieve -- a roundhouse claimed 87 units of range
   * against a foot that reached 48, so blows landed with a visible gap. The
   * drawn pose is the truth; this reads it. */
  /* Distance from a point to a fighter's body, approximated as three
   * capsules along the solved skeleton: head, torso, legs. Hit detection
   * used a whole-body vertical band, which let an uppercut connect with the
   * fist half a body height above the opponent's crown. */
  function segDist(px, py, ax, ay, bx, by) {
    var ex = bx - ax, ey = by - ay;
    var l2 = ex * ex + ey * ey;
    var t = l2 > 1e-6 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var qx = px - (ax + ex * t), qy = py - (ay + ey * t);
    return Math.sqrt(qx * qx + qy * qy);
  }
  F.tipToBody = function (tip, f) {
    var p = f.pose();
    var lo = p.legs[0].ankle[1] > p.legs[1].ankle[1] ? p.legs[0].ankle : p.legs[1].ankle;
    var d1 = segDist(tip[0], tip[1], p.headC[0], p.headC[1], p.neck[0], p.neck[1]) - 8;
    var d2 = segDist(tip[0], tip[1], p.neck[0], p.neck[1], p.hip[0], p.hip[1]) - 11;
    var d3 = segDist(tip[0], tip[1], p.hip[0], p.hip[1], lo[0], lo[1]) - 8;
    return Math.min(d1, Math.min(d2, d3));
  };

  F.limbTip = function (f) {
    var d = f.def(), p = f.pose();
    if (d.leg) return p.legs[1].ankle;
    if (d.arm !== undefined) return p.arms[d.arm].wrist;
    return p.arms[1].wrist;
  };

  /* ---- the fighter --------------------------------------------------- */

  function Fighter(skin, opts) {
    opts = opts || {};
    this.skin = skin;
    this.name = opts.name || 'FIGHTER';
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.groundY = 0;
    this.onGround = true;
    this.launched = 0; this.juggle = 0;

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
    this.crouchS = new Spring(0, 34);
    this.hipShift = new Spring(0, 7);        // weight on which foot

    // hands live as sprung points in body-local space
    this.hand = [
      { x: new Spring(9, 16), y: new Spring(-2, 16) },   // rear
      { x: new Spring(14, 16), y: new Spring(3, 16) }    // lead
    ];
    // a kicking foot gets its own local target while it is off the ground
    this.kick = { on: 0, x: new Spring(0, 18), y: new Spring(0, 18), leg: 1 };
    // how far the kicking ankle has left the floor for its target, 0..1
    this.kickB = new Spring(0, 26);

    // always-on life
    this.breath = Math.random() * TAU;
    this.sway = Math.random() * TAU;
    this.blink = 1.5 + Math.random() * 3;
    this.blinkT = 0;

    // secondary motion
    /* Hairstyle is per-character: the number of verlet points, how far apart
     * they sit and how thick they are drawn. One shared four-point chain of
     * fat segments gave both fighters the same heavy ponytail, and at this
     * resolution it read as a blob rather than hair. */
    this.hairStyle = (skin && skin.hairStyle) || { n: 3, seg: 3.6, r0: 3.4, taper: 0.8,
      back: 0.78, up: 1.4, grav: 620 };
    this.hair = [];
    for (var i = 0; i < this.hairStyle.n; i++) this.hair.push({ x: 0, y: 0, vx: 0, vy: 0 });
    /* Gi hem. Two points -- one in front of the legs, one behind -- hanging
     * off the belt. Without them the lower body is two bare tubes, and a
     * loose garment is most of what a gi's silhouette actually is. They also
     * lag the body, so a dash or a landing flares the cloth for free. */
    this.hem = [{ x: 0, y: 0, vx: 0, vy: 0 }, { x: 0, y: 0, vx: 0, vy: 0 }];
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
    for (var j = 0; j < this.hem.length; j++) {
      this.hem[j].x = this.x; this.hem[j].y = this.y - 30;
      this.hem[j].vx = this.hem[j].vy = 0;
    }
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

    this.breath += dt * (4.4 + (1 - this.hp / this.maxHp) * 2.2);
    this.sway += dt * 2.6;
    this.blinkT += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 14);
    if (this.stun > 0) this.stun = Math.max(0, this.stun - dt);

    if (d.dur > 0) {
      this.mt += dt;
      if (this.mt >= d.dur) { this.moveDone = true; }
    }

    // gravity and ground
    if (!this.onGround) {
      this.vy += 1500 * dt;
      this.y += this.vy * dt;
      /* Ceiling, so a juggle cannot carry anyone out of frame. It applies
       * only to fighters who were put in the air by a hit -- clamping a
       * voluntary jump stopped it dead at 72% of its natural apex, mid-rise,
       * with 300 units/s still on the clock. */
      var ceil = this.launched
        ? (this.ceilY !== undefined ? this.ceilY : this.groundY - 132)
        : this.groundY - 88;
      if (this.y < ceil) { this.y = ceil; if (this.vy < 0) this.vy = 0; }
      if (this.y >= this.groundY) {
        /* Capture the impact velocity and drive it into the hip spring, so
         * the body compresses and rises back over ~20 frames. Previously the
         * hip actually rose on landing and the character read as a decal. */
        var iv = this.vy;
        this.y = this.groundY; this.vy = 0; this.onGround = true;
        this.launched = 0; this.juggle = 0;   // landing ends a juggle chain
        this.hipH.v -= Math.min(20, iv * 0.045); this.hipH.d = 0;
        this.lean.v += Math.min(14, iv * 0.03);
        this.landV = iv;
        if (this.onLand) this.onLand();
      }
    }
    this.x += this.vx * dt;
    if (this.onGround) this.vx *= Math.pow(0.0009, dt);   // friction

    this.posture(dt, cmd);
    this.arms(dt, cmd);
    this.legs(dt, cmd);
    this.secondary(dt);

    /* Afterimage history. A sprite-based fighter cannot do this without
     * extra art; a solved pose is just numbers, so keeping the last few is
     * nearly free. */
    var dd = this.def();
    var pr = this.progress();
    if ((dd.arm !== undefined || dd.leg) && pr > 0.18 && pr < 0.74) {
      var q = this.pose();
      var ch = dd.leg ? q.legs[1] : q.arms[dd.arm];
      this.trail.push(dd.leg
        ? [ch.hip, ch.knee, ch.ankle]
        : [ch.sh, ch.elbow, ch.wrist]);
      if (this.trail.length > 5) this.trail.shift();
    } else if (this.trail.length) {
      this.trail.shift();
    }

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

    /* Lean first, then hip. The previous version assigned hipH.t before the
     * knockdown and defeat branches had set `hip`, so a downed fighter never
     * actually fell -- it bowed at the waist with its legs straight. */
    var lean = 4 + br * 1.2;
    var tw0 = 0;
    if (m === 'walk') lean = 8;
    if (m === 'dash' || m === 'backdash') lean = m === 'dash' ? 18 : -14;
    if (crouching) lean = 27;
    if (m === 'block' || m === 'blockLow') { lean = -3; tw0 = -16; }
    /* A kick throws the leg forward, so the torso has to go back or the
      * centre of mass leaves the support foot entirely. It used to lean
      * *into* a head-height kick. */
    if (d.arm !== undefined) lean = 6 + 18 * strikeEnv(p);
    else if (d.leg) lean = 6 - 26 * strikeEnv(p);
    if (m === 'hitHigh' || m === 'hitHeavy') lean = -22 * Math.sin(Math.PI * p);
    if (m === 'hitLow') lean = 22 * Math.sin(Math.PI * p);
    if (m === 'victory') lean = -4 + br * 2;

    // breathing lifts the chest and rocks the shoulders
    /* Hip height. The bob used to come entirely from the 0.7 Hz breath
     * sine, which is unrelated to the 2 Hz step cadence -- so while walking
     * the torso floated over the legs instead of dropping onto each one. */
    var hip = L.standHip - 34 * this.crouchS.v + br * 3.4;
    if ((m === 'walk' || m === 'dash') && Math.abs(this.vx) > 4) {
      hip -= 2.8 * Math.abs(Math.sin(this.phase * TAU));
    }
    if (m === 'sweep') hip = L.standHip - 36 * Math.sin(Math.PI * p);
    if (!this.onGround) hip = L.standHip - 15;

    /* Going down: the torso rotates flat AND the pelvis drops to the floor.
     * Both, or it reads as a bow. */
    if (m === 'knockdown') {
      var kp = smooth(clamp01((p - 0.10) / 0.34));
      lean = -92 * kp;
      hip = L.standHip * (1 - 0.86 * kp) + 4;
      if (!this.kdHit && kp > 0.72) { this.kdHit = 1; if (this.onFloorHit) this.onFloorHit(); }
      // (onFloorHit is assigned by the match, next to onLand)
      if (kp < 0.1) this.kdHit = 0;
    }
    if (m === 'thrown') {
      lean = -70 * smooth(clamp01(p * 2.2));
      hip = L.standHip * (1 - 0.5 * smooth(clamp01(p * 2.2)));
    }
    if (m === 'defeat') { lean = -94; hip = 10; }
    if (m === 'getup') {
      var gp = smooth(p);
      lean = -92 * (1 - gp) + 6 * gp;
      hip = 10 + (L.standHip - 10) * gp;
    }

    this.lean.t = lean;
    this.hipH.t = hip;

    // shoulders counter-rotate against whichever limb is working
    var tw = br * 2.5;
    if (d.arm !== undefined) tw = (d.arm ? -1 : 1) * 40 * strikeEnv(p);
    if (d.leg) tw = 42 * strikeEnv(p);
    if (m === 'walk' || m === 'dash') tw = Math.sin(this.phase * TAU) * 9;
    this.twist.t = tw + tw0;

    this.headA.t = (m === 'knockdown' || m === 'defeat') ? 30 : -br * 2.2 - this.lean.v * 0.25;

    /* The weight shift used to switch off during every attack, so the
     * character became *more* static the moment it acted. */
    this.hipShift.t = Math.sin(this.sway) * ((m === 'idle' || m === 'block') ? 5.5 : 2.0);

    // a periodic shoulder roll: real idles are not pure sinusoids
    var beat = (this.breath * 0.23) % (Math.PI * 2);
    if (beat < 0.9) {
      var bk = Math.sin(beat / 0.9 * Math.PI);
      this.twist.t += 5 * bk;
      this.headA.t += 3 * bk;
    }
  };

  /* Hand targets in body-local space. Every move writes here; the springs
   * and the IK do the rest. */
  Fighter.prototype.arms = function (dt, cmd) {
    var m = this.move, p = this.progress(), d = this.def();
    var br = Math.sin(this.breath), br2 = Math.sin(this.breath * 2);
    // guard stance: lead hand up and forward, rear hand by the chin
    var brA = Math.sin(this.breath + 0.6);
    /* Guard. The lead fist used to sit at head height and only 17 forward,
     * which put it squarely on the character's own jaw -- twenty-five head
     * primitives rendered and then covered by a skin-coloured ball. The
     * hands now sit at sternum height and well in front of the face. */
    var g = [[9 + br * 2.2, 1 + br2 * 1.8], [21 + brA * 2.6, 6 + br2 * 2.0]];

    // Block: both forearms stacked vertically in front of the chest and
    // face. The old target swung the elbow up and behind, so the arm arced
    // over the crown and the pose read as a stretch, not a guard.
    if (m === 'block') { g = [[17, 11], [13, 5]]; }
    else if (m === 'blockLow') { g = [[9, -2], [13, 1]]; }
    else if (m === 'crouch') { g = [[6, -4], [12, -1]]; }
    else if (m === 'walk') { g = [[7 + Math.sin(this.phase * TAU) * 3, 1], [16, 5]]; }
    else if (m === 'jump') { g = [[-2, 6], [11, 13]]; }
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
    } else if (d.leg) {
      // half a kick's readability is the arm counter-swing
      var ke = strikeEnv(p);
      g = [[8 - 18 * ke, 7 + 12 * ke], [17 - 8 * ke, 11 - 16 * ke]];
    } else if (d.arm !== undefined) {
      /* A strike: the working hand runs out to reach and back. `arc` swings
       * it wide instead of straight, which is what separates a hook from a
       * cross without a second animation. */
      var i = d.arm;
      var ex = strikeEnv(p);
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
      var stiff = (d.arm !== undefined && h === d.arm) ? (p < 0.58 ? 130 : 45) : 16;
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
      var ex = strikeEnv(p);
      var kx = 4 + (d.reach - 4) * ex;
      var ky = -34 + (d.hy + 34) * ex;
      if (d.arc) {
        var a = Math.PI * (0.75 - 0.95 * p);
        kx = 4 + d.reach * 0.9 * ex * Math.sin(a + 0.7);
        ky = d.hy * ex + Math.cos(a) * 16 * ex;
      }
      this.kick.on = 1; this.kick.leg = 1;
      this.kick.x.w = this.kick.y.w = (p < 0.58 ? 110 : 40);
      this.kick.x.t = kx; this.kick.y.t = ky;
      this.kickB.t = 1;
    } else {
      this.kick.on = 0;
      this.kick.x.t = 4; this.kick.y.t = -34;
      this.kickB.t = 0;
    }
    this.kickB.step(dt);

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
    // a crouch is compact: lower AND narrower. Widening it made the
    // silhouette bigger than standing, which is the opposite of the read.
    var stanceW = 15 - 3.5 * this.crouchS.v;
    var want = [this.x + back * stanceW * 0.85 - shift, this.x + lead * stanceW + shift * 0.6];
    if (this.kick.on) {
      // planted foot takes all the weight and slides under the body
      want[1] = this.x + lead * 2;
      want[0] = this.x - lead * 5;
    }
    if (m === 'knockdown' || m === 'defeat' || m === 'getup') {
      want = [this.x - lead * 46, this.x - lead * 20];
    }
    for (var s = 0; s < 2; s++) {
      var fs = this.feet[s];
      fs.planted = true;
      var rate = (m === 'dash' || this.kick.on) ? 18 : 7;
      fs.wx += (want[s] - fs.wx) * Math.min(1, dt * rate);
      fs.wy += (gy - fs.wy) * Math.min(1, dt * 14);
      // a heel that breathes is the cheapest sign of life there is
      fs.angle += ((s === 0 ? -12 + Math.sin(this.breath) * 7 : 4) - fs.angle) * Math.min(1, dt * 7);
    }
  };

  /* Hair and belt tails: verlet points chasing an anchor. Free follow-through
   * on every movement, and the main reason the character reads as alive. */
  Fighter.prototype.secondary = function (dt) {
    var c = this.chest();
    var hipY = this.y - this.hipH.v;
    var pp = this.pose();
    var st = this.hairStyle;
    var hb = (pp.headA + 90 * this.facing) * D2R;
    var ha2 = pp.headA * D2R;
    // anchor: behind the crown by `back` head-radii, raised by `up`
    var ax = pp.headC[0] - Math.cos(hb) * L.headRX * st.back + Math.cos(ha2) * st.up;
    var ay = pp.headC[1] - Math.sin(hb) * L.headRX * st.back + Math.sin(ha2) * st.up;
    var seg = st.seg;
    for (var i = 0; i < this.hair.length; i++) {
      var h = this.hair[i];
      h.vy += st.grav * dt;
      h.vx *= 0.965; h.vy *= 0.965;
      h.x += h.vx * dt; h.y += h.vy * dt;
      var px = i === 0 ? ax : this.hair[i - 1].x;
      var py = i === 0 ? ay : this.hair[i - 1].y;
      var dx = h.x - px, dy = h.y - py;
      var d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
      var k = (d - seg) / d;
      h.x -= dx * k; h.y -= dy * k;
      /* Feed a fraction of the positional correction back as velocity, so
       * the chain swings instead of snapping rigid. At 0.55 it fed in more
       * energy than the damping removed and the tail hung out sideways
       * forever instead of settling. */
      h.vx += (-dx * k) / Math.max(dt, 0.0001) * 0.22;
      h.vy += (-dy * k) / Math.max(dt, 0.0001) * 0.22;
    }
    /* Hem: each point hangs from the belt on a fixed-length link, damped
     * hard so it drapes rather than flaps. `HEM_LEN` is measured from the
     * belt, so the hem sits around mid-thigh. */
    var hemAx = pp.hip[0], hemAy = pp.hip[1] + 2;
    for (var q = 0; q < 2; q++) {
      var e2 = this.hem[q];
      var side = q === 0 ? this.facing : -this.facing;   // 0 = front, 1 = back
      e2.vy += 1500 * dt;
      // a little outward bias so the panels part around the legs
      e2.vx += side * 90 * dt;
      e2.vx *= 0.90; e2.vy *= 0.90;
      e2.x += e2.vx * dt; e2.y += e2.vy * dt;
      var hx2 = e2.x - hemAx, hy2 = e2.y - hemAy;
      var hd = Math.sqrt(hx2 * hx2 + hy2 * hy2) || 0.0001;
      var hk = (hd - 19) / hd;
      e2.x -= hx2 * hk; e2.y -= hy2 * hk;
      e2.vx += (-hx2 * hk) / Math.max(dt, 0.0001) * 0.30;
      e2.vy += (-hy2 * hk) / Math.max(dt, 0.0001) * 0.30;
      // never let a panel swing above the belt
      if (e2.y < hemAy + 8) { e2.y = hemAy + 8; if (e2.vy < 0) e2.vy = 0; }
      // and never further out than it is long -- cloth hangs, it does not fly
      var ox2 = e2.x - hemAx, oy2 = e2.y - hemAy;
      var lim = Math.abs(oy2) * 1.1 + 6;
      if (ox2 > lim) { e2.x = hemAx + lim; e2.vx *= 0.4; }
      else if (ox2 < -lim) { e2.x = hemAx - lim; e2.vx *= 0.4; }
    }

    var bx = this.x - this.facing * 3, by = hipY + 3;
    for (var j = 0; j < this.belt.length; j++) {
      var b = this.belt[j];
      b.vy += 700 * dt;
      b.vx *= 0.955; b.vy *= 0.955;
      b.x += b.vx * dt; b.y += b.vy * dt;
      var qx = j === 0 ? bx : this.belt[j - 1].x;
      var qy = j === 0 ? by : this.belt[j - 1].y;
      var ex = b.x - qx, ey = b.y - qy;
      var e = Math.sqrt(ex * ex + ey * ey) || 0.0001;
      var kk = (e - 9) / e;
      b.x -= ex * kk; b.y -= ey * kk;
      b.vx += (-ex * kk) / Math.max(dt, 0.0001) * 0.55;
      b.vy += (-ey * kk) / Math.max(dt, 0.0001) * 0.55;
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
      // both branches used to return 1, so the rear elbow broke outward
      // like the lead one instead of tucking in
      var pole = (i === 0 ? -1 : 1) * fw;
      var elbow = ik2(shoulders[i][0], shoulders[i][1], hx, hy, L.uArm, L.lArm, -pole);
      hands.push([hx, hy]);
      arms.push({ sh: shoulders[i], elbow: elbow, wrist: [hx, hy] });
    }

    // legs
    var legs = [];
    for (var j = 0; j < 2; j++) {
      var hxp = hipX + (j ? 1 : -1) * fw * L.hipD * 0.40;
      var ax, ay, angle;
      var wx0 = this.feet[j].wx, wy0 = this.feet[j].wy - 4;
      if (j === 1 && this.kickB.v > 0.002) {
        /* Blend between the world-planted foot and the kick target.
         *
         * The ankle used to switch between the two the instant a kick
         * started, teleporting it up to 24 world units -- a fifth of body
         * height -- in a single frame. kickB ramps, so the foot leaves the
         * floor instead of cutting to the target. */
        var kx2 = chest[0] + fw * this.kick.x.v;
        var ky2 = chest[1] - this.kick.y.v;
        var t2 = this.kickB.v;
        ax = wx0 + (kx2 - wx0) * t2;
        ay = wy0 + (ky2 - wy0) * t2;
        angle = (this.def().low ? 8 : -4) * t2 + this.feet[j].angle * (1 - t2);
      } else {
        ax = wx0; ay = wy0;
        angle = this.feet[j].angle;
      }
      var rdx = ax - hxp, rdy = ay - hipY;
      var rd = Math.sqrt(rdx * rdx + rdy * rdy), reach = L.uLeg + L.lLeg - 1;
      if (rd > reach) { ax = hxp + rdx / rd * reach; ay = hipY + rdy / rd * reach; }
      var knee = ik2(hxp, hipY, ax, ay, L.uLeg, L.lLeg, -fw);
      // a knee cannot pass through the floor; in a deep crouch it used to,
      // which is what made the pose read as kneeling rather than crouching
      if (this.onGround && knee[1] > this.groundY - 9) knee[1] = this.groundY - 9;
      legs.push({ hip: [hxp, hipY], knee: knee, ankle: [ax, ay], angle: angle });
    }

    return {
      fw: fw, hip: [hipX, hipY], waist: waist, chest: chest, neck: neck,
      // the renderer needs the twist to decide which shoulder is in front
      twist: this.twist.v,
      headC: headC, headA: headA, leanA: leanA,
      shoulders: shoulders, arms: arms, hands: hands, legs: legs
    };
  };

  F.Fighter = Fighter;
})(FX);
