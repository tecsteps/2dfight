/*
 * game.js -- boot, the fixed-rate tick, and everything that isn't the
 * sequence table.
 *
 * The loop is deliberately not tied to the display refresh. The original ran
 * its logic at a fixed low rate and every animation was authored to that
 * clock; interpolating between frames to hit 60Hz would smear exactly the
 * poses the rotoscope was made to hold. So we tick at a fixed rate and let
 * frames land on whole ticks -- chunky on purpose.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var C = P.C, ACT = P.ACT, T = P.T;
  var GEO = P.GEO;
  var TICK_HZ = 20;                     // DOS-speed; the Apple II was slower
  var PLAYFIELD_H = 189;

  function Game(canvas) {
    this.g = new P.Gfx(320, 200);
    this.g.attach(canvas);
    this.t = 0;
    this.acc = 0;
    this.last = 0;
    this.paused = false;
    this.message = '';
    this.messageT = 0;
    this.shake = 0;
    this.flash = 0;

    this.ftKid = P.buildFrameTable('prince');
    this.ftGuard = this.ftKid;          // same bitmaps, different wardrobe
    this.guardMap = P.buildWardrobeMap(P.SKINS.prince, P.SKINS.guard);
    this.seq = P.assembleSeq(this.ftKid);

    this.level = new P.Level(P.LEVEL1);
    this.audio = new P.Audio();

    this.kid = new P.Char(this, 'kid');
    var st = P.LEVEL1.start;
    this.kid.room = st.room;
    this.kid.x = st.col * GEO.TILE_W + 16;
    this.kid.y = GEO.floorY(st.row);
    this.kid.facing = st.facing;
    this.kid.startSeq('stand');

    this.guards = [];
    this.spawnGuards();

    this.autoplay = true;
    this.bot = new P.Bot(this);
    this.input = { left: 0, right: 0, up: 0, down: 0, shift: 0 };
    this.won = false;
    this.deaths = 0;

    this.roomDirty = true;
    this.curRoom = -1;
  }

  Game.prototype.spawnGuards = function () {
    this.guards = [];
    var rooms = this.level.rooms;
    for (var id in rooms) {
      if (!rooms.hasOwnProperty(id)) continue;
      var defs = rooms[id].guards || [];
      for (var i = 0; i < defs.length; i++) {
        var d = defs[i];
        var gd = new P.Char(this, 'guard');
        gd.room = +id;
        gd.x = d.col * GEO.TILE_W + 16;
        gd.y = GEO.floorY(d.row);
        gd.facing = d.facing;
        gd.armed = true;
        gd.hp = gd.maxHp = 3;
        gd.ai = { cool: 0, engaged: false };
        gd.startSeq('alertstand');
        this.guards.push(gd);
      }
    }
  };

  /* ---- callbacks the sequence interpreter reaches back into ---------- */

  Game.prototype.sound = function (id, ch) { this.audio.play(id, ch === this.kid); };

  Game.prototype.effect = function (id, ch) {
    if (id === 1) {               // finished drinking
      ch.hp = Math.min(ch.maxHp, ch.hp + 1);
      this.flash = 3;
    } else if (id === 2) {        // the frame a sword strike actually lands
      this.resolveStrike(ch);
    }
  };

  Game.prototype.moveRoom = function (ch, dir) {
    var r = this.level.rooms[ch.room];
    if (!r) return false;
    var to = r.links[dir];
    if (!to || !this.level.rooms[to]) return false;
    ch.room = to;
    if (dir === 'down') ch.y -= GEO.ROOM_PX_H;
    if (dir === 'up') ch.y += GEO.ROOM_PX_H;
    if (ch === this.kid) this.roomDirty = true;
    return true;
  };

  Game.prototype.onDeath = function (ch) {
    if (ch === this.kid) {
      this.deaths++;
      this.say('YOU HAVE FAILED', 40);
      var self = this;
      this.restartT = 34;
    }
  };

  Game.prototype.nextLevel = function () { this.win(); };

  Game.prototype.win = function () {
    if (this.won) return;
    this.won = true;
    this.say('THE WAY IS OPEN', 60);
    this.flash = 6;
  };

  Game.prototype.say = function (m, t) { this.message = m; this.messageT = t; };

  /* Standing on a tile: loose slabs, spikes, plates, pickups, the exit. */
  Game.prototype.onGroundTile = function (ch) {
    var lvl = this.level;
    var col = GEO.colOf(ch.x), row = GEO.rowOf(ch.y);
    var t = lvl.tile(ch.room, col, row);
    var r = lvl.rooms[ch.room];

    if (t === T.SPIKES && ch.alive) {
      // spikes only bite if you are actually standing on them
      if (ch.seqName === 'stand' || ch.seqName === 'crouch' ||
          ch.seqName === 'softland' || ch.seqName === 'medland') {
        ch.hp = 0;
        this.sound(5, ch);
        ch.startSeq('stabbed');
      }
      return;
    }
    if (t === T.LOOSE) {
      var key = col * 16 + row;
      if (!r.loose[key]) r.loose[key] = { col: col, row: row, state: 'shake', t: 0, dy: 0 };
    }
    if (t === T.PLATE_OPEN) { r.gatesOpen = true; r.gateT = 60; }
    if (t === T.PLATE_SHUT) { r.gatesOpen = false; }
    if (t === T.SWORD && ch === this.kid && !ch.armed) {
      ch.armed = true;
      lvl.setTile(ch.room, col, row, T.FLOOR);
      this.roomDirty = true;
      this.say('YOU HAVE THE SWORD', 40);
      this.sound(10, ch);
    }
    if (t === T.POTION && ch === this.kid) {
      lvl.setTile(ch.room, col, row, T.FLOOR);
      this.roomDirty = true;
      ch.startSeq('drink');
    }
    if (t === T.EXIT && ch === this.kid) this.win();
  };

  /* ---- combat -------------------------------------------------------- */

  Game.prototype.foeNear = function (ch) {
    var f = this.foeOf(ch);
    return !!f && Math.abs(f.x - ch.x) < 70;
  };

  Game.prototype.foeOf = function (ch) {
    if (ch === this.kid) {
      for (var i = 0; i < this.guards.length; i++) {
        var gd = this.guards[i];
        if (gd.alive && gd.room === ch.room) return gd;
      }
      return null;
    }
    return (this.kid.alive && this.kid.room === ch.room) ? this.kid : null;
  };

  Game.prototype.resolveStrike = function (ch) {
    var f = this.foeOf(ch);
    if (!f || !f.alive) return;
    var d = (f.x - ch.x) * ch.facing;
    if (d < 4 || d > 40) { this.audio.play(11, true); return; }
    if (f.seqName === 'block') {
      this.audio.play(8, true);          // parried
      this.shake = 2;
      return;
    }
    f.hurt(1);
    this.shake = 3;
    this.flash = 2;
  };

  /* Guard AI. Deliberately readable rather than clever: the original's
   * guards mostly advance, hold, strike and block on a timer, and the
   * tension comes from the animation commitment, not the decision tree. */
  Game.prototype.guardAI = function (gd) {
    var k = this.kid;
    var ai = gd.ai;
    if (!gd.alive) return;
    if (!k.alive || k.room !== gd.room) {
      if (ai.engaged && gd.seqName === 'ready') gd.startSeq('alertstand');
      ai.engaged = false;
      return;
    }
    var dist = Math.abs(k.x - gd.x);
    var want = k.x > gd.x ? 1 : -1;

    if (!ai.engaged) {
      if (dist < 96) {
        ai.engaged = true;
        if (gd.facing !== want) gd.facing = want;
        gd.startSeq('engarde');
      }
      return;
    }
    if (gd.seqName !== 'ready') return;
    if (gd.facing !== want && dist > 6) { gd.startSeq('turn'); return; }

    if (ai.cool > 0) { ai.cool--; return; }

    // block if the kid is committed to a strike and we are in range
    if (k.seqName === 'strike' && dist < 46) { gd.startSeq('block'); ai.cool = 2; return; }

    var r = Math.random();
    if (dist > 44) {
      if (r < 0.75) gd.startSeq('advance');
      ai.cool = 1;
    } else if (dist < 26) {
      if (r < 0.5) gd.startSeq('retreat'); else gd.startSeq('strike');
      ai.cool = 2;
    } else {
      if (r < 0.45) gd.startSeq('strike');
      else if (r < 0.65) gd.startSeq('advance');
      else if (r < 0.8) gd.startSeq('retreat');
      ai.cool = 2 + (Math.random() * 3 | 0);
    }
  };

  /* ---- tick ---------------------------------------------------------- */

  Game.prototype.tick = function () {
    this.t++;
    if (this.messageT > 0) this.messageT--;
    if (this.shake > 0) this.shake--;
    if (this.flash > 0) this.flash--;

    if (this.restartT !== undefined) {
      if (--this.restartT <= 0) { this.restartT = undefined; this.restart(); return; }
    }

    var ctrl = this.autoplay ? this.bot.think() : this.input;

    if (this.kid.alive) this.kid.control(ctrl);
    this.kid.tick();

    for (var i = 0; i < this.guards.length; i++) {
      var gd = this.guards[i];
      this.guardAI(gd);
      gd.tick();
    }

    this.tickLoose();
    if (this.won && this.messageT <= 0) this.restart();
  };

  Game.prototype.tickLoose = function () {
    var lvl = this.level;
    for (var id in lvl.rooms) {
      if (!lvl.rooms.hasOwnProperty(id)) continue;
      var r = lvl.rooms[id];
      for (var k in r.loose) {
        if (!r.loose.hasOwnProperty(k)) continue;
        var L = r.loose[k];
        L.t++;
        if (L.state === 'shake') {
          if (L.t > 13) { L.state = 'fall'; L.dy = 0; lvl.setTile(+id, L.col, L.row, T.SPACE); if (+id === this.kid.room) this.roomDirty = true; this.audio.play(12, +id === this.kid.room); }
        } else if (L.state === 'fall') {
          L.dy += 6;
          if (L.dy > 70) delete r.loose[k];
        }
      }
    }
  };

  Game.prototype.restart = function () {
    var st = P.LEVEL1.start;
    this.level = new P.Level(P.LEVEL1);
    this.kid = new P.Char(this, 'kid');
    this.kid.room = st.room;
    this.kid.x = st.col * GEO.TILE_W + 16;
    this.kid.y = GEO.floorY(st.row);
    this.kid.facing = st.facing;
    this.kid.startSeq('stand');
    this.spawnGuards();
    this.bot.reset();
    this.won = false;
    this.roomDirty = true;
    this.message = '';
    this.messageT = 0;
  };

  /* ---- render -------------------------------------------------------- */

  Game.prototype.drawChar = function (ch) {
    var g = this.g;
    var f = ch.sprites();
    if (!f) return;
    var x = Math.round(ch.x), y = Math.round(ch.y);
    var flip = ch.facing < 0;
    var map = null;
    if (ch.hurtFlash > 0 && (this.t & 1)) map = this.hurtMap || (this.hurtMap = buildHurtMap());
    else if (ch.kind === 'guard') map = this.guardMap;
    if (map) {
      g.blitRemap(f.img, x, y, flip, map, null, 0, PLAYFIELD_H);
      if (ch.armed) g.blitRemap(f.sword, x, y, flip, map, null, 0, PLAYFIELD_H);
      return;
    }
    g.blit(f.img, x, y, flip, null, 0, PLAYFIELD_H);
    if (ch.armed) g.blit(f.sword, x, y, flip, null, 0, PLAYFIELD_H);
  };

  function buildHurtMap() {
    var m = new Uint8Array(64);
    for (var i = 0; i < 64; i++) m[i] = i;
    // everything but the outline goes hot -- a palette trick, no extra art
    for (var j = 1; j < 40; j++) if (j !== C.OUTLINE) m[j] = C.RED_M;
    return m;
  }

  Game.prototype.render = function () {
    var g = this.g;
    var room = this.kid.room;
    if (this.roomDirty || room !== this.curRoom) {
      this.level.renderRoom(g, room);
      this.curRoom = room;
      this.roomDirty = false;
    }
    g.restore();
    this.level.renderDynamic(g, room, this.t);

    for (var i = 0; i < this.guards.length; i++) {
      if (this.guards[i].room === room) this.drawChar(this.guards[i]);
    }
    this.drawChar(this.kid);

    this.drawHud();

    // palette flash instead of touching pixels -- the cheap 1989 way
    g.buildPalette(this.flash > 0 ? 0.10 * this.flash : 0);
    g.present();
  };

  Game.prototype.drawHud = function () {
    var g = this.g;
    g.fillRect(0, PLAYFIELD_H, 320, 200 - PLAYFIELD_H, C.VOID);
    g.hline(0, PLAYFIELD_H, 320, C.BRICK_S);

    // the prince's life, as little vials on the left
    for (var i = 0; i < this.kid.maxHp; i++) {
      var x = 4 + i * 7, y = PLAYFIELD_H + 3;
      var on = i < this.kid.hp;
      g.fillRect(x, y, 4, 6, on ? C.RED_M : C.BRICK_S);
      g.hline(x, y, 4, on ? C.FLAME : C.BRICK_D);
    }
    // the guard's, on the right, only while it matters
    var f = this.foeOf(this.kid);
    if (f && f.alive && f.ai && f.ai.engaged) {
      for (var j = 0; j < f.maxHp; j++) {
        var gx = 316 - 4 - j * 7;
        g.fillRect(gx, PLAYFIELD_H + 3, 4, 6, j < f.hp ? C.BLUE_L : C.BRICK_S);
        g.hline(gx, PLAYFIELD_H + 3, 4, j < f.hp ? C.STEEL_L : C.BRICK_D);
      }
    }

    if (this.messageT > 0 && this.message) {
      var w = P.Font.width(this.message);
      P.Font.text(g, this.message, (320 - w) >> 1, 92, C.CREAM, C.VOID);
    }
    if (this.autoplay) {
      P.Font.text(g, 'DEMO', 320 - 4 - P.Font.width('DEMO'), PLAYFIELD_H + 3, C.BRICK_L);
    }
  };

  /* ---- frame pump ---------------------------------------------------- */

  Game.prototype.frame = function (now) {
    if (!this.last) this.last = now;
    var dt = Math.min(250, now - this.last);
    this.last = now;
    var drew = false;
    if (!this.paused) {
      this.acc += dt;
      var step = 1000 / TICK_HZ;
      var n = 0;
      while (this.acc >= step && n < 5) { this.tick(); this.acc -= step; n++; drew = true; }
    }
    if (drew || !this.everDrew) { this.render(); this.everDrew = true; }
  };

  Game.prototype.setInput = function (k, v) {
    if (this.input[k] === v) return;
    this.input[k] = v;
    if (v) this.userTookOver();
  };

  Game.prototype.userTookOver = function () {
    if (this.autoplay) {
      this.autoplay = false;
      this.say('YOU HAVE CONTROL', 24);
    }
    this.audio.enable();
  };

  P.Game = Game;
  P.TICK_HZ = TICK_HZ;
})(POP);
