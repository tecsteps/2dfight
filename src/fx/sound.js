/*
 * sound.js -- impact synthesis. No samples; every cue is oscillators and
 * shaped noise, which is all a punch really is: a transient plus a body.
 */
var FX = FX || {};
(function (F) {
  'use strict';
  function Sound() { this.ctx = null; this.on = true; }
  Sound.prototype.enable = function () {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.g = this.ctx.createGain(); this.g.gain.value = 0.3;
      this.comp = this.ctx.createDynamicsCompressor();
      this.g.connect(this.comp); this.comp.connect(this.ctx.destination);
    } catch (e) { this.ctx = null; }
  };
  Sound.prototype.noise = function (dur, vol, f, q, sweep) {
    if (!this.ctx || !this.on) return;
    var c = this.ctx, t = c.currentTime, n = Math.max(1, (c.sampleRate * dur) | 0);
    var buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2);
    var s = c.createBufferSource(); s.buffer = buf;
    var bp = c.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f, t); bp.Q.value = q || 1.2;
    if (sweep) bp.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), t + dur);
    var g = c.createGain(); g.gain.value = vol;
    s.connect(bp); bp.connect(g); g.connect(this.g); s.start(t);
  };
  Sound.prototype.tone = function (type, f0, f1, dur, vol) {
    if (!this.ctx || !this.on) return;
    var c = this.ctx, t = c.currentTime;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.g); o.start(t); o.stop(t + dur + 0.02);
  };
  Sound.prototype.play = function (k) {
    switch (k) {
      case 'hit':   this.noise(0.10, 0.7, 900, 1.0, 200); this.tone('square', 190, 70, 0.09, 0.16); break;
      case 'heavy': this.noise(0.20, 0.9, 520, 0.9, 90);  this.tone('sawtooth', 130, 44, 0.20, 0.24); break;
      case 'block': this.noise(0.07, 0.5, 2600, 3.0, 1400); this.tone('square', 900, 500, 0.05, 0.07); break;
      case 'grab':  this.noise(0.10, 0.4, 400, 1.0, 180); break;
      case 'super': this.noise(0.5, 0.85, 300, 0.7, 60);
        this.tone('sawtooth', 90, 900, 0.32, 0.2); this.tone('square', 1400, 180, 0.5, 0.12); break;
      case 'ko':    this.noise(0.7, 0.9, 240, 0.6, 50); this.tone('sawtooth', 200, 36, 0.8, 0.28); break;
      default: break;
    }
  };
  F.Sound = Sound;
})(FX);
