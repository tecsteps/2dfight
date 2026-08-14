/*
 * frames.js -- the baked frame table.
 *
 * Mirrors the original FRAMEDEF: a flat, numbered list of frames, each one
 * carrying a body image and (separately) a sword image. Sequences address
 * frames by number, so the sequence interpreter never knows what a clip is.
 *
 * Everything here runs once, at boot. Afterwards the game only blits.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  // Order matters only in that it fixes the frame numbering; sequences are
  // resolved through CLIP_BASE so the numbers stay an implementation detail.
  var CLIP_ORDER = [
    'stand', 'alertstand', 'startrun', 'runcyc', 'runstop', 'turn',
    'standjump', 'runjump', 'jumpup', 'hang', 'hangstraight', 'hangdrop',
    'climbup', 'freefall', 'softland', 'hardland', 'crouch', 'step',
    'bump', 'drink',
    'engarde', 'ready', 'advance', 'retreat', 'strike', 'block',
    'stabbed', 'dead'
  ];

  /* Build the whole frame table for one wardrobe. Returns
   * { frames:[{img, sword}], base:{clip->firstIndex}, count:{clip->n} } */
  function buildFrameTable(skinName) {
    var sk = P.SKINS[skinName];
    var frames = [];
    var base = {};
    var count = {};

    for (var ci = 0; ci < CLIP_ORDER.length; ci++) {
      var name = CLIP_ORDER[ci];
      var clip = P.CLIPS[name];
      if (!clip) continue;
      var poses = P.expandClip(clip);
      base[name] = frames.length;
      count[name] = poses.length;
      for (var i = 0; i < poses.length; i++) {
        var pose = poses[i];
        var body = P.Rig.bakePose(pose, sk, {});
        // sword angle: authored where it matters, otherwise follow the
        // forearm so an armed prince carries the blade naturally
        var ang = null;
        if (clip.sword && clip.sword.length) {
          ang = clip.sword[Math.min(i, clip.sword.length - 1)];
          if (ang === undefined) ang = null;
        }
        if (ang === null || ang === undefined) ang = pose[7];
        var sword = P.Rig.bakeSword(pose, ang);
        frames.push({ img: body, sword: sword });
      }
    }
    return { frames: frames, base: base, count: count };
  }

  /* A colour table that turns the prince's bitmaps into a guard's. The
   * original halved its sprite budget by mirroring frames; this is the same
   * instinct applied to palette instead of geometry. */
  function buildWardrobeMap(from, to) {
    var m = new Uint8Array(64);
    for (var i = 0; i < 64; i++) m[i] = i;
    var keys = ['clothD', 'clothM', 'clothL', 'clothH',
                'skinD', 'skinM', 'skinL', 'hair', 'hair2',
                'sashD', 'sashM', 'bootD', 'bootM'];
    for (var k = 0; k < keys.length; k++) {
      var a = from[keys[k]], b = to[keys[k]];
      if (a && b) m[a] = b;
    }
    return m;
  }

  /* The sequence table addresses frames by number, a holdover from the
   * original's FRAMEDEF. Nothing is baked any more, but the assembler still
   * needs each clip's length to resolve those slots, so hand it the clip
   * lengths alone -- no bitmaps, no bake, no memory. */
  function nominalFrameTable() {
    var base = {}, count = {}, n = 0;
    for (var i = 0; i < CLIP_ORDER.length; i++) {
      var name = CLIP_ORDER[i], clip = P.CLIPS[name];
      if (!clip) continue;
      var len = clip.frames ? clip.frames.length : clip.n;
      base[name] = n; count[name] = len; n += len;
    }
    return { frames: [], base: base, count: count };
  }

  P.nominalFrameTable = nominalFrameTable;
  P.buildFrameTable = buildFrameTable;
  P.buildWardrobeMap = buildWardrobeMap;
  P.CLIP_ORDER = CLIP_ORDER;
})(POP);
