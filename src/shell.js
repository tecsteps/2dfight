/*
 * shell.js -- page wiring: canvas scaling, keyboard, touch.
 *
 * The framebuffer is always 320x200. Scaling to the viewport is left to the
 * one thing a browser does that is genuinely equivalent to what we want --
 * nearest-neighbour upscale of an integer bitmap. No smoothing, ever: on a
 * phone this fills the width and the pixels get bigger, which is the point.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  function boot(opts) {
    opts = opts || {};
    var canvas = document.getElementById('screen');
    var game = new P.Game(canvas);
    P.game = game;

    /* ---- keyboard --------------------------------------------------- */
    var KEYS = {
      ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
      KeyA: 'left', KeyD: 'right', KeyW: 'up', KeyS: 'down',
      ShiftLeft: 'shift', ShiftRight: 'shift'
    };
    window.addEventListener('keydown', function (e) {
      if (e.code === 'KeyM') { game.audio.mute(game.audio.on); return; }
      if (e.code === 'KeyP') { game.paused = !game.paused; return; }
      if (e.code === 'KeyR') { game.restart(); game.userTookOver(); return; }
      var k = KEYS[e.code];
      if (!k) return;
      e.preventDefault();
      game.setInput(k, 1);
    }, { passive: false });
    window.addEventListener('keyup', function (e) {
      var k = KEYS[e.code];
      if (!k) return;
      e.preventDefault();
      game.input[k] = 0;
    }, { passive: false });

    /* ---- touch ------------------------------------------------------
     * Buttons are real DOM elements rather than hit-tested canvas regions,
     * so they get native touch handling and stay usable with a thumb.
     */
    var pad = document.getElementById('pad');
    if (pad) {
      var held = {};
      function bind(el, key) {
        function down(e) { e.preventDefault(); held[key] = 1; game.setInput(key, 1); el.classList.add('on'); }
        function up(e) { e.preventDefault(); held[key] = 0; game.input[key] = 0; el.classList.remove('on'); }
        el.addEventListener('touchstart', down, { passive: false });
        el.addEventListener('touchend', up, { passive: false });
        el.addEventListener('touchcancel', up, { passive: false });
        el.addEventListener('mousedown', down);
        el.addEventListener('mouseup', up);
        el.addEventListener('mouseleave', up);
      }
      var btns = pad.querySelectorAll('[data-key]');
      for (var i = 0; i < btns.length; i++) bind(btns[i], btns[i].getAttribute('data-key'));
    }

    // any tap on the screen also counts as taking over
    canvas.addEventListener('pointerdown', function () { game.userTookOver(); });

    /* ---- fit --------------------------------------------------------
     * Integer-ish scale to the viewport. The canvas stays 320x200; CSS
     * blows it up with image-rendering: pixelated, so one game pixel
     * becomes a crisp square block instead of a blurry smear.
     */
    function fit() {
      var wrap = document.getElementById('wrap');
      var padEl = document.getElementById('pad');
      var availW = window.innerWidth;
      var padH = padEl ? padEl.offsetHeight : 0;
      var availH = window.innerHeight - padH;
      var scale = Math.min(availW / 320, availH / 200);
      // prefer whole-number scales when there is room; a fractional scale
      // on a small phone is better than wasting a third of the screen
      if (scale >= 2) scale = Math.floor(scale);
      var w = Math.round(320 * scale), h = Math.round(200 * scale);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      if (wrap) wrap.style.height = h + 'px';
    }
    window.addEventListener('resize', fit);
    window.addEventListener('orientationchange', function () { setTimeout(fit, 120); });
    fit();

    function loop(now) { game.frame(now); requestAnimationFrame(loop); }
    requestAnimationFrame(loop);

    return game;
  }

  P.boot = boot;
})(POP);
