/*
 * poses.js -- the pose library, and the clips built out of it.
 *
 * These stand in for the rotoscope. Where the original traced VHS frames of
 * David Mechner running around a parking lot in white clothes, this is the
 * same motion described as joint angles and hand-tuned until the silhouette
 * reads right. Frame counts and timing are taken from the real SEQTABLE.S,
 * so the *rhythm* is the original's even though the drawings are ours.
 *
 * A clip is either an explicit frame list or a set of keys interpolated out
 * to a frame count. Interpolation here is authoring convenience only -- by
 * the time the game runs, every frame is a finished bitmap.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  /* pose: hipX hipY torso head | farSh farEl nearSh nearEl
   *       | farHip farKnee farFoot | nearHip nearKnee nearFoot | xscale */
  function pz(hx, hy, t, hd, fs, fe, ns, ne, fh, fk, ff, nh, nk, nf, xs) {
    return [hx, hy, t, hd, fs, fe, ns, ne, fh, fk, ff, nh, nk, nf,
      xs === undefined ? 1 : xs];
  }

  function lerp(a, b, u) {
    var o = new Array(15);
    for (var i = 0; i < 15; i++) o[i] = a[i] + (b[i] - a[i]) * u;
    return o;
  }

  /* ---- individual poses --------------------------------------------- */

  var STAND = pz(0, 27, -88, -90, 95, 98, 87, 92, 88, 90, 5, 93, 91, 2);
  var STAND_A = pz(0, 26, -85, -88, 100, 112, 80, 84, 86, 92, 5, 96, 94, 2);

  /* Eight-frame run cycle, 32 pixels -- one tile.
   *
   * The stance leg is not hand-authored: it is solved by two-link IK against
   * the chx values in seq.js so the planted foot holds a fixed world
   * position. That is what stops the character skating, and it is what
   * rotoscoping gave the original for free -- a traced foot that really was
   * planted cannot slip. Regenerate with `node tools/mkrun.mjs`.
   *
   * The swing leg and the arms are authored; nothing constrains them.
   * Frames 4-7 are 0-3 with the legs and arms swapped, which also swaps
   * which leg gets the lit shade -- they read as alternating in front, free.
   */
