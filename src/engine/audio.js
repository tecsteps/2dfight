/*
 * audio.js -- a tiny synth for the tap opcodes.
 *
 * The sequence table fires `tap,N` on specific frames -- footfalls, the
 * landing thump, blade on blade. Those cues are part of the animation, so
 * they are worth having even in rough form. Everything here is oscillators
 * and envelopes; there are no samples to load.
 *
 * Nothing starts until the first user gesture, per browser autoplay rules.
 */
var POP = POP || {};
(function (P) {
  'use strict';

  function Audio() {
    this.ctx = null;
    this.on = true;
    this.ready = false;
  }

  Audio.prototype.enable = function () {
    if (this.ready) { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); return; }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.ctx.destination);
      this.ready = true;
    } catch (e) { /* no audio, no problem */ }
  };

  Audio.prototype.mute = function (m) {
    this.on = !m;
    if (this.master) this.master.gain.value = m ? 0 : 0.22;
  };

  Audio.prototype.tone = function (type, f0, f1, dur, vol) {
    if (!this.ready || !this.on) return;
    var c = this.ctx, t = c.currentTime;
    var o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  };

  Audio.prototype.noise = function (dur, vol, f) {
    if (!this.ready || !this.on) return;
    var c = this.ctx, t = c.currentTime;
    var n = Math.floor(c.sampleRate * dur);
    var buf = c.createBuffer(1, n, c.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = c.createBufferSource(); s.buffer = buf;
    var bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f || 900;
    var g = c.createGain(); g.gain.value = vol;
    s.connect(bp); bp.connect(g); g.connect(this.master);
    s.start(t);
  };

  /* tap ids as used in the sequence table */
  Audio.prototype.play = function (id, audible) {
    if (!this.ready || !this.on || !audible) return;
    switch (id) {
      case 0: this.noise(0.09, 0.5, 380); break;             // land
      case 1: this.noise(0.045, 0.22, 1500); break;          // footstep
      case 2: this.noise(0.05, 0.2, 700); break;             // grab ledge
      case 3: this.tone('square', 200, 420, 0.09, 0.16); break; // jump
      case 4: this.noise(0.14, 0.55, 260); break;            // heavy land
      case 5: this.noise(0.25, 0.7, 160); break;             // bad land
      case 6: this.noise(0.07, 0.35, 300); break;            // bump
      case 7: this.tone('sawtooth', 900, 300, 0.08, 0.1); break; // swing
      case 8: this.tone('square', 2100, 900, 0.16, 0.16);        // parry
        this.tone('square', 3100, 1400, 0.11, 0.09); break;
      case 9: this.tone('sawtooth', 300, 90, 0.3, 0.2); break;   // hit
      case 10: this.tone('triangle', 660, 990, 0.16, 0.16);      // pickup
        this.tone('triangle', 990, 1320, 0.16, 0.12); break;
      case 11: this.tone('sine', 400, 300, 0.05, 0.05); break;   // whiff
      case 12: this.noise(0.3, 0.5, 200); break;                 // slab falls
      default: break;
    }
  };

  P.Audio = Audio;
})(POP);
