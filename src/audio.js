/*
 * audio.js — everything you hear, synthesised.
 *
 * No sample files: the whole soundscape is built from noise buffers and
 * oscillators through the Web Audio graph, so the simulator stays a single
 * self-contained page that works off the filesystem.
 *
 * The river is a continuous bed of filtered noise whose weight and brightness
 * come from the beat you are fishing. Everything else is a one-shot fired by
 * something that actually happened in the physics — a fly breaking the surface,
 * a bead knocking the stones, line tearing through water with a fish on.
 *
 * There is deliberately no sound for a take. You cannot hear a trout eat a
 * nymph, and on the blind beats the sighter has to remain the only witness.
 */
(function (EN) {
  'use strict';

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function Audio() {
    this.ctx = null;
    this.enabled = false;
    this.ready = false;
    this.master = null;
    this.lastTick = 0;
    this.zip = null;
  }

  /** One reusable noise buffer; every effect filters a slice of it. */
  Audio.prototype._noise = function (seconds, brown) {
    var ctx = this.ctx;
    var len = Math.floor(ctx.sampleRate * seconds);
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = buf.getChannelData(0);
    var last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.03 * w) / 1.03;
        d[i] = clamp(last * 4.2, -1, 1);
      } else {
        d[i] = w;
      }
    }
    return buf;
  };

  Audio.prototype.init = function () {
    if (this.ctx) return true;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    try {
      this.ctx = new Ctx();
    } catch (e) { return false; }

    var ctx = this.ctx;
    this.white = this._noise(3, false);
    this.brown = this._noise(3, true);

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    // --- the river itself ---------------------------------------------------
    // Two layers: a body of low, rolling water and a brighter hiss of broken
    // surface. Their balance is what makes a riffle sound unlike a tailout.
    this.bodySrc = ctx.createBufferSource();
    this.bodySrc.buffer = this.brown;
    this.bodySrc.loop = true;
    this.bodyFilter = ctx.createBiquadFilter();
    this.bodyFilter.type = 'lowpass';
    this.bodyFilter.frequency.value = 420;
    this.bodyGain = ctx.createGain();
    this.bodyGain.gain.value = 0.5;
    this.bodySrc.connect(this.bodyFilter).connect(this.bodyGain).connect(this.master);

    this.hissSrc = ctx.createBufferSource();
    this.hissSrc.buffer = this.white;
    this.hissSrc.loop = true;
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'bandpass';
    this.hissFilter.frequency.value = 1600;
    this.hissFilter.Q.value = 0.6;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.05;
    this.hissSrc.connect(this.hissFilter).connect(this.hissGain).connect(this.master);

    // Slow drift in the band so the loop never sits still under the ear.
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0.11;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 240;
    this.lfo.connect(this.lfoGain).connect(this.hissFilter.frequency);

    try {
      this.bodySrc.start(0);
      this.hissSrc.start(0);
      this.lfo.start(0);
    } catch (e) { /* already started */ }

    this.ready = true;
    return true;
  };

  Audio.prototype.resume = function () {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(function () {});
  };

  Audio.prototype.setEnabled = function (on) {
    this.enabled = !!on;
    if (on && !this.init()) { this.enabled = false; return; }
    if (!this.ctx) return;
    this.resume();
    var t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.enabled ? 0.85 : 0, t, 0.15);
  };

  /** The beat decides how the water sounds. */
  Audio.prototype.setRiver = function (preset) {
    if (!this.ready) return;
    var t = this.ctx.currentTime;
    var flow = preset.flow || 0.8;
    var turb = preset.turbulence || 0.1;
    var foam = preset.foam ? 1 : 0;

    var body = 0.28 + flow * 0.30;
    var hiss = 0.012 + turb * 0.22 + foam * 0.06;
    var cut = 260 + flow * 320;

    this.bodyGain.gain.setTargetAtTime(body, t, 0.6);
    this.hissGain.gain.setTargetAtTime(hiss, t, 0.6);
    this.bodyFilter.frequency.setTargetAtTime(cut, t, 0.6);
    this.hissFilter.frequency.setTargetAtTime(900 + flow * 1400, t, 0.6);
  };

  /**
   * A filtered burst of noise. Nearly every one-shot here is one of these with
   * a different envelope and band.
   */
  Audio.prototype._burst = function (o) {
    if (!this.enabled || !this.ready) return;
    var ctx = this.ctx;
    var t = ctx.currentTime;
    var src = ctx.createBufferSource();
    src.buffer = o.brown ? this.brown : this.white;
    src.loop = true;
    src.playbackRate.value = o.rate || 1;

    var f = ctx.createBiquadFilter();
    f.type = o.type || 'bandpass';
    f.frequency.setValueAtTime(o.from, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, o.to), t + o.dur);
    f.Q.value = o.q || 1;

    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain, t + (o.attack || 0.006));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + o.dur + 0.05);
  };

  Audio.prototype._tone = function (freq, endFreq, dur, gain, type) {
    if (!this.enabled || !this.ready) return;
    var ctx = this.ctx;
    var t = ctx.currentTime;
    var o = ctx.createOscillator();
    o.type = type || 'sine';
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    var g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  };

  /** Flies breaking the surface: a bright splash over a falling bloop. */
  Audio.prototype.splash = function (strength) {
    var s = clamp(strength || 0.5, 0.1, 1);
    this._burst({ from: 2600, to: 500, dur: 0.16 + s * 0.14, gain: 0.10 * s, q: 0.8 });
    this._tone(320 + s * 180, 120, 0.10 + s * 0.08, 0.05 * s);
  };

  /** A tungsten bead knocking a stone. This is the sound of fishing deep. */
  Audio.prototype.tick = function (strength) {
    var now = (this.ctx && this.ctx.currentTime) || 0;
    if (now - this.lastTick < 0.09) return;      // one knock, not a buzz
    this.lastTick = now;
    var s = clamp(strength || 0.5, 0.15, 1);
    this._burst({ from: 2400, to: 900, dur: 0.035, gain: 0.06 * s, q: 2.4, attack: 0.002 });
  };

  /** Rod sweeping — line and leader cutting air. */
  Audio.prototype.whoosh = function (strength) {
    var s = clamp(strength || 0.5, 0.15, 1);
    this._burst({ from: 500, to: 1700, dur: 0.20, gain: 0.055 * s, q: 0.7, attack: 0.05 });
  };

  Audio.prototype.hook = function () {
    this._burst({ from: 900, to: 2600, dur: 0.13, gain: 0.09, q: 0.9, attack: 0.004 });
    this._tone(180, 90, 0.14, 0.045);
  };

  /** Tippet parting: a dry snap, then nothing. */
  Audio.prototype.snap = function () {
    this._burst({ from: 4200, to: 1200, dur: 0.06, gain: 0.16, q: 1.6, attack: 0.001 });
    this._tone(900, 200, 0.05, 0.05, 'square');
  };

  Audio.prototype.thrash = function () {
    this._burst({ from: 1800, to: 400, dur: 0.28, gain: 0.11, q: 0.7 });
    this._tone(240, 110, 0.16, 0.04);
  };

  Audio.prototype.landed = function () {
    this._burst({ from: 1400, to: 350, dur: 0.35, gain: 0.10, q: 0.6 });
    this._tone(210, 95, 0.22, 0.045);
  };

  /**
   * Line tearing through water while a fish is on. Held open for the length of
   * the fight and driven by tippet load, so you hear the rod loading up.
   */
  Audio.prototype.setFight = function (tension) {
    if (!this.ready) return;
    var ctx = this.ctx;
    if (tension === null) {
      if (this.zip) {
        this.zip.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.12);
        var z = this.zip;
        this.zip = null;
        setTimeout(function () { try { z.src.stop(); } catch (e) {} }, 500);
      }
      return;
    }
    if (!this.zip) {
      var src = ctx.createBufferSource();
      src.buffer = this.white;
      src.loop = true;
      var f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1200;
      f.Q.value = 1.4;
      var g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master);
      src.start(0);
      this.zip = { src: src, filter: f, gain: g };
    }
    var t = ctx.currentTime;
    var s = clamp(tension, 0, 1.6);
    this.zip.gain.gain.setTargetAtTime(0.008 + s * 0.055, t, 0.08);
    this.zip.filter.frequency.setTargetAtTime(700 + s * 1500, t, 0.10);
  };

  EN.Audio = Audio;
})(window.EN = window.EN || {});
