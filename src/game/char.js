/*
 * char.js -- an actor: a program counter walking the sequence table.
 *
 * The whole of a character's motion on the ground comes out of seq.js. The
 * engine only intervenes for the things the animation genuinely cannot
 * know: whether there is still floor underneath, whether a wall got in the
 * way, and free fall (the one place the original does integrate a velocity).
 *
 * This inversion -- animation drives movement, physics only vetoes it -- is
 * what makes the character feel heavy and committed. Once a jump starts you
 * are watching a recording play out, and that is exactly the point.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var OP = P.OP, ACT = P.ACT;

  var TILE_W = 32, TILE_H = 63;
  var ROOM_W = 10, ROOM_H = 3;
  var ROOM_PX_H = ROOM_H * TILE_H;          // 189
  var FLOOR0 = 55;                          // floor line of the top row

  P.GEO = {
    TILE_W: TILE_W, TILE_H: TILE_H, ROOM_W: ROOM_W, ROOM_H: ROOM_H,
    ROOM_PX_H: ROOM_PX_H, FLOOR0: FLOOR0,
    floorY: function (row) { return FLOOR0 + row * TILE_H; },
    rowOf: function (y) { return Math.round((y - FLOOR0) / TILE_H); },
    colOf: function (x) { return Math.floor(x / TILE_W); }
  };

  function Char(game, kind) {
    this.game = game;
    this.kind = kind;              // 'kid' | 'guard'
    this.x = 0;
    this.y = FLOOR0;
    this.facing = 1;
    this.room = 1;
    this.pc = 0;
    this.frame = 0;
    this.action = ACT.STAND;
    this.seqName = '';
    this.fallVx = 0;
    this.fallVy = 0;
    this.fallStartY = 0;
    this.armed = false;
    this.hp = 3;
    this.maxHp = 3;
    this.alive = true;
    this.ctrl = { left: 0, right: 0, up: 0, down: 0, shift: 0 };
    this.hurtFlash = 0;
    this.prevX = 0; this.prevY = 0;
    this.startSeq('stand');
  }

  Char.prototype.startSeq = function (name) {
    var a = this.game.seq.start[name];
    if (a === undefined) { console.warn('no seq ' + name); return; }
    this.seqName = name;
    this.pc = a;
    this.step();                  // land on the sequence's first frame at once
    // control() runs before tick(); without this the tick would step again
    // and every single transition would silently eat its second frame
    this.fresh = true;
  };

  /* One tick of the interpreter: execute instructions until a frame
   * instruction, which is the yield point. */
  Char.prototype.step = function () {
    var code = this.game.seq.code;
    for (var guard = 0; guard < 512; guard++) {
      var op = code[this.pc++];
      if (op > 0) {
        this.frame = op - 1;
        // a sequence can fall through into another one; the owner table
        // keeps seqName honest, which control() depends on
        var o = this.game.seq.owner[this.pc - 1];
        if (o) this.seqName = o;
        return;
      }
      switch (op) {
        case OP.CHX: this.x += code[this.pc++] * this.facing; break;
        case OP.CHY: this.y += code[this.pc++]; break;
        case OP.ACT: this.action = code[this.pc++]; break;
        case OP.GOTO: this.pc = code[this.pc]; break;
        case OP.ABOUTFACE: this.facing = -this.facing; break;
        case OP.SETFALL:
          this.fallVx = code[this.pc++];
          this.fallVy = code[this.pc++];
          break;
        case OP.TAP: this.game.sound(code[this.pc++], this); break;
        case OP.EFFECT: this.game.effect(code[this.pc++], this); break;
        case OP.UP: this.game.moveRoom(this, 'up'); break;
        case OP.DOWN: this.game.moveRoom(this, 'down'); break;
        case OP.DIE: this.die(); return;
        // a divert re-points the pc at another sequence; carrying on
        // through the old stream after that would run the wrong code
        case OP.JARD: if (this.jard()) return; break;
        case OP.JARU: if (this.jaru()) return; break;
        case OP.IFWTLESS: break;
        case OP.NEXTLEVEL: this.game.nextLevel(); break;
        default:
          // ran off the end of the table; park in a safe loop
          this.startSeq('stand');
          return;
      }
    }
    this.startSeq('stand');
  };

  /* jard -- "is there ground under me?" If not, the jump becomes a fall.
   * The original uses this to catch jumps that came up short. */
  Char.prototype.jard = function () {
    if (this.floorHere()) return false;
    this.fallStartY = this.y;
    this.fallVy = 4;
    this.startSeq('freefall');
    return true;
  };

  /* jaru -- reaching up: if there is a ledge to catch, catch it. */
  Char.prototype.jaru = function () {
    var col = this.ledgeAhead();
    if (col < 0) return false;
    this.grabLedge(col);
    return true;
  };

  /* Which column holds the ledge we could catch, or -1. Reaching half a
   * tile ahead is what makes standing at the lip feel right. */
  Char.prototype.ledgeAhead = function () {
    var lvl = this.game.level;
    var row = P.GEO.rowOf(this.y);
    if (row <= 0) return -1;
    var col = P.GEO.colOf(this.x + this.facing * 14);
    if (!lvl.canHang(this.room, col, row - 1)) return -1;
    if (lvl.isFloor(this.room, P.GEO.colOf(this.x), row - 1)) return -1;
    return col;
  };

  /* Snap to the face of the ledge so the pull-up lands on top of it rather
   * than back in the gap. */
  Char.prototype.grabLedge = function (col) {
    var row = P.GEO.rowOf(this.y);
    this.x = this.facing > 0 ? col * TILE_W - 6 : (col + 1) * TILE_W + 6;
    this.y = P.GEO.floorY(row);
    this.startSeq('hang');
  };

  Char.prototype.floorHere = function () {
    var row = P.GEO.rowOf(this.y);
    var col = P.GEO.colOf(this.x);
    return this.game.level.isFloor(this.room, col, row);
  };

  Char.prototype.die = function () {
    if (!this.alive) return;
    this.alive = false;
    this.hp = 0;
    this.game.onDeath(this);
  };

  Char.prototype.hurt = function (n) {
    if (!this.alive) return;
    this.hp -= (n || 1);
    this.hurtFlash = 3;
    this.game.sound(9, this);
    if (this.hp <= 0) {
      this.startSeq('stabbed');
    } else {
      this.startSeq('block');
    }
  };

  var GROUNDED = {};
  GROUNDED[ACT.STAND] = 1; GROUNDED[ACT.RUN] = 1; GROUNDED[ACT.TURN] = 1;

  /* One game tick. */
  Char.prototype.tick = function () {
    if (this.hurtFlash > 0) this.hurtFlash--;
    // remembered so the renderer can interpolate between logic ticks; the
    // sequence table steps at 20Hz but the figure is drawn at display rate
    this.prevX = this.x; this.prevY = this.y;

    if (this.action === ACT.FREEFALL) {
      this.fallTick();
    } else if (this.fresh) {
      this.fresh = false;         // control() already advanced us this tick
    } else {
      this.step();
    }

    this.crossRooms();

    // ground contract: if the sequence thinks we are on the floor but the
    // floor is gone, hand over to gravity
    if (GROUNDED[this.action] && this.alive) {
      if (!this.floorHere()) {
        this.fallStartY = this.y;
        this.fallVx = 0;
        this.fallVy = 2;
        this.startSeq('freefall');
      } else {
        this.blockWalls();
        this.game.onGroundTile(this);
      }
    }
    if (this.action === ACT.HANG || this.action === ACT.HANGSTRAIGHT) {
      this.blockWalls();
    }
  };

  /* Free fall is the one place a velocity exists. Everything else is
   * displacement baked into frames. */
  Char.prototype.fallTick = function () {
    if (this.fresh) this.fresh = false; else this.step();  // flail animation
    this.y += this.fallVy;
    this.x += this.fallVx * this.facing;
    this.fallVy += 4;
    if (this.fallVy > 32) this.fallVy = 32;

    var lvl = this.game.level;
    // did we pass through a floor line on the way down?
    for (var row = 0; row < ROOM_H; row++) {
      var fy = P.GEO.floorY(row);
      if (this.y >= fy && this.y - this.fallVy < fy + 1) {
        var col = P.GEO.colOf(this.x);
        if (lvl.isFloor(this.room, col, row)) {
          this.y = fy;
          this.land();
          return;
        }
      }
    }
    if (this.y >= ROOM_PX_H) {
      if (!this.game.moveRoom(this, 'down')) {
        // no room below: the pit
        this.y = ROOM_PX_H;
        this.die();
      }
    }
  };

  Char.prototype.land = function () {
    var drop = this.y - this.fallStartY;
    this.fallVy = 0;
    this.fallVx = 0;
    var storeys = drop / TILE_H;
    if (storeys < 1.2) {
      this.startSeq('softland');
    } else if (storeys < 2.4) {
      this.hp -= 1;
      this.hurtFlash = 4;
      if (this.hp <= 0) { this.startSeq('hardland'); return; }
      this.startSeq('medland');
    } else {
      this.hp = 0;
      this.startSeq('hardland');
    }
  };

  /* Walls stop you where you stand; the original plays a bump for it. */
  Char.prototype.blockWalls = function () {
    var lvl = this.game.level;
    var row = P.GEO.rowOf(this.y);
    var lead = this.x + this.facing * 8;
    var col = P.GEO.colOf(lead);
    if (lvl.isWall(this.room, col, row)) {
      var edge = this.facing > 0 ? col * TILE_W - 8 : (col + 1) * TILE_W + 8;
      if ((this.facing > 0 && this.x > edge) || (this.facing < 0 && this.x < edge)) {
        this.x = edge;
        if (this.seqName === 'runcyc' || this.seqName === 'startrun') {
          this.startSeq('bump');
        }
      }
    }
  };

  /* Hand-cut to the neighbouring room the moment the body axis leaves this
   * one. This has to happen before the floor test, or walking off the right
   * edge reads as "no floor under column 10" and turns into a fall. */
  Char.prototype.crossRooms = function () {
    var W = ROOM_W * TILE_W;
    if (this.x < 0) {
      if (this.game.moveRoom(this, 'left')) this.x += W;
      else this.x = 0;
    } else if (this.x >= W) {
      if (this.game.moveRoom(this, 'right')) this.x -= W;
      else this.x = W - 1;
    }
  };

  /* ---- control ------------------------------------------------------
   * Sequence selection. The original only lets you change your mind at
   * specific points, which is why the character feels committed rather
   * than twitchy: input is a request to start a new sequence, and it is
   * only honoured when the current one is in a state that permits it.
   */
  Char.prototype.control = function (c) {
    if (!this.alive) return;
    var s = this.seqName;
    var fwd = this.facing > 0 ? c.right : c.left;
    var back = this.facing > 0 ? c.left : c.right;
    var lvl = this.game.level;

    // fighting takes over entirely when a blade is out and someone is close
    if (this.armed && this.game.foeNear(this)) {
      this.fightControl(c);
      return;
    }
    // ...and once the fight is over, drop the guard stance. Without this he
    // stands en garde at a corpse forever, because `ready` is not a state
    // any of the ordinary movement branches below know how to leave.
    if (s === 'ready' || s === 'engarde') { this.startSeq('stand'); return; }

    if (s === 'stand' || s === 'crouch') {
      if (s === 'crouch' && !c.down) { this.startSeq('stand'); return; }
      if (c.down && s !== 'crouch') {
        if (this.canClimbDown()) { this.startSeq('hangstraight'); this.climbDownTo(); }
        else this.startSeq('crouch');
        return;
      }
      if (c.up) {
        // jump up and let jaru decide whether there is a ledge to catch --
        // the original never teleports you into a climb
        if (fwd && this.ledgeAhead() < 0) { this.startSeq('standjump'); return; }
        this.startSeq('jumpup');
        return;
      }
      if (fwd) {
        this.startSeq(c.shift ? 'stepsmall' : 'startrun');
        return;
      }
      if (back) { this.startSeq('turn'); return; }
    } else if (s === 'runcyc' || s === 'startrun') {
      if (c.up) { this.startSeq('runjump'); return; }
      if (back) { this.startSeq('turnrun'); return; }
      if (!fwd) { this.startSeq('runstop'); return; }
    } else if (s === 'hang') {
      if (c.up) {
        var row2 = P.GEO.rowOf(this.y);
        if (lvl.canHang(this.room, P.GEO.colOf(this.x + this.facing * 14), row2 - 1)) {
          this.startSeq('climbup');
          return;
        }
      }
      if (c.down || !c.shift) {
        // letting go is the default; holding shift keeps the grip
        if (c.down) { this.startSeq('hangdrop'); return; }
      }
    }
  };

  var FIGHT_SEQS = { engarde: 1, ready: 1, advance: 1, retreat: 1, strike: 1, block: 1, stabbed: 1, dead: 1 };

  Char.prototype.fightControl = function (c) {
    var s = this.seqName;
    if (!FIGHT_SEQS[s]) { this.startSeq('engarde'); return; }
    if (s !== 'ready') return;      // only interruptible on the guard stance
    var fwd = this.facing > 0 ? c.right : c.left;
    var back = this.facing > 0 ? c.left : c.right;
    if (c.up) { this.startSeq('strike'); return; }
    if (c.down) { this.startSeq('block'); return; }
    if (fwd) { this.startSeq('advance'); return; }
    if (back) { this.startSeq('retreat'); return; }
  };

  Char.prototype.canClimbUp = function () { return this.ledgeAhead() >= 0; };

  Char.prototype.canClimbDown = function () {
    var lvl = this.game.level;
    var row = P.GEO.rowOf(this.y);
    var col = P.GEO.colOf(this.x + this.facing * 14);
    return !lvl.isFloor(this.room, col, row) && row < ROOM_H - 1;
  };

  Char.prototype.climbDownTo = function () {
    this.x += this.facing * 10;
    this.y += TILE_H;
    this.startSeq('hang');
  };

  /* ---- what the procedural figure needs to know ----------------------
   * The sequence table still decides *where* the body goes and which move
   * it is committed to. It no longer decides what the body looks like --
   * that is solved from these continuous signals instead of looked up.
   */
  var REACHING = { hang: 1, hangstraight: 1, hangdrop: 1, jumpup: 1 };
  var FIGHTING = { engarde: 1, ready: 1, advance: 1, retreat: 1, strike: 1, block: 1 };

  Char.prototype.figureCmd = function () {
    var s = this.seqName;
    return {
      move: this.facing,
      airborne: this.action === ACT.FREEFALL || this.action === ACT.INAIR,
      crouch: s === 'crouch' ? 1 : (s === 'softland' || s === 'medland' || s === 'hardland') ? 0.7 : 0,
      reach: REACHING[s] ? 1 : (s === 'climbup' ? 0.6 : 0),
      guard: this.armed && !!FIGHTING[s],
      thrust: s === 'strike' ? 1 : 0,
      dead: !this.alive
    };
  };

  P.Char = Char;
})(POP);
