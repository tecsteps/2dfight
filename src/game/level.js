/*
 * level.js -- rooms, tiles, and the dungeon renderer.
 *
 * Geometry follows the original: a room is 10 by 3 tiles, a tile is 32 by
 * 63 pixels, so a room is exactly one 320-pixel screen. Rooms do not
 * scroll -- walking off an edge hard-cuts to the neighbour, which is what
 * let a 1989 machine hold a whole castle in memory.
 *
 * The background is drawn once per room into the framebuffer's bg plane;
 * the per-frame loop then just restores from it. Only torches are redrawn
 * live, because a flickering torch is worth the pixels.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  var C = P.C;
  var TILE_W = 32, TILE_H = 63, ROOM_W = 10, ROOM_H = 3;
  var SLAB = 8;                 // thickness of the floor slab
  var FLOOR_OFF = TILE_H - SLAB; // 55: surface of the slab within its tile

  var T = {
    SPACE: 0, FLOOR: 1, WALL: 2, GATE: 3,
    PLATE_OPEN: 4, PLATE_SHUT: 5, LOOSE: 6, SPIKES: 7,
    POTION: 8, SWORD: 9, EXIT: 10, TORCH: 11, PILLAR: 12
  };

  var CHARMAP = {
    '.': T.SPACE, '=': T.FLOOR, '#': T.WALL, '|': T.GATE,
    'v': T.PLATE_OPEN, 'V': T.PLATE_SHUT, '~': T.LOOSE, '^': T.SPIKES,
    'o': T.POTION, 's': T.SWORD, 'E': T.EXIT, 't': T.TORCH, 'p': T.PILLAR
  };

  // tiles you can stand on
  var STANDABLE = {};
  [T.FLOOR, T.PLATE_OPEN, T.PLATE_SHUT, T.LOOSE, T.SPIKES,
    T.POTION, T.SWORD, T.EXIT, T.PILLAR].forEach(function (t) { STANDABLE[t] = 1; });

  /* ---- level 1 -------------------------------------------------------
   * Not a tile-for-tile copy of the original's twenty-four rooms, but the
   * same shape of journey: you start unarmed, the direct route is cut off,
   * you drop into the lower level to find the sword, climb back, and only
   * then meet the guard standing between you and the exit.
   */
  var LEVEL1 = {
    start: { room: 1, col: 1, row: 2, facing: 1 },
    rooms: {
      // 1 -- the cell you wake up in
      1: {
        map: ['..........',
              '.....t....',
              '=========='],
        links: { right: 2 }
      },
      // 2 -- the floor is out in the middle. A standing jump will not
      // clear two tiles; you have to be running.
      2: {
        map: ['..........',
              't.........',
              '====..===='],
        links: { left: 1, right: 3 }
      },
      // 3 -- loose slabs, then a spike trap
      3: {
        map: ['..........',
              '.........t',
              '==~~===^=='],
        links: { left: 2, right: 4 }
      },
      // 4 -- the floor steps up a storey, and the sword is waiting on the
      // ledge. Below the gap there is nothing at all.
      4: {
        map: ['........t.',
              '.....====s',
              '=====....#'],
        links: { left: 3, right: 5 }
      },
      // 5 -- a guard between you and the gate; the plate by the door opens it
      5: {
        map: ['..t.......',
              '=v=====|==',
              '##########'],
        links: { left: 4, right: 6 },
        guards: [{ col: 5, row: 1, facing: -1 }]
      },
      // 6 -- out
      6: {
        map: ['......t...',
              '=======E==',
              '##########'],
        links: { left: 5 }
      }
    }
  };

  function Level(def) {
    this.def = def;
    this.rooms = {};
    for (var id in def.rooms) {
      if (!def.rooms.hasOwnProperty(id)) continue;
      var r = def.rooms[id];
      var tiles = new Uint8Array(ROOM_W * ROOM_H);
      for (var row = 0; row < ROOM_H; row++) {
        var line = r.map[row] || '..........';
        for (var col = 0; col < ROOM_W; col++) {
          var ch = line[col] || '.';
          tiles[row * ROOM_W + col] = CHARMAP[ch] === undefined ? T.SPACE : CHARMAP[ch];
        }
      }
      this.rooms[id] = {
        id: +id, tiles: tiles, links: r.links || {},
        items: (r.items || []).map(function (i) { return { col: i.col, row: i.row, kind: i.kind, taken: false }; }),
        guards: r.guards || [],
        gatesOpen: false,
        loose: {}      // col*16+row -> shake/fall state
      };
    }
  }

  Level.prototype.room = function (id) { return this.rooms[id]; };

  Level.prototype.tile = function (roomId, col, row) {
    var r = this.rooms[roomId];
    if (!r) return T.WALL;
    if (col < 0 || col >= ROOM_W || row < 0 || row >= ROOM_H) return T.SPACE;
    return r.tiles[row * ROOM_W + col];
  };

  Level.prototype.setTile = function (roomId, col, row, t) {
    var r = this.rooms[roomId];
    if (!r || col < 0 || col >= ROOM_W || row < 0 || row >= ROOM_H) return;
    r.tiles[row * ROOM_W + col] = t;
  };

  Level.prototype.isFloor = function (roomId, col, row) {
    if (col < 0 || col >= ROOM_W) return false;
    var t = this.tile(roomId, col, row);
    if (t === T.GATE) return false;
    return !!STANDABLE[t] || t === T.WALL;
  };

  Level.prototype.isWall = function (roomId, col, row) {
    var t = this.tile(roomId, col, row);
    if (t === T.WALL) return true;
    if (t === T.GATE) return !this.rooms[roomId].gatesOpen;
    return false;
  };

  // can you catch a ledge on the tile at (col,row)? -- i.e. is its floor
  // solid and the space above it clear
  Level.prototype.canHang = function (roomId, col, row) {
    if (col < 0 || col >= ROOM_W || row < 0) return false;
    return this.isFloor(roomId, col, row) && !this.isWall(roomId, col, row);
  };

  /* ---- rendering ---------------------------------------------------- */

  // deterministic hash so the brickwork is stable across redraws
  function h2(a, b) {
    var n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) >>> 0) / 4294967296;
  }

  /* Running-bond masonry.
   *
   * All drawing here is in logical 320x200 units, but the framebuffer is
   * RES times denser, and fillRect scales on the way in. That means a
   * fractional logical coordinate addresses a single real pixel -- D below
   * is exactly one device pixel -- so the wall can carry mortar joints and
   * bevels a logical-resolution renderer simply has no room for.
   *
   * The back wall stays low-contrast so the character reads against it.
   */
  var D = 1 / (P.RES || 1);

  function brickWall(g, x0, y0, w, h, dim) {
    var bg = g.bg;
    g.fillRect(x0, y0, w, h, dim ? C.VOID : C.BRICK_S, bg);   // mortar
    var bh = 8, bw = 16;
    for (var y = y0 - (((y0 % bh) + bh) % bh) - bh; y < y0 + h; y += bh) {
      var rowIdx = Math.round(y / bh);
      var off = (rowIdx & 1) ? Math.floor(bw / 2) : 0;
      for (var x = x0 - (((x0 + off) % bw + bw) % bw) - bw; x < x0 + w; x += bw) {
        var bx = x + off, by = y;
        var r = h2(bx, by);
        var col, lip, low;
        if (dim) {
          col = r < 0.40 ? C.SHADOW : r < 0.82 ? C.BRICK_S : C.BRICK_D;
          lip = C.BRICK_S; low = C.VOID;
        } else {
          col = r < 0.34 ? C.BRICK_D : r < 0.72 ? C.BRICK_MD : C.BRICK_M;
          lip = C.BRICK_L; low = C.BRICK_S;
        }
        var px = Math.max(x0, bx + D), pw = Math.min(x0 + w, bx + bw - D) - px;
        var py = Math.max(y0, by + D), ph = Math.min(y0 + h, by + bh - D) - py;
        if (pw <= 0 || ph <= 0) continue;
        g.fillRect(px, py, pw, ph, col, bg);
        // one-device-pixel bevel: lit along the top, shaded along the bottom
        if (py > y0) g.fillRect(px, py, pw, D, lip, bg);
        if (py + ph < y0 + h) g.fillRect(px, py + ph - D, pw, D, low, bg);
        // a little weathering so the courses are not identical
        if (r > 0.90) g.fillRect(px + pw * 0.25, py + ph * 0.4, pw * 0.3, D, low, bg);
        else if (r < 0.08) g.fillRect(px + pw * 0.5, py + ph * 0.55, pw * 0.25, D, lip, bg);
      }
    }
  }

  /* Brighten a region of the background by walking each pixel one or more
   * steps up a fixed lightness chain. This is a palette trick, not a blend:
   * no new colours are invented, which is exactly the constraint an indexed
   * framebuffer imposes and why lighting in these games looks the way it
   * does. */
  var BRIGHTEN = new Uint8Array(64);
  (function () {
    for (var i = 0; i < 64; i++) BRIGHTEN[i] = i;
    var chain = [C.VOID, C.SHADOW, C.BRICK_S, C.BRICK_D, C.BRICK_MD,
                 C.BRICK_M, C.BRICK_L, C.BRICK_H, C.STONE_H, C.CREAM];
    for (var k = 0; k < chain.length - 1; k++) BRIGHTEN[chain[k]] = chain[k + 1];
    BRIGHTEN[C.CREAM] = C.CREAM;
  })();

  function glow(g, lcx, lcy, lrx, lry, strength) {
    var bg = g.bg, W = g.w, s = g.s;
    var cx = lcx * s, cy = lcy * s, rx = lrx * s, ry = lry * s;
    var y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(g.h - 1, Math.ceil(cy + ry));
    var x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(W - 1, Math.ceil(cx + rx));
    for (var y = y0; y <= y1; y++) {
      var dy = (y - cy) / ry;
      for (var x = x0; x <= x1; x++) {
        var dx = (x - cx) / rx;
        var d = dx * dx + dy * dy;
        if (d >= 1) continue;
        var steps = Math.round((1 - Math.sqrt(d)) * strength);
        var i = y * W + x, v = bg[i];
        for (var s = 0; s < steps; s++) v = BRIGHTEN[v];
        bg[i] = v;
      }
    }
  }

  function floorSlab(g, x0, y0) {
    var bg = g.bg;
    var top = y0 + FLOOR_OFF;
    // the walking surface, banded a device pixel at a time
    g.fillRect(x0, top, TILE_W, D, C.STONE_H, bg);
    g.fillRect(x0, top + D, TILE_W, D, C.BRICK_H, bg);
    g.fillRect(x0, top + 2 * D, TILE_W, 1, C.BRICK_L, bg);
    g.fillRect(x0, top + 1 + 2 * D, TILE_W, 2, C.BRICK_M, bg);
    g.fillRect(x0, top + 3 + 2 * D, TILE_W, SLAB - 3 - 2 * D, C.BRICK_D, bg);
    g.fillRect(x0, top + SLAB - D, TILE_W, D, C.SHADOW, bg);
    // course joints across the slab face
    for (var j = 0; j < 2; j++) {
      g.fillRect(x0 + j * 16, top + 2 * D, D, SLAB - 2 * D, C.BRICK_S, bg);
    }
    // dentils under the lip give the ledge its thickness -- the motif that
    // makes a floor read as a Prince of Persia floor
    for (var d = 0; d < 4; d++) {
      var dx = x0 + 2 + d * 8;
      g.fillRect(dx, top + SLAB, 5, 4, C.BRICK_S, bg);
      g.fillRect(dx, top + SLAB, 5, D, C.BRICK_MD, bg);
      g.fillRect(dx + 5 - D, top + SLAB, D, 4, C.VOID, bg);
      g.fillRect(dx, top + SLAB + 4 - D, 5, D, C.VOID, bg);
    }
    g.fillRect(x0, top + SLAB + 4, TILE_W, D, C.VOID, bg);
  }

  function drawTorchBracket(g, x0, y0) {
    var bg = g.bg;
    var cx = x0 + 16;
    g.fillRect(cx - 2, y0 + 26, 4, 9, C.BRACKET, bg);
    g.fillRect(cx - 2, y0 + 26, D, 9, C.RED_M, bg);
    g.fillRect(cx - 4, y0 + 24, 8, 2, C.BRICK_D, bg);
    g.fillRect(cx - 4, y0 + 24, 8, D, C.BRICK_M, bg);
    g.fillRect(cx - 1, y0 + 35, 2, 3, C.BRICK_S, bg);
  }

  /* Draw a whole room into the background plane. */
  Level.prototype.renderRoom = function (g, roomId) {
    var r = this.rooms[roomId];
    g.clearBg(C.VOID);
    if (!r) return;
    var col, row, t, x0, y0;

    // pass 1: the wall behind everything
    for (row = 0; row < ROOM_H; row++) {
      for (col = 0; col < ROOM_W; col++) {
        x0 = col * TILE_W; y0 = row * TILE_H;
        t = r.tiles[row * ROOM_W + col];
        if (t === T.WALL) brickWall(g, x0, y0, TILE_W, TILE_H, false);
        else brickWall(g, x0, y0, TILE_W, TILE_H, true);
      }
    }

    // pass 2: floors and furniture
    for (row = 0; row < ROOM_H; row++) {
      for (col = 0; col < ROOM_W; col++) {
        x0 = col * TILE_W; y0 = row * TILE_H;
        t = r.tiles[row * ROOM_W + col];
        var top = y0 + FLOOR_OFF;
        switch (t) {
          case T.FLOOR: case T.POTION: case T.SWORD:
            floorSlab(g, x0, y0); break;
          case T.PILLAR:
            floorSlab(g, x0, y0);
            g.fillRect(x0 + 12, y0 + 18, 8, FLOOR_OFF - 18, C.BRICK_MD, g.bg);
            g.fillRect(x0 + 10, y0 + 14, 12, 4, C.BRICK_M, g.bg);
            break;
          case T.LOOSE:
            floorSlab(g, x0, y0);
            // a cracked lip, so you can tell before you stand on it
            g.hline(x0 + 6, top, 5, C.BRICK_D, g.bg);
            g.hline(x0 + 18, top, 7, C.BRICK_D, g.bg);
            g.vline(x0 + 11, top, 4, C.SHADOW, g.bg);
            g.vline(x0 + 24, top, 3, C.SHADOW, g.bg);
            break;
          case T.PLATE_OPEN: case T.PLATE_SHUT:
            floorSlab(g, x0, y0);
            g.fillRect(x0 + 8, top - 2, 16, 2, t === T.PLATE_OPEN ? C.GOLD : C.STEEL_M, g.bg);
            g.hline(x0 + 7, top - 3, 18, C.BRICK_H, g.bg);
            break;
          case T.SPIKES:
            floorSlab(g, x0, y0);
            for (var s = 0; s < 4; s++) {
              var sx = x0 + 4 + s * 7;
              for (var k = 0; k < 7; k++) {
                g.hline(sx + k / 2, top - 8 + k, Math.max(1, 4 - k / 2), C.STEEL_L, g.bg);
              }
              g.vline(sx + 1, top - 8, 8, C.STEEL_D, g.bg);
            }
            break;
          case T.EXIT:
            glow(g, x0 + 16, y0 + 30, 54, 46, 3.4);
            floorSlab(g, x0, y0);
            // a lit doorway: the way out
            g.fillRect(x0 + 4, y0 + 8, 24, FLOOR_OFF - 8, C.SHADOW, g.bg);
            g.fillRect(x0 + 6, y0 + 12, 20, FLOOR_OFF - 12, C.BRICK_D, g.bg);
            g.fillRect(x0 + 9, y0 + 16, 14, FLOOR_OFF - 16, C.GOLD, g.bg);
            g.fillRect(x0 + 11, y0 + 20, 10, FLOOR_OFF - 20, C.HOT, g.bg);
            break;
          case T.GATE:
            floorSlab(g, x0, y0);
            break;
          case T.TORCH:
            glow(g, x0 + 16, y0 + 20, 46, 40, 3.2);
            drawTorchBracket(g, x0, y0);
            break;
          default: break;
        }
      }
    }
  };

  /* Things that move get drawn per frame, over the restored background. */
  Level.prototype.renderDynamic = function (g, roomId, t) {
    var r = this.rooms[roomId];
    if (!r) return;
    for (var row = 0; row < ROOM_H; row++) {
      for (var col = 0; col < ROOM_W; col++) {
        var tt = r.tiles[row * ROOM_W + col];
        var x0 = col * TILE_W, y0 = row * TILE_H;
        if (tt === T.TORCH) this.drawFlame(g, x0 + 16, y0 + 26, t + col * 7 + row * 13);
        else if (tt === T.GATE) this.drawGate(g, x0, y0, r.gatesOpen);
        else if (tt === T.POTION) this.drawPotion(g, x0, y0, t);
        else if (tt === T.SWORD) this.drawSword(g, x0, y0);
      }
    }
    // loose tiles mid-collapse
    for (var k in r.loose) {
      if (!r.loose.hasOwnProperty(k)) continue;
      var L = r.loose[k];
      if (L.state === 'shake') {
        var sx = (t % 2) ? 1 : -1;
        floorSlabLive(g, L.col * TILE_W + sx, L.row * TILE_H);
      } else if (L.state === 'fall') {
        floorSlabLive(g, L.col * TILE_W, L.row * TILE_H + L.dy);
      }
    }
  };

  function floorSlabLive(g, x0, y0) {
    var top = y0 + FLOOR_OFF;
    g.hline(x0, top, TILE_W, C.BRICK_H);
    g.hline(x0, top + 1, TILE_W, C.BRICK_L);
    g.fillRect(x0, top + 2, TILE_W, 3, C.BRICK_M);
    g.fillRect(x0, top + 5, TILE_W, SLAB - 5, C.BRICK_D);
  }

  Level.prototype.drawFlame = function (g, cx, cy, t) {
    // a stack of tapering bands with a travelling wobble: cheap, and it
    // reads as fire because the palette is doing the work
    var w1 = Math.sin(t * 0.7) * 1.1, w2 = Math.sin(t * 1.13 + 2) * 1.5;
    var w3 = Math.sin(t * 0.53 + 1) * 0.8;
    g.fillRect(cx - 3.2 + w3 * 0.3, cy - 5, 6.4, 6, C.RED_M);
    g.fillRect(cx - 2.6 + w1 * 0.4, cy - 9, 5.2, 5, C.FLAME);
    g.fillRect(cx - 1.8 + w1 * 0.8, cy - 12, 3.6, 4, C.FLAME);
    g.fillRect(cx - 1.1 + w2 * 0.7, cy - 15, 2.2, 4, C.FLAME);
    g.fillRect(cx - 2, cy - 4, 4, 4, C.GOLD);
    g.fillRect(cx - 1.4 + w1 * 0.5, cy - 8, 2.8, 5, C.GOLD);
    g.fillRect(cx - 0.8 + w2 * 0.6, cy - 11, 1.6, 3, C.GOLD);
    g.fillRect(cx - 1.2, cy - 3.5, 2.4, 3, C.HOT);
    g.fillRect(cx - 0.6 + w1 * 0.4, cy - 6, 1.2, 3, C.HOT);
  };

  Level.prototype.drawGate = function (g, x0, y0, open) {
    var top = y0 + 2;
    var height = open ? 8 : FLOOR_OFF - 2;
    // frame
    g.fillRect(x0 + 2, y0, TILE_W - 4, 3, C.BRICK_M);
    for (var b = 0; b < 5; b++) {
      var bx = x0 + 4 + b * 6;
      g.fillRect(bx, top, 2, height, C.STEEL_M);
      g.vline(bx, top, height, C.STEEL_L);
    }
    // cross-bar at the bottom of the travelling section
    g.fillRect(x0 + 3, top + height - 3, TILE_W - 6, 3, C.STEEL_D);
  };

  Level.prototype.drawPotion = function (g, x0, y0, t) {
    var bx = x0 + 14, by = y0 + FLOOR_OFF - 11;
    g.fillRect(bx, by + 3, 5, 8, C.GREEN_D);
    g.fillRect(bx + 1, by + 4, 3, 6, C.RED_M);
    g.fillRect(bx + 1, by, 3, 4, C.GREEN_D);
    g.fillRect(bx + 1, by - 1, 3, 1, C.STEEL_M);
    if ((t >> 2) % 4 === 0) g.px(bx + 1, by + 5, C.HOT);
  };

  Level.prototype.drawSword = function (g, x0, y0) {
    var sx = x0 + 6, sy = y0 + FLOOR_OFF - 3;
    g.fillRect(sx, sy, 20, 2, C.STEEL_L);
    g.fillRect(sx + 19, sy - 1, 3, 4, C.STEEL_M);
    g.fillRect(sx - 2, sy - 1, 3, 4, C.GOLD);
  };

  P.T = T;
  P.Level = Level;
  P.LEVEL1 = LEVEL1;
  P.LEVEL_GEO = { TILE_W: TILE_W, TILE_H: TILE_H, ROOM_W: ROOM_W, ROOM_H: ROOM_H, SLAB: SLAB, FLOOR_OFF: FLOOR_OFF };
})(POP);
