/*
 * figure.js -- a character whose pose is computed, never stored.
 *
 * This is the pivot away from sprites. There is no frame table, no baked
 * bitmap, no keyframe clip and no animation asset of any kind. The pose is
 * a pure function of continuous state -- a gait phase, a velocity, a set of
 * spring positions -- evaluated fresh every frame and rasterised straight
 * into the indexed framebuffer.
 *
 * Three ideas do the work:
 *
 * 1. FOOT CONTACTS ARE THE ANIMATION. A gait oscillator decides, per foot,
 *    whether it is planted or swinging. A planted foot is pinned to a WORLD
 *    coordinate and simply does not move while the body travels over it.
 *    Skating is not tuned away, it is structurally impossible -- which is
 *    the property rotoscoped frames had for free, because the artist was
 *    tracing a foot that really was planted.
 *
 * 2. LEGS ARE SOLVED, NOT POSED. Given hip and foot, two-link IK gives the
 *    knee. So the legs are always exactly long enough to reach the ground,
 *    at any speed, any stride, any hip height, with no authored angles.
 *
 * 3. EVERYTHING ELSE IS A SPRING. Every remaining joint chases a target
 *    through a critically damped spring. Follow-through, overshoot and the
 *    softness of a transition come out of the integrator rather than out of
 *    hand-drawn in-betweens, and blending between behaviours is free: you
 *    change the target, the body catches up.
 *
 * The consequence is that motion is continuous and parameterised. Ask for a
 * different speed and the stride, cadence, lean and arm swing all follow;
 * nothing snaps to a frame grid, because there is no grid.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var C = P.C, R = P.Raster;
  var D2R = Math.PI / 180, R2D = 180 / Math.PI;
  var TAU = Math.PI * 2;

  /* Proportions in logical pixels, measured off the original's sprite atlas:
   * its standing frame is 41 tall in a 63-pixel storey, and the build is
   * about five and a half heads -- big head, long torso, short legs. */
  var L = {
    torso: 13.5, neck: 2.2,
    headW: 3.1, headH: 3.6, shoulderW: 3.0,
    uArm: 7.6, lArm: 6.6,
    uLeg: 10.5, lLeg: 9.5, foot: 5.6,
    hipHalf: 1.1, standHip: 21.4
  };

  /* Wardrobes. Colour tables only -- there is no geometry to vary, since
   * the same solved figure draws every character. */
  P.SKINS = {
    prince: {
      clothD: C.CLOTH_D, clothM: C.CLOTH_M, clothL: C.CLOTH_L, clothH: C.CLOTH_H,
      skinD: C.SKIN_D, skinM: C.SKIN_M, skinL: C.SKIN_L,
      hair: C.HAIR_D, hair2: C.HAIR_M,
      sashD: C.CLOTH_M, sashM: C.CLOTH_L, helmet: 0
    },
    guard: {
      clothD: C.BLUE_D, clothM: C.BLUE_M, clothL: C.BLUE_L, clothH: C.BLUE_L,
      skinD: C.SKIN_D, skinM: C.SKIN_D, skinL: C.SKIN_M,
      hair: C.HAIR_D, hair2: C.HAIR_M,
      sashD: C.RED_D, sashM: C.RED_M, helmet: C.STEEL_M
    }
  };

  /* ---- critically damped spring -------------------------------------
   * The standard "smooth towards a target with no overshoot" integrator.
   * `omega` is stiffness; higher snaps harder. Stable at any dt.
   */
  function Spring(v, omega) { this.v = v; this.d = 0; this.t = v; this.w = omega || 14; }
  Spring.prototype.set = function (v) { this.v = this.t = v; this.d = 0; };
  Spring.prototype.step = function (dt) {
    var w = this.w, f = 1 + 2 * dt * w;
    var ww = w * w, dtww = dt * ww, det = f + dt * dtww;
    this.v = (f * this.v + dt * this.d + dtww * dt * this.t + dt * this.t * 0 ) / det;
    this.d = (this.d + dtww * (this.t - this.v)) / f;
    return this.v;
  };

  /* Two-link IK: place the ankle at (ax, ay) given a hip at (hx, hy).
   * Returns the knee position, choosing the forward-bending solution. */
  function ik2(hx, hy, ax, ay, l1, l2, front) {
    var dx = ax - hx, dy = ay - hy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var dmin = Math.abs(l1 - l2) + 0.01, dmax = l1 + l2 - 0.01;
    if (d < dmin) d = dmin;
    if (d > dmax) d = dmax;
    var ux = dx / Math.max(0.0001, Math.sqrt(dx * dx + dy * dy));
    var uy = dy / Math.max(0.0001, Math.sqrt(dx * dx + dy * dy));
    var a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    var h2 = l1 * l1 - a * a;
    var h = h2 > 0 ? Math.sqrt(h2) : 0;
    var mx = hx + ux * a, my = hy + uy * a;
    // perpendicular; `front` picks which side the knee falls on
    return [mx + uy * h * front, my - ux * h * front];
  }

  function len(ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); }

  /* ---- the figure ---------------------------------------------------- */

  function Figure(skin) {
    this.skin = skin;
    this.x = 0; this.y = 0;          // pelvis reference: feet-on-floor point
    this.facing = 1;
    this.vx = 0;

    this.phase = 0;                  // gait cycle position, 0..1
    this.cadence = 0;                // cycles per second, follows speed
    this.airborne = false;
    this.groundY = 0;

    // per-foot contact state, in WORLD coordinates
    this.feet = [
      { planted: true, wx: 0, wy: 0, liftX: 0, liftY: 0, angle: 0 },
      { planted: true, wx: 0, wy: 0, liftX: 0, liftY: 0, angle: 0 }
    ];

    // sprung degrees of freedom
    this.hipH = new Spring(L.standHip, 16);
    this.lean = new Spring(-88, 10);
    this.head = new Spring(-90, 8);
    this.armF = [new Spring(95, 13), new Spring(100, 11)];  // shoulder, elbow
    this.armN = [new Spring(88, 13), new Spring(95, 11)];
    this.crouch = new Spring(0, 12);
    this.reach = new Spring(0, 14);       // 0 = normal, 1 = arms overhead
    this.bladeA = new Spring(-8, 18);
    this.armed = false;

    // gait shape, adjusted by speed
    this.stride = 32;
    this.duty = 0.55;
    this.lift = 5.5;
  }

  Figure.prototype.setGround = function (y) { this.groundY = y; };

  Figure.prototype.teleport = function (x, y) {
    this.x = x; this.y = y; this.groundY = y;
    for (var i = 0; i < 2; i++) {
      var f = this.feet[i];
      f.planted = true; f.wx = x + (i ? 4 : -4); f.wy = y; f.angle = 0;
    }
    this.hipH.set(L.standHip);
  };

  /* Advance the whole model by dt seconds.
   * cmd: { move: -1..1, crouch: 0..1, reach: 0..1, airborne, blade }  */
  Figure.prototype.update = function (dt, cmd) {
    cmd = cmd || {};
    var move = cmd.move || 0;
    var speed = Math.abs(this.vx);

    if (move !== 0) this.facing = move > 0 ? 1 : -1;

    /* Gait shape scales with speed the way a real one does: a walk has a
     * long stance and a short stride, a run has a short stance, a long
     * stride and a flight phase where neither foot is down. */
    var walkRun = Math.min(1, speed / 90);
    this.stride = 20 + 22 * walkRun;
    this.duty = 0.62 - 0.26 * walkRun;         // <0.5 means flight
    this.lift = 3.2 + 4.0 * walkRun;

    this.cadence = speed > 1 ? speed / this.stride : 0;
    if (this.cadence > 0) this.phase = (this.phase + this.cadence * dt) % 1;

    this.airborne = !!cmd.airborne;

    // posture targets
    this.crouch.t = cmd.crouch || 0;
    this.reach.t = cmd.reach || 0;
    var leanAmt = 15 * walkRun * Math.min(1, speed / 40) + 10 * this.crouch.v;
    this.lean.t = -90 + this.facing * (this.airborne ? 6 : leanAmt);
    this.head.t = -90 + this.facing * 6 * walkRun;
    this.hipH.t = (L.standHip - 6.5 * this.crouch.v) - (this.airborne ? 0 : 1.6 * walkRun);

    this.updateFeet(dt, walkRun);
    this.updateArms(dt, walkRun, cmd);

    this.hipH.step(dt); this.lean.step(dt); this.head.step(dt);
    this.crouch.step(dt); this.reach.step(dt); this.bladeA.step(dt);
  };

  /* Foot contacts. This is the part that makes the motion read as walking
   * rather than as a drawing being dragged sideways. */
  Figure.prototype.updateFeet = function (dt, walkRun) {
    var self = this;
    var gy = this.groundY;

    if (this.airborne) {
      // in flight both feet just follow the body; nothing is planted
      for (var a = 0; a < 2; a++) {
        var ff = this.feet[a];
        ff.planted = false;
        var tx = this.x + this.facing * (a ? 5 : -3);
        ff.wx += (tx - ff.wx) * Math.min(1, dt * 12);
        ff.wy += ((gy - 4) - ff.wy) * Math.min(1, dt * 8);
        ff.angle += (-20 - ff.angle) * Math.min(1, dt * 8);
      }
      return;
    }

    if (this.cadence <= 0) {
      // standing: settle both feet either side of the body axis
      for (var s = 0; s < 2; s++) {
        var fs = this.feet[s];
        fs.planted = true;
        var want = this.x + this.facing * (s ? 3.4 : -3.4);
        fs.wx += (want - fs.wx) * Math.min(1, dt * 6);
        fs.wy = gy;
        fs.angle += (0 - fs.angle) * Math.min(1, dt * 6);
      }
      return;
    }

    for (var i = 0; i < 2; i++) {
      var f = this.feet[i];
      var p = (this.phase + i * 0.5) % 1;
      var stance = p < this.duty;

      if (stance) {
        if (!f.planted) {
          // touchdown: nail the foot to the world here and now
          f.planted = true;
          f.wy = gy;
        }
        // planted: the world position does not change at all
        f.angle += ((p / this.duty < 0.25 ? 12 : p / this.duty > 0.75 ? -34 : 0) - f.angle)
          * Math.min(1, dt * 16);
      } else {
        if (f.planted) {
          f.planted = false;
          f.liftX = f.wx; f.liftY = f.wy;
        }
        var u = (p - this.duty) / (1 - this.duty);      // 0..1 through swing
        // where the body will be when this foot lands, plus a lead so it
        // reaches out ahead the way a stride does
        var swingTime = (1 - this.duty) / Math.max(0.001, this.cadence);
        var landX = this.x + this.vx * swingTime * (1 - u)
          + this.facing * this.stride * 0.30;
        var e = u * u * (3 - 2 * u);
        f.wx = f.liftX + (landX - f.liftX) * e;
        f.wy = gy - Math.sin(Math.PI * u) * this.lift;
        f.angle += ((u < 0.5 ? -30 + 60 * u : 18) - f.angle) * Math.min(1, dt * 14);
      }
      void self;
    }
  };

  Figure.prototype.updateArms = function (dt, walkRun, cmd) {
    var sw = Math.sin(this.phase * TAU);
    var swLead = Math.sin(this.phase * TAU + 0.85);   // forearm lags the arm
    var amp = 30 * walkRun + 5;
    var bend = 24 + 34 * walkRun;

    if (this.reach.v > 0.02) {
      // reaching overhead (hanging, climbing) overrides the swing
      var r = this.reach.v;
      this.armF[0].t = 95 + (-88 - 95) * r;
      this.armF[1].t = 100 + (-90 - 100) * r;
      this.armN[0].t = 88 + (-86 - 88) * r;
      this.armN[1].t = 95 + (-88 - 95) * r;
    } else if (cmd.guard) {
      this.armF[0].t = 130; this.armF[1].t = 176;
      this.armN[0].t = 20 + (cmd.thrust || 0) * -18;
      this.armN[1].t = -6 + (cmd.thrust || 0) * 8;
    } else {
      this.armF[0].t = 92 - amp * sw;
      this.armF[1].t = 92 - amp * 1.35 * swLead - bend;
      this.armN[0].t = 92 + amp * sw;
      this.armN[1].t = 92 + amp * 1.35 * swLead - bend;
    }
    this.armF[0].step(dt); this.armF[1].step(dt);
    this.armN[0].step(dt); this.armN[1].step(dt);
  };

  /* ---- pose evaluation ----------------------------------------------
   * Turn the continuous state into concrete joint positions. Pure function
   * of the state; nothing here is looked up.
   */
  Figure.prototype.pose = function () {
    var hipY = this.y - this.hipH.v;            // screen space: y grows down
    var hipX = this.x;
    var leanA = this.lean.v, headA = this.head.v;

    // screen space: y grows down, so -90 (up) must decrease y
    function adv(x, y, ang, l) {
      return [x + Math.cos(ang * D2R) * l, y + Math.sin(ang * D2R) * l];
    }
    var neck = adv(hipX, hipY, leanA, L.torso);
    var sh = adv(neck[0], neck[1], leanA, -1.4);
    var headBase = adv(neck[0], neck[1], headA, L.neck);
    var headC = adv(headBase[0], headBase[1], headA, L.headH * 0.82);

    var out = { hipX: hipX, hipY: hipY, leanA: leanA, headA: headA,
      neck: neck, sh: sh, headC: headC, legs: [], arms: [] };

    for (var i = 0; i < 2; i++) {
      var f = this.feet[i];
      var hx = hipX + this.facing * (i ? L.hipHalf : -L.hipHalf);
      // the ankle sits above the contact point by the height of the foot
      var ax = f.wx, ay = f.wy - 2.0;
      /* Clamp the ankle into leg reach. A world-pinned foot is normally
       * within reach by construction, but if the body is teleported -- a
       * room cut, a respawn -- the pin is briefly stale, and drawing to it
       * would stretch the shin clean across the screen. Degrade, don't
       * explode. */
      var rdx = ax - hx, rdy = ay - hipY;
      var rd = Math.sqrt(rdx * rdx + rdy * rdy), reach = L.uLeg + L.lLeg - 0.5;
      if (rd > reach) { ax = hx + rdx / rd * reach; ay = hipY + rdy / rd * reach; }
      var knee = ik2(hx, hipY, ax, ay, L.uLeg, L.lLeg, -this.facing);
      out.legs.push({ hip: [hx, hipY], knee: knee, ankle: [ax, ay], angle: f.angle });
    }
    var arms = [this.armF, this.armN];
    for (var a = 0; a < 2; a++) {
      var sa = arms[a][0].v, ea = arms[a][1].v;
      if (this.facing < 0) { sa = 180 - sa; ea = 180 - ea; }
      var elbow = adv(sh[0], sh[1], sa, L.uArm);
      var wrist = adv(elbow[0], elbow[1], ea, L.lArm);
      out.arms.push({ sh: sh, elbow: elbow, wrist: wrist });
    }
    return out;
  };

  /* ---- live rasterisation --------------------------------------------
   * Straight into the framebuffer, in device pixels, every frame. Each part
   * is drawn twice: an expanded pass in a shadow tone, then the part
   * itself. That rim is what separates a near limb from whatever is behind
   * it -- the job an outline pass did when these were baked bitmaps.
   */
  function Painter(g) {
    this.g = g;
    this.cv = { w: g.w, h: g.h, data: g.buf, part: null, partId: 0 };
    this.s = g.s;
  }
  Painter.prototype.cap = function (a, b, r0, r1, col) {
    var s = this.s;
    R.capsule(this.cv, a[0] * s, a[1] * s, b[0] * s, b[1] * s, r0 * s, r1 * s, col);
  };
  Painter.prototype.disc = function (a, r, col) {
    var s = this.s;
    R.disc(this.cv, a[0] * s, a[1] * s, r * s, col);
  };
  Painter.prototype.poly = function (pts, col) {
    var s = this.s, f = [];
    for (var i = 0; i < pts.length; i++) { f.push(pts[i][0] * s, pts[i][1] * s); }
    R.fillPoly(this.cv, f, col);
  };
  Painter.prototype.limb = function (a, b, radii, col, rim) {
    var n = radii.length, i;
    if (rim !== undefined) {
      for (i = 0; i < n - 1; i++) {
        this.cap(mix(a, b, i / (n - 1)), mix(a, b, (i + 1) / (n - 1)),
          radii[i] + 0.7, radii[i + 1] + 0.7, rim);
      }
    }
    for (i = 0; i < n - 1; i++) {
      this.cap(mix(a, b, i / (n - 1)), mix(a, b, (i + 1) / (n - 1)), radii[i], radii[i + 1], col);
    }
  };
  Painter.prototype.oval = function (c, rx, ry, ang, col) {
    var d = [Math.cos(ang * D2R), Math.sin(ang * D2R)], n = [-d[1], d[0]], pts = [];
    for (var i = 0; i < 16; i++) {
      var t = i / 16 * TAU, u = Math.cos(t) * ry, v = Math.sin(t) * rx;
      pts.push([c[0] + d[0] * u + n[0] * v, c[1] + d[1] * u + n[1] * v]);
    }
    this.poly(pts, col);
  };

  function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }
  function add(p, d, k) { return [p[0] + d[0] * k, p[1] + d[1] * k]; }
  function dirv(ang) { return [Math.cos(ang * D2R), Math.sin(ang * D2R)]; }

  Figure.prototype.draw = function (g) {
    var pt = new Painter(g);
    var sk = this.skin;
    var q = this.pose();
    var fw = this.facing;

    // far side first
    this.drawLeg(pt, q.legs[0], sk, true, fw);
    this.drawArm(pt, q.arms[0], sk, true, fw);
    this.drawTorso(pt, q, sk, fw);
    this.drawHead(pt, q, sk, fw);
    this.drawLeg(pt, q.legs[1], sk, false, fw);
    this.drawArm(pt, q.arms[1], sk, false, fw);
    if (this.armed) this.drawBlade(pt, q.arms[1].wrist, sk, fw);
  };

  Figure.prototype.drawLeg = function (pt, lg, sk, far, fw) {
    var cloth = far ? sk.clothD : sk.clothM;
    var hi = far ? sk.clothM : sk.clothL;
    var skin = far ? sk.skinM : sk.skinL;
    var rim = far ? null : sk.clothD;
    pt.limb(lg.hip, lg.knee, [3.4, 3.1, 2.4], cloth, rim === null ? undefined : rim);
    var mid = mix(lg.knee, lg.ankle, 0.58);
    pt.limb(lg.knee, mid, [2.4, 2.6], cloth, rim === null ? undefined : rim);
    pt.limb(mid, lg.ankle, [2.1, 1.5], skin);
    void hi;
    // foot: a wedge, aligned to the contact angle
    var fa = fw < 0 ? 180 - lg.angle : lg.angle;
    var d = dirv(fa), u = [d[1], -d[0]];        // u points up out of the sole
    var A = lg.ankle;
    pt.poly([
      add(add(A, d, -1.8), u, 1.3),
      add(add(A, d, 1.0), u, 1.2),
      add(add(A, d, L.foot * 0.6), u, 0.4),
      add(add(A, d, L.foot - 0.4), u, -0.9),
      add(add(A, d, L.foot - 0.6), u, -1.7),
      add(add(A, d, -1.7), u, -1.7)
    ], skin);
  };

  Figure.prototype.drawArm = function (pt, a, sk, far, fw) {
    var sleeve = far ? sk.clothD : sk.clothL;
    var skin = far ? sk.skinD : sk.skinL;
    var rim = far ? undefined : sk.clothD;
    pt.disc(a.sh, L.shoulderW, sleeve);
    var se = mix(a.sh, a.elbow, 0.55);
    pt.limb(a.sh, se, [2.7, 2.6], sleeve, rim);
    pt.limb(se, a.elbow, [2.2, 1.8], skin, rim);
    pt.limb(a.elbow, a.wrist, [1.9, 2.0, 1.4], skin, rim);
    var fa = Math.atan2(-(a.wrist[1] - a.elbow[1]), a.wrist[0] - a.elbow[0]) * R2D;
    pt.oval(add(a.wrist, dirv(fa), 1.2), 1.25, 1.7, fa, skin);
  };

  Figure.prototype.drawTorso = function (pt, q, sk, fw) {
    var axis = dirv(q.leanA), fwd = dirv(q.leanA + 90 * fw);
    var hip = [q.hipX, q.hipY];
    function P(u, perp) { return add(add(hip, axis, u * L.torso), fwd, perp); }
    pt.poly([
      P(-0.06, 2.7), P(0.26, 2.1), P(0.58, 3.1), P(0.84, 3.2), P(1.02, 2.2),
      P(1.04, -2.3), P(0.86, -3.1), P(0.56, -3.0), P(0.26, -2.3), P(-0.06, -2.9)
    ], sk.clothM);
    pt.poly([
      P(0.30, 2.0), P(0.58, 3.0), P(0.84, 3.1), P(1.0, 2.1),
      P(0.98, 0.4), P(0.60, 0.7), P(0.32, 0.2)
    ], sk.clothL);
    pt.disc(hip, 3.0, sk.clothM);
    var w0 = P(0.10, 0), w1 = P(0.30, 0);
    pt.cap(w0, w1, 2.9, 3.0, sk.sashM);
    pt.cap(w0, w1, 2.2, 2.3, sk.sashD);
  };

  Figure.prototype.drawHead = function (pt, q, sk, fw) {
    var headA = q.headA, fwd = dirv(headA + 90 * fw), up = dirv(headA);
    var hc = q.headC;
    pt.cap(q.neck, add(hc, up, -L.headH * 0.82), 1.7, 1.6, sk.skinM);
    pt.oval(hc, L.headW, L.headH, headA, sk.skinL);
    pt.oval(add(add(hc, up, -1.4), fwd, 1.0), 2.5, 2.9, headA, sk.skinL);
    pt.disc(add(add(hc, fwd, L.headW * 0.86), up, 0.2), 1.05, sk.skinL);
    if (sk.helmet) {
      pt.oval(add(hc, up, 0.9), L.headW * 1.02, L.headH * 0.78, headA, sk.helmet);
      pt.disc(add(hc, dirv(headA - 90 * fw), 2.4), 2.4, C.STEEL_D);
    } else {
      pt.oval(add(hc, up, 0.55), L.headW, L.headH * 0.84, headA, sk.hair);
      var nape = add(add(hc, dirv(headA - 90 * fw), 2.2), up, -1.3);
      pt.oval(nape, 1.8, 2.3, headA, sk.hair);
      pt.poly([
        add(add(hc, fwd, 0.2), up, 2.6),
        add(add(hc, fwd, L.headW * 0.95), up, 0.9),
        add(add(hc, fwd, L.headW * 0.95), up, -1.8),
        add(add(hc, fwd, 1.4), up, -4.0),
        add(add(hc, fwd, -0.4), up, -2.0)
      ], sk.skinL);
    }
    pt.disc(add(add(hc, fwd, L.headW * 0.60), up, 0.55), 0.72, C.OUTLINE);
  };

  Figure.prototype.drawBlade = function (pt, wrist, sk, fw) {
    var ang = fw < 0 ? 180 - this.bladeA.v : this.bladeA.v;
    var d = dirv(ang);
    pt.cap(add(wrist, d, -2.4), add(wrist, d, 21), 1.5, 0.8, C.STEEL_L);
    pt.cap(add(wrist, dirv(ang + 90), 2.6), add(wrist, dirv(ang - 90), 2.6), 1.0, 1.0, C.GOLD);
  };

  P.Figure = Figure;
  P.FigureL = L;
  P.Spring = Spring;
  P.ik2 = ik2;
  void len;
})(POP);