var RUN = [
    pz(0, 26, -72, -78, 80, -25, 112, 125, 112, 128, -26, 52.8, 94.5, 14),
    pz(0, 24.5, -70, -78, 88, -8, 106, 118, 116, 150, -34, 46.2, 106.3, 2),
    pz(0, 25, -70, -80, 98, 25, 98, 100, 100, 148, -30, 55.4, 117.4, -14),
    pz(0, 27, -73, -80, 108, 70, 88, 40, 80, 120, -12, 82.2, 120.5, -40),
    pz(0, 26, -72, -78, 112, 125, 80, -25, 52.6, 87.5, 14, 112, 128, -26),
    pz(0, 24.5, -70, -78, 106, 118, 88, -8, 45.9, 105.3, 2, 116, 150, -34),
    pz(0, 25, -70, -80, 98, 100, 98, 25, 57.7, 120.4, -14, 100, 148, -30),
    pz(0, 27, -73, -80, 88, 40, 108, 70, 85.9, 121.4, -40, 80, 120, -12)
  ];

  var CROUCH = pz(0, 15, -58, -74, 60, 80, 52, 74, 96, 138, 0, 104, 142, 4);
  var CROUCH_DEEP = pz(0, 12, -50, -70, 70, 95, 62, 88, 100, 148, 2, 108, 152, 6);

  /* ---- clip table ---------------------------------------------------
   * `frames` = literal poses. `keys` = [frameIndex, pose] pairs, everything
   * between them interpolated. `n` = total frames when using keys.
   */
  var CLIPS = {

    stand: { frames: [STAND] },
    alertstand: { frames: [STAND_A] },
    runcyc: { frames: RUN },

    // startrun: six frames from a standing start into the cycle.
    // chx in the real table is 0,0,0,8,3,3 -- the lunge is on frame 4.
    startrun: {
      frames: [
        pz(0, 26, -84, -88, 92, 98, 86, 92, 88, 94, 5, 92, 92, 2),
        pz(0, 25, -80, -85, 102, 118, 76, 66, 94, 104, 2, 86, 96, 6),
        pz(0, 24, -76, -82, 116, 152, 62, 32, 104, 118, -8, 78, 92, 6),
        pz(0, 24, -72, -80, 130, 186, 50, 10, 112, 134, -24, 70, 88, 5),
        pz(0, 25, -71, -79, 138, 192, 46, 6, 116, 140, -28, 68, 88, 5),
        pz(0, 26, -72, -78, 46, 6, 134, 190, 113, 126, -22, 68, 88, 5)
      ]
    },

    // runstop: skid. Weight goes back, front foot planted and braced.
    runstop: {
      frames: [
        pz(0, 25, -80, -84, 60, 30, 118, 170, 100, 120, -10, 74, 90, 12),
        pz(-2, 22, -96, -92, 30, -10, 140, 190, 108, 130, 0, 58, 78, 20),
        pz(-3, 21, -100, -95, 20, -25, 148, 200, 112, 126, 4, 55, 74, 22),
        pz(-2, 23, -96, -92, 40, 5, 130, 180, 104, 116, 6, 64, 82, 14)
      ]
    },

    // turn: `aboutface` fires first, so these frames play already facing the
    // new way -- the figure resolves out of an edge-on pivot. The x-squash
    // is doing the work a set of three-quarter drawings would have done.
    turn: {
      frames: [
        pz(0, 25, -88, -90, 92, 100, 90, 96, 90, 94, 3, 92, 93, 2, 0.34),
        pz(0, 25, -88, -90, 94, 102, 88, 95, 90, 93, 3, 92, 92, 2, 0.50),
        pz(0, 26, -88, -90, 95, 101, 88, 94, 89, 92, 4, 93, 92, 2, 0.66),
        pz(0, 26, -88, -90, 95, 100, 87, 93, 89, 91, 4, 93, 91, 2, 0.79),
        pz(0, 27, -88, -90, 95, 99, 87, 92, 88, 90, 5, 93, 91, 2, 0.88),
        pz(0, 27, -88, -90, 95, 98, 87, 92, 88, 90, 5, 93, 91, 2, 0.94),
        pz(0, 27, -88, -90, 95, 98, 87, 92, 88, 90, 5, 93, 91, 2, 0.98),
        STAND
      ]
    },

    // standing jump: 18 frames. Crouch, uncoil, tuck, reach, land, recover.
    standjump: {
      n: 18,
      keys: [
        [0, pz(0, 25, -80, -86, 100, 118, 82, 96, 92, 104, 2, 96, 106, 2)],
        [3, pz(0, 20, -68, -80, 126, 172, 108, 150, 98, 128, 0, 102, 132, 2)],
        [5, CROUCH_DEEP],
        [6, pz(0, 18, -60, -76, 148, 204, 132, 196, 100, 146, 0, 106, 150, 4)],
        [7, pz(0, 25, -70, -80, 78, 26, 62, 14, 96, 112, -8, 100, 116, -4)],
        [8, pz(0, 31, -76, -84, 24, -28, 10, -40, 108, 128, -38, 114, 136, -34)],
        [9, pz(0, 35, -82, -88, 2, -42, -8, -52, 74, 122, -22, 84, 130, -18)],
        [10, pz(0, 33, -80, -86, 22, -16, 12, -26, 60, 82, 10, 70, 88, 6)],
        [11, pz(0, 28, -78, -84, 40, 10, 32, 4, 70, 86, 6, 80, 90, 3)],
        [12, pz(0, 19, -62, -76, 58, 78, 50, 72, 92, 134, 0, 100, 140, 4)],
        [13, pz(0, 22, -70, -80, 70, 92, 62, 86, 92, 118, 2, 98, 122, 3)],
        [15, pz(0, 25, -80, -85, 86, 96, 78, 90, 90, 100, 4, 94, 102, 3)],
        [17, STAND]
      ]
    },

    // running jump: 11 frames, the long one. chy goes -3,-9,-2 then +11,+3,
    // so the arc is entirely in the data -- no gravity involved.
    runjump: {
      n: 11,
      keys: [
        [0, RUN[2]],
        [1, pz(0, 26, -68, -78, 92, 60, 96, 140, 92, 160, -50, 100, 100, 8)],
        [2, pz(0, 25, -64, -76, 120, 150, 70, 30, 78, 140, -30, 112, 116, -4)],
        [3, pz(0, 23, -60, -74, 140, 190, 44, 0, 62, 96, 4, 122, 140, -30)],
        [4, pz(0, 28, -66, -78, 150, 200, 20, -30, 74, 84, 8, 132, 152, -40)],
        [5, pz(0, 33, -74, -84, 130, 186, -2, -48, 96, 96, 4, 138, 160, -44)],
        [6, pz(0, 36, -80, -88, 100, 150, -14, -56, 116, 118, -14, 120, 156, -40)],
        [7, pz(0, 35, -80, -88, 70, 106, 4, -36, 100, 108, -6, 86, 138, -22)],
        [8, pz(0, 31, -78, -86, 46, 52, 30, -6, 76, 88, 8, 66, 100, 2)],
        [9, pz(0, 25, -70, -80, 58, 72, 52, 40, 88, 116, 2, 78, 96, 6)],
        [10, pz(0, 26, -72, -78, 46, 8, 132, 186, 110, 124, -20, 70, 90, 5)]
      ]
    },

    // jumpup: vertical spring to catch a ledge overhead.
    jumpup: {
      n: 9,
      keys: [
        [0, pz(0, 24, -80, -86, 102, 120, 84, 98, 92, 108, 2, 96, 110, 2)],
        [2, CROUCH_DEEP],
        [3, pz(0, 22, -74, -82, 40, -10, 30, -20, 96, 130, -2, 102, 134, 2)],
        [4, pz(0, 32, -86, -92, -60, -84, -66, -86, 100, 130, -20, 106, 136, -16)],
        [5, pz(0, 38, -88, -92, -80, -88, -82, -88, 92, 118, -10, 98, 122, -8)],
        [6, pz(0, 36, -88, -92, -82, -88, -84, -88, 90, 108, -4, 94, 110, -2)],
        [7, pz(0, 28, -82, -88, 60, 80, 54, 76, 92, 122, 0, 98, 126, 2)],
        [8, STAND]
      ]
    },

    // hang: hands on the ledge one row up, feet swinging near the floor
    // below. The cycle in the real table swings back and forth for 40-odd
    // frames before it gives out; we keep a short loop of the same motion.
    hang: {
      n: 12,
      keys: [
        [0, pz(0, 46.9, -88, -84, -86, -89, -88, -89, 84, 96, 20, 90, 100, 16)],
        [3, pz(0, 45.4, -86, -82, -86, -89, -88, -89, 74, 88, 26, 80, 92, 22)],
        [6, pz(0, 46.9, -88, -84, -86, -89, -88, -89, 88, 98, 18, 94, 102, 14)],
        [9, pz(0, 45.4, -90, -86, -86, -89, -88, -89, 100, 110, 8, 106, 114, 6)],
        [11, pz(0, 46.9, -88, -84, -86, -89, -88, -89, 86, 97, 19, 92, 101, 15)]
      ]
    },
    hangstraight: {
      frames: [pz(0, 46.9, -89, -86, -87, -89, -88, -89, 90, 96, 14, 95, 99, 12)]
    },

    // hangdrop: let go, absorb the half-storey.
    hangdrop: {
      n: 6,
      keys: [
        [0, pz(0, 46.9, -88, -84, -74, -84, -78, -85, 92, 104, 10, 98, 108, 8)],
        [1, pz(0, 41.2, -86, -84, -30, -50, -36, -54, 96, 118, 4, 102, 122, 4)],
        [2, pz(0, 31.2, -74, -80, 30, 20, 24, 14, 98, 132, 0, 104, 136, 2)],
        [3, CROUCH],
        [5, STAND]
      ]
    },

    // climbup: 15 frames. Halfway through, the real sequence does
    // `chx,5 / chy,-63 / up` -- it teleports the character one row up and
    // switches rooms mid-animation. Frames after that point are authored
    // against the upper floor, which is why they start in a heap.
    climbup: {
      n: 15,
      keys: [
        [0, pz(0, 46.9, -88, -84, -86, -89, -88, -89, 88, 98, 18, 94, 102, 14)],
        [2, pz(0, 52.5, -86, -80, -82, -112, -84, -110, 84, 104, 16, 90, 108, 12)],
        [4, pz(0, 59.6, -84, -76, -78, -130, -80, -128, 80, 112, 12, 86, 116, 10)],
        [5, pz(0, 65.3, -82, -74, -76, -142, -78, -140, 76, 120, 8, 82, 124, 6)],
        // --- chy,-63: everything below is relative to the upper floor ---
        [6, pz(-2, 9, -34, -56, 44, 96, 38, 92, 108, 158, 8, 114, 160, 10)],
        [8, pz(-1, 12, -44, -62, 52, 92, 46, 88, 104, 152, 6, 110, 154, 8)],
        [10, pz(0, 16, -56, -70, 62, 88, 56, 84, 98, 142, 4, 106, 146, 6)],
        [12, pz(0, 21, -70, -80, 76, 92, 70, 88, 94, 116, 2, 100, 120, 4)],
        [14, STAND]
      ]
    },

    freefall: {
      n: 4,
      keys: [
        [0, pz(0, 27, -84, -80, -40, -70, -50, -76, 74, 108, -10, 108, 130, -18)],
        [2, pz(0, 27, -92, -96, -30, -62, -58, -84, 96, 130, -20, 88, 112, -6)],
        [3, pz(0, 27, -86, -84, -44, -72, -46, -74, 80, 116, -14, 102, 124, -14)]
      ]
    },

    softland: {
      n: 4,
      keys: [
        [0, pz(0, 21, -66, -78, 54, 66, 46, 60, 94, 132, 0, 100, 136, 4)],
        [1, CROUCH],
        [3, STAND]
      ]
    },
    hardland: {
      n: 8,
      keys: [
        [0, pz(0, 14, -46, -66, 84, 118, 78, 114, 102, 152, 2, 110, 156, 6)],
        [1, pz(0, 11, -38, -60, 92, 128, 86, 124, 104, 158, 4, 112, 162, 8)],
        [4, CROUCH_DEEP],
        [6, CROUCH],
        [7, STAND]
      ]
    },

    crouch: { frames: [CROUCH] },

    // a single walking step, used for the fourteen step-lengths the real
    // game had for lining up exactly with a ledge.
    step: {
      n: 8,
      keys: [
        [0, STAND],
        [1, pz(0, 26, -84, -88, 100, 112, 80, 86, 84, 92, 6, 98, 96, 2)],
        [3, pz(0, 25, -80, -86, 112, 132, 68, 60, 74, 88, 10, 108, 110, -4)],
        [5, pz(0, 25, -82, -86, 104, 120, 76, 74, 80, 90, 8, 102, 102, 0)],
        [7, STAND]
      ]
    },

    bump: {
      n: 5,
      keys: [
        [0, pz(0, 25, -96, -94, 40, 8, 34, 2, 94, 100, 2, 88, 96, 4)],
        [1, pz(-2, 24, -102, -98, 30, -6, 24, -12, 98, 106, 0, 84, 94, 6)],
        [3, pz(-1, 26, -92, -92, 60, 40, 54, 34, 92, 96, 4, 90, 94, 3)],
        [4, STAND]
      ]
    },

    drink: {
      n: 10,
      keys: [
        [0, STAND],
        [2, pz(0, 26, -86, -88, 92, 96, 40, -30, 88, 92, 4, 93, 92, 2)],
        [4, pz(0, 26, -88, -96, 92, 96, 10, -70, 88, 92, 4, 93, 92, 2)],
        [7, pz(0, 26, -90, -104, 92, 96, 4, -82, 88, 92, 4, 93, 92, 2)],
        [9, STAND]
      ]
    },

    /* ---- swordplay -------------------------------------------------- */

    engarde: {
      n: 5,
      keys: [
        [0, STAND],
        [2, pz(0, 26, -84, -88, 110, 140, 60, 30, 86, 94, 6, 96, 98, 2)],
        [4, pz(0, 25, -84, -88, 128, 172, 22, -4, 78, 96, 6, 104, 104, 0)]
      ],
      sword: [null, -40, -20, -8, -4]
    },
    ready: {
      n: 4,
      keys: [
        [0, pz(0, 25, -84, -88, 130, 176, 20, -6, 76, 96, 6, 106, 106, 0)],
        [2, pz(0, 24, -83, -88, 132, 178, 24, -2, 78, 98, 6, 104, 104, 0)],
        [3, pz(0, 25, -84, -88, 130, 176, 21, -5, 76, 96, 6, 106, 106, 0)]
      ],
      sword: [-4, -2, 0, -3]
    },
    advance: {
      n: 4,
      keys: [
        [0, pz(0, 25, -84, -88, 130, 176, 20, -6, 76, 96, 6, 106, 106, 0)],
        [1, pz(0, 24, -80, -86, 134, 180, 16, -10, 66, 92, 10, 110, 112, -4)],
        [2, pz(0, 24, -82, -87, 132, 178, 18, -8, 70, 94, 8, 100, 100, 2)],
        [3, pz(0, 25, -84, -88, 130, 176, 20, -6, 76, 96, 6, 106, 106, 0)]
      ],
      sword: [-4, -6, -5, -4]
    },
    retreat: {
      n: 4,
      keys: [
        [0, pz(0, 25, -84, -88, 130, 176, 20, -6, 76, 96, 6, 106, 106, 0)],
        [1, pz(0, 24, -88, -90, 126, 172, 26, 0, 86, 100, 4, 96, 100, 2)],
        [2, pz(0, 24, -86, -89, 128, 174, 24, -2, 92, 104, 2, 88, 96, 4)],
        [3, pz(0, 25, -84, -88, 130, 176, 20, -6, 76, 96, 6, 106, 106, 0)]
      ],
      sword: [-4, -8, -6, -4]
    },
    // strike: the lunge. Front leg drives out, sword arm extends level.
    strike: {
      n: 4,
      keys: [
        [0, pz(0, 25, -82, -88, 132, 178, 34, 10, 78, 98, 6, 104, 104, 0)],
        [1, pz(2, 22, -74, -86, 146, 196, 8, -2, 58, 78, 12, 118, 122, -6)],
        [2, pz(4, 20, -70, -84, 152, 202, 2, 0, 48, 66, 16, 126, 130, -10)],
        [3, pz(1, 23, -78, -87, 140, 188, 16, -4, 66, 86, 10, 112, 114, -2)]
      ],
      sword: [-14, -4, 0, -6]
    },
    block: {
      n: 3,
      keys: [
        [0, pz(0, 25, -84, -88, 128, 172, 10, -34, 78, 96, 6, 104, 104, 0)],
        [1, pz(0, 25, -86, -90, 126, 168, -6, -54, 82, 98, 4, 100, 102, 0)],
        [2, pz(0, 25, -85, -89, 127, 170, 2, -44, 80, 97, 5, 102, 103, 0)]
      ],
      sword: [-56, -74, -66]
    },
    stabbed: {
      n: 6,
      keys: [
        [0, pz(0, 25, -92, -94, 118, 150, 40, 20, 88, 100, 4, 96, 100, 2)],
        [1, pz(-2, 24, -100, -100, 100, 120, 66, 60, 96, 112, 0, 86, 96, 6)],
        [3, pz(-4, 23, -108, -106, 80, 96, 88, 92, 104, 124, -4, 78, 90, 10)],
        [5, pz(-6, 22, -112, -110, 70, 84, 96, 104, 110, 132, -8, 72, 86, 12)]
      ],
      sword: [-20, -40, -70, -90]
    },
    dead: {
      n: 5,
      keys: [
        [0, pz(-6, 20, -120, -116, 66, 78, 100, 110, 114, 138, -10, 68, 82, 14)],
        [2, pz(-8, 12, -150, -140, 40, 40, 130, 140, 130, 150, -20, 50, 70, 20)],
        [4, pz(-10, 4, -172, -168, 14, 10, 160, 168, 152, 166, -30, 30, 52, 26)]
      ],
      sword: [null, null, null, null, null]
    }
  };

  /* Expand keys into frames. */
  function expand(clip) {
    if (clip.frames) return clip.frames;
    var keys = clip.keys, n = clip.n, out = new Array(n);
    for (var f = 0; f < n; f++) {
      var a = keys[0], b = keys[keys.length - 1];
      for (var i = 0; i < keys.length - 1; i++) {
        if (f >= keys[i][0] && f <= keys[i + 1][0]) { a = keys[i]; b = keys[i + 1]; break; }
      }
      if (f <= keys[0][0]) { out[f] = keys[0][1]; continue; }
      if (f >= keys[keys.length - 1][0]) { out[f] = keys[keys.length - 1][1]; continue; }
      var span = b[0] - a[0];
      var u = span === 0 ? 0 : (f - a[0]) / span;
      // smoothstep: keeps interpolated in-betweens from looking mechanical
      u = u * u * (3 - 2 * u);
      out[f] = lerp(a[1], b[1], u);
    }
    return out;
  }

  P.CLIPS = CLIPS;
  P.expandClip = expand;
  P.pz = pz;
})(POP);
