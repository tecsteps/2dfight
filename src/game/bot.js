/*
 * bot.js -- attract-mode demo player.
 *
 * Arcade cabinets ran a canned input tape. A tape is brittle here: one
 * missed pixel and the rest of the run is nonsense. So this is a waypoint
 * walker instead -- per room, a list of "get to this x, then do this" --
 * which self-corrects and survives the odd bad landing.
 *
 * It drives exactly the same control struct a human does. It has no special
 * access to the character.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var GEO = P.GEO;

  /* Per room: waypoints. {to: x} walks there; {do: ...} performs a move and
   * waits for the character to come to rest before moving on. */
  var PLAN = {
    1: [{ to: 340 }],
    // the gap is cols 4-5 (x 128..191). A running jump carries ~78px, so
    // leave the ground around x=118 to land clear on the far side.
    2: [{ to: 118 }, { do: 'runjump' }, { to: 340 }],
    // spike at col 7 (x 224..255); loose slabs at 2-3 want a brisk pace
    3: [{ to: 178 }, { do: 'runjump' }, { to: 340 }],
    // the floor steps up: stop at the lip, then pull up onto the ledge
    4: [{ to: 138 }, { do: 'stop' }, { do: 'climb' }, { to: 340 }],
    5: [{ do: 'fight' }, { to: 340 }],
    6: [{ to: 240 }, { do: 'idle' }]
  };

  function Bot(game) {
    this.game = game;
    this.reset();
  }

  Bot.prototype.reset = function () {
    this.room = -1;
    this.step = 0;
    this.phase = 0;
    this.timer = 0;
    this.c = { left: 0, right: 0, up: 0, down: 0, shift: 0 };
  };

  Bot.prototype.clear = function () {
    var c = this.c;
    c.left = c.right = c.up = c.down = c.shift = 0;
    return c;
  };

  Bot.prototype.think = function () {
    var k = this.game.kid;
    var c = this.clear();
    if (!k.alive) return c;

    if (k.room !== this.room) {
      this.room = k.room;
      this.step = 0;
      this.phase = 0;
      this.timer = 0;
    }

    var plan = PLAN[this.room];
    if (!plan) return c;

    // advance through finished waypoints in the same tick -- returning
    // early with no input would read as "let go", and letting go mid-run
    // makes him skid to a halt exactly where we wanted him to jump
    for (var i = 0; i < 4; i++) {
      if (this.step >= plan.length) return c;
      if (this.waypoint(plan[this.step], k, c) !== 'next') return c;
      this.step++;
      this.phase = 0;
    }
    return c;
  };

  Bot.prototype.waypoint = function (wp, k, c) {
    if (wp.to !== undefined) {
      if (k.x >= wp.to) return 'next';
      c.right = 1;
      return 'hold';
    }
    if (wp.back !== undefined) {
      if (k.x <= wp.back) return 'next';
      c.left = 1;
      return 'hold';
    }

    switch (wp.do) {
      case 'runjump':
        if (this.phase === 0) {
          c.right = 1; c.up = 1;
          if (k.seqName === 'runjump' || k.seqName === 'standjump') this.phase = 1;
          return 'hold';
        }
        if (k.seqName === 'runcyc' || k.seqName === 'stand' ||
            k.seqName === 'softland' || k.seqName === 'medland') return 'next';
        c.right = 1;
        return 'hold';

      case 'stop':
        return k.seqName === 'stand' ? 'next' : 'hold';

      case 'climb':
        if (k.seqName === 'stand' && this.phase === 1) return 'next';
        if (k.seqName === 'hang' || this.phase === 0) {
          c.up = 1;
          if (k.seqName === 'jumpup' || k.seqName === 'hang' || k.seqName === 'climbup') this.phase = 1;
        }
        return 'hold';

      case 'fight':
        return this.fight(k, c);

      case 'idle':
      default:
        return 'hold';
    }
  };

  /* Fighting: close the distance, then trade. Mixes strikes with blocks so
   * the demo shows both sides of the swordplay rather than mashing attack. */
  Bot.prototype.fight = function (k, c) {
    var foe = this.game.foeOf(k);
    if (!foe || !foe.alive) {
      return (this.timer++ > 8) ? 'next' : 'hold';
    }
    this.timer = 0;
    if (!k.armed) { c.right = 1; return 'hold'; }

    var d = (foe.x - k.x) * k.facing;
    if (d < 0) {                      // he got behind us; turn round
      if (k.facing > 0) c.left = 1; else c.right = 1;
      return 'hold';
    }
    // closing the distance has to happen whatever sequence we are in --
    // gating it on the guard stance meant he stood still until the guard
    // walked to him, which it never did
    if (d > 48) {
      if (k.facing > 0) c.right = 1; else c.left = 1;
      return 'hold';
    }
    if (k.seqName !== 'ready') return 'hold';
    // block while the guard is committed, otherwise take the opening
    if (foe.seqName === 'strike') { c.down = 1; return 'hold'; }
    this.beat = (this.beat || 0) + 1;
    if (this.beat % 4 === 0) c.down = 1; else c.up = 1;
    return 'hold';
  };

  P.Bot = Bot;
})(POP);
