/*
 * seq.js -- the sequence table, ported in structure from SEQTABLE.S.
 *
 * This is the single most important idea in Prince of Persia and the reason
 * it moves the way it does. There is no velocity variable and no gravity
 * integrator for anything happening on the ground. A character is a program
 * counter walking a byte stream. The stream says "show this frame, and move
 * 5 pixels", then "show this frame, and move 1 pixel". Displacement is a
 * property of the drawing, baked in by whoever traced it.
 *
 * The real run cycle is:
 *     runcyc1 db 7,chx,5      runcyc5 db 11,chx,5
 *     runcyc2 db 8,chx,1      runcyc6 db 12,chx,2
 *     runcyc3 db tap,1,9,chx,2 runcyc7 db tap,1,13,chx,3
 *     runcyc4 db 10,chx,4     runcyc8 db 14,chx,4
 * -- 26 pixels per eight frames, and those exact numbers are used below.
 *
 * Opcode numbering follows the original's negative-constant convention.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  // instructions, exactly the set from the top of SEQTABLE.S
  var OP = {
    GOTO: -1, ABOUTFACE: -2, UP: -3, DOWN: -4, CHX: -5, CHY: -6,
    ACT: -7, SETFALL: -8, IFWTLESS: -9, DIE: -10, JARU: -11, JARD: -12,
    EFFECT: -13, TAP: -14, NEXTLEVEL: -15
  };

  // action states, as the original used them for collision decisions
  var ACT = {
    STAND: 0, RUN: 1, HANG: 2, INAIR: 3, FREEFALL: 4,
    DEAD: 5, HANGSTRAIGHT: 6, TURN: 7
  };

  /* ---- authoring helpers -------------------------------------------
   * Each returns a token list. `F` puts the chx/chy ahead of the frame so
   * that "this frame carries this much movement" reads the way the data
   * actually means it.
   */
  function F(clip, i, chx, chy) {
    var t = [];
    if (chx) t.push(OP.CHX, chx);
    if (chy) t.push(OP.CHY, chy);
    t.push(['F', clip, i]);
    return t;
  }
  function ACTION(n) { return [OP.ACT, n]; }
  function GOTO(l) { return [OP.GOTO, ['L', l]]; }
  function JUMPTO(seqName) { return [OP.GOTO, ['S', seqName]]; }
  function LABEL(l) { return [['LABEL', l]]; }
  function ABOUTFACE() { return [OP.ABOUTFACE]; }
  function JARD() { return [OP.JARD]; }
  function JARU() { return [OP.JARU]; }
  function TAP(n) { return [OP.TAP, n]; }
  function SETFALL(vx, vy) { return [OP.SETFALL, vx, vy]; }
  function UP() { return [OP.UP]; }
  function DOWN() { return [OP.DOWN]; }
  function DIE() { return [OP.DIE]; }
  function CHX(n) { return [OP.CHX, n]; }
  function CHY(n) { return [OP.CHY, n]; }
  function EFFECT(n) { return [OP.EFFECT, n]; }

  /* Run a whole clip through, one frame per tick, with an optional
   * per-frame chx list. Saves writing out fourteen near-identical lines. */
  function CLIP(clip, n, dxs, dys) {
    var t = [];
    for (var i = 0; i < n; i++) {
      t = t.concat(F(clip, i, dxs ? (dxs[i] || 0) : 0, dys ? (dys[i] || 0) : 0));
    }
    return t;
  }

  function cat() {
    var out = [];
    for (var i = 0; i < arguments.length; i++) out = out.concat(arguments[i]);
    return out;
  }

  /* ---- the table ----------------------------------------------------
   * Sequence names and structure mirror the original's list.
   */
  var SEQ = {

    stand: cat(ACTION(ACT.STAND), LABEL('s'), F('stand', 0), GOTO('s')),

    alertstand: cat(ACTION(ACT.STAND), LABEL('s'), F('alertstand', 0), GOTO('s')),

    // startrun's chx values are the original's: 0,0,0,8,3,3
    startrun: cat(
      ACTION(ACT.RUN),
      F('startrun', 0), F('startrun', 1), F('startrun', 2),
      F('startrun', 3, 9), F('startrun', 4, 4), F('startrun', 5, 4),
      JUMPTO('runcyc')
    ),

    // the real thing: 5,1,2,4,5,2,3,4
    runcyc: cat(
      ACTION(ACT.RUN),
      LABEL('c'),
      F('runcyc', 0, 6), F('runcyc', 1, 1),
      cat(TAP(1), F('runcyc', 2, 3)), F('runcyc', 3, 5),
      F('runcyc', 4, 6), F('runcyc', 5, 2),
      cat(TAP(1), F('runcyc', 6, 4)), F('runcyc', 7, 5),
      GOTO('c')
    ),

    // runstop db 53,chx,2 / tap,1,54,chx,7 / 55 / tap,1,56,chx,2 / 49,chx,-2
    runstop: cat(
      ACTION(ACT.RUN),
      F('runstop', 0, 2),
      cat(TAP(1), F('runstop', 1, 8)),
      F('runstop', 2),
      cat(TAP(1), F('runstop', 3, 2)),
      JUMPTO('stand')
    ),

    // turn: aboutface happens first, then the recovery frames play in the
    // new facing. chx,6 compensates for the body pivoting about its axis.
    turn: cat(
      ACTION(ACT.TURN),
      ABOUTFACE(), CHX(6),
      F('turn', 0, 1), F('turn', 1, 2), F('turn', 2, -1),
      F('turn', 3, 1), F('turn', 4, -2),
      F('turn', 5), F('turn', 6), F('turn', 7),
      JUMPTO('stand')
    ),

    // turnrun: turn while running, drops straight back into the run cycle
    turnrun: cat(
      ACTION(ACT.RUN),
      ABOUTFACE(), CHX(4),
      F('turn', 2, -1), F('turn', 3, 1), F('turn', 4), F('turn', 5),
      JUMPTO('startrun')
    ),

    /* standing jump. The original:
     *   16 / 17..21 chx,2 each / 22 chx,7 / 23 chx,9 / 24 chx,5 chy,-6
     *   25 chx,1 chy,6 / 26 chx,4 / jard / 27 chx,-3 / 28 chx,5 / 29..33
     * Total forward travel and the whole arc live in these numbers. */
    standjump: cat(
      ACTION(ACT.RUN),
      F('standjump', 0),
      ACTION(ACT.INAIR),
      F('standjump', 1, 2), F('standjump', 2, 2), F('standjump', 3, 2),
      F('standjump', 4, 2), F('standjump', 5, 2),
      cat(TAP(3), F('standjump', 6, 8)),
      F('standjump', 7, 10),
      F('standjump', 8, 6, -6),
      F('standjump', 9, 1, 6),
      F('standjump', 10, 5),
      JARD(),
      ACTION(ACT.RUN),
      cat(TAP(0), F('standjump', 11, -3)),
      F('standjump', 12, 6), F('standjump', 13), F('standjump', 14),
      F('standjump', 15), F('standjump', 16), F('standjump', 17, 1),
      JUMPTO('stand')
    ),

    /* running jump. The original:
     *   34 chx,5 / 35 chx,6 / 36 chx,3 / 37 chx,5 / 38 chx,7
     *   39 chx,12 chy,-3 / 40 chx,8 chy,-9 / 41 chx,8 chy,-2
     *   42 chx,4 chy,11 / 43 chx,4 chy,3 / 44 chx,5 / jard
     * Nine tiles of travel, and every pixel of the arc is authored. */
    runjump: cat(
      ACTION(ACT.INAIR),
      cat(TAP(1), F('runjump', 0, 6)),
      F('runjump', 1, 7), F('runjump', 2, 3), F('runjump', 3, 6),
      cat(TAP(3), F('runjump', 4, 8)),
      F('runjump', 5, 14, -3),
      F('runjump', 6, 9, -9),
      F('runjump', 7, 9, -2),
      F('runjump', 8, 5, 11),
      F('runjump', 9, 5, 3),
      ACTION(ACT.RUN),
      cat(TAP(0), F('runjump', 10, 6)),
      JARD(),
      JUMPTO('runcyc')
    ),

    // jumpup: spring straight up to catch a ledge. jaru does the catching.
    jumpup: cat(
      ACTION(ACT.RUN),
      F('jumpup', 0), F('jumpup', 1),
      ACTION(ACT.INAIR),
      cat(TAP(3), F('jumpup', 2, 0, -4)),
      F('jumpup', 3, 0, -10),
      JARU(),
      F('jumpup', 4, 0, -6),
      F('jumpup', 5, 0, 6),
      F('jumpup', 6, 0, 10),
      ACTION(ACT.RUN),
      cat(TAP(0), F('jumpup', 7, 0, 4)),
      F('jumpup', 8),
      JUMPTO('stand')
    ),

    // hangs on the ledge; the loop eventually gives out into hangdrop, the
    // way the original's forty-frame swing does
    hang: cat(
      ACTION(ACT.HANG),
      LABEL('h'),
      CLIP('hang', 12),
      CLIP('hang', 12),
      CLIP('hang', 12),
      JUMPTO('hangdrop')
    ),
    hangstraight: cat(
      ACTION(ACT.HANGSTRAIGHT),
      cat(TAP(2), F('hangstraight', 0)),
      LABEL('h'), F('hangstraight', 0), GOTO('h')
    ),

    // hangdrop: let go and take the half-storey
    hangdrop: cat(
      ACTION(ACT.STAND),
      F('hangdrop', 0), F('hangdrop', 1),
      F('hangdrop', 2),
      JARD(),
      cat(TAP(0), F('hangdrop', 3)),
      F('hangdrop', 4), F('hangdrop', 5, 3),
      JUMPTO('stand')
    ),

    // hangfall: the ledge wasn't there. setfall,0,12 then freefall.
    hangfall: cat(
      ACTION(ACT.INAIR),
      F('hangdrop', 0, 0, 6),
      F('hangdrop', 0, 0, 9),
      F('hangdrop', 0, 0, 12),
      CHX(2),
      SETFALL(0, 12),
      JUMPTO('freefall')
    ),

    /* climbup. Mid-sequence the original does chx,5 / chy,-63 / up --
     * it relocates the character a whole tile upward and switches rooms
     * while the animation is still playing. Frames after that point were
     * drawn against the upper floor. */
    climbup: cat(
      ACTION(ACT.RUN),
      F('climbup', 0), F('climbup', 1), F('climbup', 2),
      F('climbup', 3), F('climbup', 4), F('climbup', 5),
      CHX(21), CHY(-63), UP(),
      ACTION(ACT.DEAD),   // "to clr flags", per the original's comment
      F('climbup', 6), F('climbup', 7), F('climbup', 8),
      F('climbup', 9), F('climbup', 10), F('climbup', 11),
      ACTION(ACT.RUN),
      F('climbup', 12), F('climbup', 13), F('climbup', 14, 1),
      JUMPTO('stand')
    ),

    freefall: cat(
      ACTION(ACT.FREEFALL),
      LABEL('f'),
      CLIP('freefall', 4),
      GOTO('f')
    ),

    softland: cat(
      ACTION(ACT.RUN),
      cat(TAP(0), F('softland', 0)),
      F('softland', 1), F('softland', 2), F('softland', 3),
      JUMPTO('stand')
    ),
    medland: cat(
      ACTION(ACT.RUN),
      cat(TAP(4), F('hardland', 0)),
      F('hardland', 2), F('hardland', 4), F('hardland', 6), F('hardland', 7),
      JUMPTO('stand')
    ),
    hardland: cat(
      ACTION(ACT.DEAD),
      cat(TAP(5), F('hardland', 0)),
      CLIP('hardland', 8),
      DIE()
    ),

    stepfall: cat(
      ACTION(ACT.INAIR),
      F('standjump', 9, 1, 6),
      SETFALL(0, 6),
      JUMPTO('freefall')
    ),

    crouch: cat(ACTION(ACT.STAND), LABEL('c'), F('crouch', 0), GOTO('c')),

    // a single full step -- the original had fourteen of these at graduated
    // lengths so you could inch up to a ledge exactly
    step: cat(
      ACTION(ACT.RUN),
      F('step', 0), F('step', 1, 2), F('step', 2, 3), F('step', 3, 3),
      F('step', 4, 2), F('step', 5, 2), F('step', 6, 1), F('step', 7),
      JUMPTO('stand')
    ),
    stepsmall: cat(
      ACTION(ACT.RUN),
      F('step', 0), F('step', 2, 2), F('step', 4, 2), F('step', 7),
      JUMPTO('stand')
    ),

    bump: cat(
      ACTION(ACT.RUN),
      cat(TAP(6), F('bump', 0, -1)),
      F('bump', 1, -2), F('bump', 2, -1), F('bump', 3), F('bump', 4),
      JUMPTO('stand')
    ),

    drink: cat(
      ACTION(ACT.STAND),
      CLIP('drink', 10),
      EFFECT(1),
      JUMPTO('stand')
    ),

    /* ---- swordplay --------------------------------------------------
     * engarde -> ready is the original's structure; strike/advance/retreat
     * all return to ready, so the fight is a little state machine driven
     * entirely by which sequence gets selected next.
     */
    engarde: cat(
      ACTION(ACT.RUN),
      CHX(2),
      F('engarde', 0), F('engarde', 1, 2), F('engarde', 2, 2),
      F('engarde', 3, 3), F('engarde', 4),
      JUMPTO('ready')
    ),
    ready: cat(
      ACTION(ACT.RUN),
      LABEL('r'),
      CLIP('ready', 4),
      GOTO('r')
    ),
    advance: cat(
      ACTION(ACT.RUN),
      F('advance', 0, 3), F('advance', 1, 4), F('advance', 2, 3), F('advance', 3, 2),
      JUMPTO('ready')
    ),
    retreat: cat(
      ACTION(ACT.RUN),
      F('retreat', 0, -3), F('retreat', 1, -4), F('retreat', 2, -3), F('retreat', 3, -2),
      JUMPTO('ready')
    ),
    strike: cat(
      ACTION(ACT.RUN),
      cat(TAP(7), F('strike', 0, 2)),
      F('strike', 1, 4),
      EFFECT(2),                 // the frame the blade is actually out
      F('strike', 2, 2),
      F('strike', 3, -4),
      JUMPTO('ready')
    ),
    block: cat(
      ACTION(ACT.RUN),
      cat(TAP(8), F('block', 0)),
      F('block', 1), F('block', 2),
      JUMPTO('ready')
    ),
    stabbed: cat(
      ACTION(ACT.DEAD),
      SETFALL(-1, 0),
      cat(TAP(9), F('stabbed', 0, -1, 1)),
      F('stabbed', 1, -1),
      F('stabbed', 2, -1, 2),
      F('stabbed', 3, -2, 1),
      F('stabbed', 4, -3),
      F('stabbed', 5, -2),
      JUMPTO('dead')
    ),
    dead: cat(
      ACTION(ACT.DEAD),
      CLIP('dead', 5),
      LABEL('d'), F('dead', 4), GOTO('d')
    )
  };

  /* ---- assembler -----------------------------------------------------
   * Flattens the token lists into one Int16Array, resolving frame
   * references through the baked frame table and patching label/sequence
   * addresses. The runtime then walks a flat stream of numbers, which is
   * what the 6502 original was doing all along.
   */
  function assemble(frameTable) {
    var code = [];
    var owner = [];        // address -> which sequence that word belongs to
    var seqStart = {};
    var labelAddr = {};   // "seqName/label" -> address
    var fixups = [];

    for (var name in SEQ) {
      if (!SEQ.hasOwnProperty(name)) continue;
      seqStart[name] = code.length;
      var ownerStart = code.length;
      var toks = SEQ[name];
      for (var i = 0; i < toks.length; i++) {
        var t = toks[i];
        if (Array.isArray(t)) {
          if (t[0] === 'F') {
            var b = frameTable.base[t[1]];
            if (b === undefined) throw new Error('unknown clip ' + t[1]);
            var n = frameTable.count[t[1]];
            var idx = Math.min(t[2], n - 1);
            code.push(b + idx + 1); // +1 so frame 0 is never confused with a pad
          } else if (t[0] === 'LABEL') {
            labelAddr[name + '/' + t[1]] = code.length;
          } else if (t[0] === 'L') {
            fixups.push({ at: code.length, key: name + '/' + t[1] });
            code.push(0);
          } else if (t[0] === 'S') {
            fixups.push({ at: code.length, seq: t[1] });
            code.push(0);
          }
        } else {
          code.push(t);
        }
      }
      // every word this sequence emitted is tagged with its name, so a
      // fall-through into another sequence updates seqName correctly
      while (owner.length < code.length) owner.push(name);
      void ownerStart;
    }

    for (var f = 0; f < fixups.length; f++) {
      var fx = fixups[f];
      var addr = fx.seq !== undefined ? seqStart[fx.seq] : labelAddr[fx.key];
      if (addr === undefined) throw new Error('unresolved ' + (fx.seq || fx.key));
      code[fx.at] = addr;
    }

    return { code: new Int16Array(code), start: seqStart, owner: owner };
  }

  P.OP = OP;
  P.ACT = ACT;
  P.SEQ = SEQ;
  P.assembleSeq = assemble;
})(POP);
